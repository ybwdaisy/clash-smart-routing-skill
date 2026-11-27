'use strict';
// Internal, explicit client-test guard. Import/install alone never launches it.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const context=require('./proxy-context.cjs'),router=require('./clash-router.cjs'),life=require('./flclash-lifecycle.cjs'),native=require('./clash-app-client.cjs'),service=require('./verge-service.cjs');
const engine=require('./proxy-cutover.cjs'),mac=require('./proxy-cutover-macos.cjs'),{Budget,monotonicMs}=require('./proxy-deadline.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const terminal=engine.terminal;
function write(file,value){router.writePrivate(file,JSON.stringify(value,null,2)+'\n')}
function read(dir){return JSON.parse(fs.readFileSync(path.join(dir,'journal.json'),'utf8'))}
function privateDir(dir){const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('Guard directory must be private and owned');}
function request(dir,name,value){privateDir(dir);fs.writeFileSync(path.join(dir,name),JSON.stringify(value),{mode:0o600,flag:'wx'});}
function report(j){return {phase:j.phase,token:j.token,startedAt:j.startedAt,deadline:j.deadline,elapsedMs:j.elapsedMs,ok:j.result?.ok,error:j.error,attempts:j.attempts,guardPid:j.guardPid};}
async function capture({target,prepared=false}){
 if(process.platform!=='darwin')throw Error('Protected switching currently supports macOS');
 if(!prepared)throw Error('Complete and validate target UI/compatibility setup before capture');
 const workers=context.read('runtime.json')?.workers||{},settings=context.settings();if(settings.recoveryEnabled||settings.learningEnabled||Object.values(workers).some(w=>w?.pid))throw Error('Quiesce only the managed recovery/learning workers before arming; preserve their settings for restoration');
 const selection=router.activeSelection();if(selection.status!=='active'||selection.client!=='verge')throw Error('Capture a uniquely running, working Verge before staging another App');
 if(!['flclash','clash-app'].includes(target))throw Error('Choose flclash or clash-app');
 const ctx=router.load(selection.root),api=router.controller(ctx,{followActive:true,timeoutMs:1000}),live=await api('GET','/configs');
 const port=Number(live['mixed-port']);if(!Number.isInteger(port)||port<1||ctx.config['mixed-port']!==port)throw Error('Saved/runtime mixed port mismatch');
 const saved=path.join(ctx.root,'verge.yaml');if(fs.existsSync(saved)){const prefs=require('yaml').parse(fs.readFileSync(saved,'utf8'));if(prefs.verge_mixed_port&&prefs.verge_mixed_port!==port)throw Error('Verge is avoiding the saved port; repair ownership before switching');}
 const config=JSON.parse(JSON.stringify(ctx.config));config.tun={...config.tun,enable:live.tun?.enable};
 const compatibilityPorts=[...new Set((config.listeners||[]).filter(x=>x.type==='mixed'&&x.listen==='127.0.0.1').map(x=>Number(x.port)).filter(p=>p!==port))];
 for(const p of [port,...compatibilityPorts])if(!await service.verifyListener(p,api))throw Error('Fallback listener ownership not verified');
 const proxies=(await api('GET','/proxies')).proxies,selections={};for(const [name,p]of Object.entries(proxies)){if(p.type==='Selector')selections[name]=p.now;if(p.type==='URLTest')selections[name]=p.fixed||null;}
 const snapshot=service.socketPath(),transport=snapshot?{socketPath:snapshot,secret:config.secret||''}:config['external-controller-unix']?{socketPath:config['external-controller-unix'],secret:config.secret||''}:{url:'http://'+config['external-controller'].replace(/^0\.0\.0\.0:/,'127.0.0.1:'),secret:config.secret||''};
 const budget=new Budget(monotonicMs()+60000),network=[];
 await budget.step('capture network',async step=>{
  const services=(await mac.command('/usr/sbin/networksetup',['-listallnetworkservices'],step)).split('\n').slice(1).filter(x=>x&&!x.startsWith('*'));
  for(const name of services){const kinds=[];for(const kind of ['web','secureweb','socksfirewall']){const s=await mac.command('/usr/sbin/networksetup',['-get'+kind+'proxy',name],step);if(/^Enabled: Yes/m.test(s)&&/^Server: 127\.0\.0\.1$/m.test(s)&&new RegExp('^Port: '+port+'$','m').test(s))kinds.push(kind)}if(kinds.length){const bypass=(await mac.command('/usr/sbin/networksetup',['-getproxybypassdomains',name],step)).trim().split('\n');network.push({name,kinds,bypass:bypass[0].startsWith("There aren't")?[]:bypass})}}
 });budget.close();
 let destination;
 if(target==='clash-app'){const n=native.load(native.root()),vpn=native.vpnStatus();if(vpn.status!=='Disconnected')throw Error('Native target VPN is already active');destination={client:target,app:n.native.app,root:n.root,transport:{url:n.native.controller,secret:n.native.secret},vpnId:vpn.id,processes:[]};}
 else{const root=path.join(os.homedir(),'Library/Application Support/com.follow.clash'),f=require('./flclash-client.cjs').load(root);destination={client:target,app:'/Applications/FlClash.app',root,transport:{url:'http://'+f.native.preferences.patchClashConfig['external-controller'],secret:f.native.preferences.patchClashConfig.secret},config:f.config,processes:[]};if(Number(f.native.preferences.patchClashConfig['mixed-port'])!==port)throw Error('Target mixed port differs');}
 const rows=life.rows(),fallbackProcesses=rows.filter(p=>p.exe===selection.app+'/Contents/MacOS/clash-verge'||p.exe===service.CORE||p.exe===selection.app+'/Contents/MacOS/verge-mihomo');
 const plan={version:1,port,compatibilityPorts,uiPrepared:true,compatibilityVerified:true,fallback:{client:'verge',root:ctx.root,app:selection.app,transport,config,selections,network,processes:fallbackProcesses},target:destination,capturedAt:new Date().toISOString()};
 engine.validate(plan);
 const ops=mac.create(plan),proofBudget=new Budget(monotonicMs()+5000);const proof=await proofBudget.step('baseline public proof',step=>ops.verifyFallback(plan,step),4500);proofBudget.close();if(!proof.ok)throw Error('Baseline public/compatibility check failed');
 const dir=context.file('cutovers/'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'));fs.mkdirSync(dir,{recursive:true,mode:0o700});write(dir+'/plan.json',plan);write(dir+'/journal.json',{version:1,phase:'prepared',token:crypto.randomBytes(16).toString('hex'),preparedAt:monotonicMs(),label:'io.github.clash-smart-routing.cutover-'+path.basename(dir)});
 return {directory:dir,phase:'prepared',port,compatibilityPorts};
}
async function arm(dir){
 privateDir(dir);const j=read(dir);if(j.phase!=='prepared')throw Error('Only a prepared guard can be armed');engine.validate(JSON.parse(fs.readFileSync(dir+'/plan.json','utf8')));
 await assertBaseline(JSON.parse(fs.readFileSync(dir+'/plan.json','utf8')));
 const esc=x=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;');const plist=path.join(os.homedir(),'Library/LaunchAgents',j.label+'.plist');
 router.writePrivate(plist,'<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>'+esc(j.label)+'</string><key>ProgramArguments</key><array>'+[process.execPath,fs.realpathSync(__filename),'watch',dir].map(x=>'<string>'+esc(x)+'</string>').join('')+'</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>1</integer><key>StandardErrorPath</key><string>'+esc(dir+'/worker-error.log')+'</string></dict></plist>');
 const result=cp.spawnSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),plist],{encoding:'utf8',timeout:3000,env:context.cleanEnv()});if(result.status!==0)throw Error('Independent guard did not start');
 for(let i=0;i<40;i++){const next=read(dir);if(next.phase==='armed'&&next.guardPid)return report(next);await pause(100)}throw Error('Guard did not acknowledge readiness');
}
async function start(dir,token){
 const j=read(dir);if(j.token!==token||j.phase!=='armed')throw Error('Guard token revoked or not armed');
 await assertBaseline(JSON.parse(fs.readFileSync(dir+'/plan.json','utf8')));
 request(dir,'start.json',{token,startedAt:monotonicMs()});
 for(let i=0;i<20;i++){const s=read(dir);if(s.phase!=='armed')return report(s);await pause(50)}throw Error('Guard start not acknowledged; do not quit any client');
}
async function assertBaseline(plan){
 const rows=life.rows(),recorded=plan.fallback.processes||[];
 if(!recorded.length||!recorded.every(p=>rows.some(row=>life.sameIdentity(p,row))))throw Error('Captured Verge process changed; recapture while it works');
 const settings=context.settings();if(settings.recoveryEnabled||settings.learningEnabled)throw Error('Managed workers resumed; do not begin cutover');
 const budget=new Budget(monotonicMs()+3000);try{await budget.step('recheck unchanged baseline',async step=>{const cfg=await mac.rawApi(plan.fallback.transport,'GET','/configs',undefined,step);if(cfg['mixed-port']!==plan.port)throw Error('Baseline port changed; do not quit any client')})}finally{budget.close()}
}
async function watch(dir,{create=mac.create,now=monotonicMs,sleep=pause}={}){
 privateDir(dir);let j=read(dir);if(terminal.has(j.phase))return report(j);
 const plan=JSON.parse(fs.readFileSync(dir+'/plan.json','utf8'));engine.validate(plan);j.guardPid=process.pid;j.phase=j.startedAt?'checking-target':'armed';write(dir+'/journal.json',j);
 if(j.startedAt&&now()<j.startedAt){j.phase='failed';j.error='Host restarted; stale cutover cannot resume';write(dir+'/journal.json',j);return report(j)}
 // No App/VPN/process mutations in this preparation phase.
 while(!j.startedAt){
  if(fs.existsSync(dir+'/cancel.json')){j.phase='cancelled';write(dir+'/journal.json',j);return report(j)}
  if(now()<j.preparedAt||now()-j.preparedAt>180000){j.phase='cancelled';j.error='Preparation expired or host restarted';write(dir+'/journal.json',j);return report(j)}
  if(fs.existsSync(dir+'/start.json')){const s=JSON.parse(fs.readFileSync(dir+'/start.json','utf8'));if(s.token!==j.token)throw Error('Wrong guard generation');j.startedAt=s.startedAt;j.deadline=s.startedAt+engine.TOTAL_MS;write(dir+'/journal.json',j);break}await sleep(50)
 }
 // A crash/restart resumes this same absolute deadline. It does not give a
 // pending native UI action or a slow helper another thirty seconds.
 if(j.observedTargetProcesses)plan.target.processes=j.observedTargetProcesses;
 plan.resumeFallbackLaunch=!!j.fallbackLaunchRequested;
 const ops=create(plan,{onMutation:kind=>{if(kind==='fallback-open-requested'){j.fallbackLaunchRequested=true;write(dir+'/journal.json',j)}}});
 const onState=state=>{j={...j,...state,observedTargetProcesses:ops.records||plan.target.processes};write(dir+'/journal.json',j)};
 const result=await engine.run(plan,ops,{startedAt:j.startedAt,now,onState,cancelled:()=>fs.existsSync(dir+'/cancel.json')});j={...j,...result,result};write(dir+'/journal.json',j);return report(j);
}
function retire(dir){const j=read(dir);if(!terminal.has(j.phase))throw Error('Guard is still active');const target='gui/'+process.getuid()+'/'+j.label;cp.spawnSync('/bin/launchctl',['bootout',target],{encoding:'utf8',timeout:2000,env:context.cleanEnv()});const file=path.join(os.homedir(),'Library/LaunchAgents',j.label+'.plist');if(fs.existsSync(file))fs.renameSync(file,dir+'/launchagent.finished.plist');}
async function main(args){const [command,dir,token]=args;if(command==='capture')return capture({target:dir,prepared:token==='--prepared'});if(command==='arm')return arm(dir);if(command==='start')return start(dir,token);if(command==='watch')return watch(dir);if(command==='status')return report(read(dir));if(command==='cancel'){const j=read(dir);if(j.token!==token)throw Error('Wrong guard token');request(dir,'cancel.json',{token});return {requested:true}}if(command==='retire')return retire(dir);throw Error('Use capture <flclash|clash-app> --prepared, arm/start/status/cancel/retire <private-dir>');}
module.exports={capture,arm,start,watch,read,report,retire,main};
if(require.main===module)main(process.argv.slice(2)).then(r=>{if(r)console.log(JSON.stringify(r))}).catch(e=>{console.error(e.message);process.exitCode=1});
