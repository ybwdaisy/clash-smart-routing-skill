'use strict';
// Independent, user-launchd rollback. The journal is private and never published.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const c=require('./proxy-context.cjs'),r=require('./clash-router.cjs'),manager=require('./proxy-manager.cjs');
const pause=ms=>new Promise(yes=>setTimeout(yes,ms)),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function read(dir){return JSON.parse(fs.readFileSync(path.join(dir,'journal.json'),'utf8'));}
function save(dir,value){r.writePrivate(path.join(dir,'journal.json'),JSON.stringify(value,null,2)+'\n');}
function inspect(file){return fs.existsSync(file)?{exists:true,hash:hash(fs.readFileSync(file)),mode:fs.statSync(file).mode&0o777}:{exists:false,hash:null};}
function include(dir,file){const j=read(dir);active(j);if(j.entries.some(e=>e.file===file))return;const original=inspect(file),backup=path.join(dir,'file-'+j.entries.length);if(original.exists)r.writePrivate(backup,fs.readFileSync(file));j.entries.push({file,backup,original,expected:original});save(dir,j);}
function loaded(label){return cp.spawnSync('/bin/launchctl',['print','gui/'+process.getuid()+'/'+label],{encoding:'utf8',timeout:3000}).status===0;}
const xml=x=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function begin(files,{timeoutMs=180000,extraAgents=[]}={}){
 const dir=c.file('backups/'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'));
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const entries=[];for(const file of [...new Set(files)]){const original=inspect(file),backup=path.join(dir,'file-'+entries.length);if(original.exists)r.writePrivate(backup,fs.readFileSync(file));entries.push({file,backup,original,expected:original});}
 const agents=[...new Map([...manager.legacy,manager.LABEL].map(label=>({label,file:path.join(os.homedir(),'Library/LaunchAgents',label+'.plist')})).concat(extraAgents).map(a=>[a.label,{...a,loaded:loaded(a.label)}])).values()];
 const selected=r.activeSelection(),fallback=selected.status==='active'&&selected.client==='verge'?selected.root:r.discover().find(root=>path.basename(root)!=='com.follow.clash')||r.resolveConfigDir();
 if(path.basename(fallback)==='com.hako.network')throw Error('Native Clash setup needs a configured Clash Verge fallback before switching');
 const fallbackApp=selected.status==='active'&&selected.root===fallback?selected.app:null;
 const started=cp.spawnSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).stdout.trim();
 const snapshot=await fallbackSnapshot(fallback,fallbackApp);
 const journal={fallbackSnapshot:snapshot,workerExe:process.execPath,workerMayTerminate:['proxy-cli.cjs','proxy-install.cjs','proxy-safety.cjs'].some(name=>process.argv[1]===path.join(__dirname,name)),version:1,phase:'armed',deadline:Date.now()+timeoutMs,workerPid:process.pid,workerStarted:started,entries,agents,fallback,fallbackApp,environmentOwner:c.read('environment-owner.json'),launchd:Object.fromEntries(c.KEYS.map(k=>[k,c.launchctl('getenv',k)])),label:'io.github.clash-smart-routing.proxy-guard-'+path.basename(dir)};
 save(dir,journal);
 const plist=path.join(os.homedir(),'Library/LaunchAgents',journal.label+'.plist');
 const args=[process.execPath,fs.realpathSync(__filename),'guard',dir].map(x=>'<string>'+xml(x)+'</string>').join('');
 r.writePrivate(plist,'<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>'+journal.label+'</string><key>ProgramArguments</key><array>'+args+'</array><key>RunAtLoad</key><true/><key>StandardErrorPath</key><string>'+xml(path.join(dir,'guard-error.log'))+'</string></dict></plist>');
 const boot=cp.spawnSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),plist],{encoding:'utf8',timeout:5000});if(boot.status!==0)throw Error('Cannot arm independent rollback guard');
 for(let i=0;i<50&&!fs.existsSync(path.join(dir,'ready'));i++)await pause(100);
 if(!fs.existsSync(path.join(dir,'ready')))throw Error('Independent guard did not acknowledge readiness');
 return dir;
}
const revoked=new Set(['rolling-back','network-restored','rolled-back','committed','failed','recovery-failed']);
function active(j){if(revoked.has(j.phase)||Date.now()>j.deadline)throw Error('Transaction is no longer active');}
function write(dir,file,data,mode=0o600){const j=read(dir);active(j);const e=j.entries.find(x=>x.file===file);if(!e)throw Error('File was not included in transaction');e.expected={exists:true,hash:hash(data)};save(dir,j);r.writePrivate(file,data);fs.chmodSync(file,mode);}
function remove(dir,file){const j=read(dir);active(j);const e=j.entries.find(x=>x.file===file);if(!e)throw Error('File was not included in transaction');e.expected={exists:false,hash:null};save(dir,j);fs.rmSync(file,{force:true});}
function stage(dir,phase){const j=read(dir);active(j);save(dir,{...j,phase});}
function retire(dir){const j=read(dir),target='gui/'+process.getuid()+'/'+j.label;if(loaded(j.label))cp.spawnSync('/bin/launchctl',['bootout',target],{encoding:'utf8',timeout:5000});fs.rmSync(path.join(os.homedir(),'Library/LaunchAgents',j.label+'.plist'),{force:true});}
function commit(dir){stage(dir,'committed');retire(dir);}
function fail(dir,message){const j=read(dir);if(revoked.has(j.phase))return;save(dir,{...j,phase:'failed',failure:message});}
async function restoreFiles(dir,{check=()=>{}}={}){const j=read(dir),conflicts=[];for(const e of [...j.entries].reverse()){
 check();const actual=inspect(e.file);if(actual.exists===e.original.exists&&actual.hash===e.original.hash)continue;
 if(!e.nativeGenerated&&(actual.exists!==e.expected.exists||actual.hash!==e.expected.hash)){conflicts.push(e.file);continue;}
 if(e.original.exists){r.writePrivate(e.file,fs.readFileSync(e.backup));fs.chmodSync(e.file,e.original.mode||0o600)}else fs.rmSync(e.file,{force:true});
 }return conflicts;
}
async function fallbackSnapshot(root,app){
 const ctx=r.load(root),client=ctx.client||'verge',fallbackApp=app||(client==='flclash'?'/Applications/FlClash.app':'/Applications/Clash Verge.app');
 const config=JSON.parse(JSON.stringify(ctx.config));let selections={};
 const selected=r.activeSelection();if(selected.status==='active'&&selected.root===root){try{const api=r.controller(ctx,{followActive:false,timeoutMs:800}),live=await api('GET','/configs'),catalog=(await api('GET','/proxies')).proxies;config.tun={...config.tun,enable:live.tun?.enable};for(const [name,p]of Object.entries(catalog)){if(p.type==='Selector')selections[name]=p.now;if(p.type==='URLTest')selections[name]=p.fixed||null;}}catch{}}
 const service=client==='verge'&&selected.root===root?require('./verge-service.cjs').socketPath():null;
 const transport=service?{socketPath:service,secret:config.secret||''}:config['external-controller-unix']?{socketPath:config['external-controller-unix'],secret:config.secret||''}:{url:'http://'+String(config['external-controller']||'').replace(/^0\.0\.0\.0:/,'127.0.0.1:'),secret:config.secret||''};
 const budget=new (require('./proxy-deadline.cjs').Budget)(require('./proxy-deadline.cjs').monotonicMs()+15000),mac=require('./proxy-cutover-macos.cjs'),network=[];
 await budget.step('capture owned network slots',async step=>{const services=(await mac.command('/usr/sbin/networksetup',['-listallnetworkservices'],step)).split('\n').slice(1).filter(x=>x&&!x.startsWith('*'));for(const name of services){const kinds=[];for(const kind of ['web','secureweb','socksfirewall']){const text=await mac.command('/usr/sbin/networksetup',['-get'+kind+'proxy',name],step);if(/^Server: (127\.0\.0\.1|localhost)$/m.test(text)&&new RegExp('^Port: '+config['mixed-port']+'$','m').test(text))kinds.push(kind)}if(kinds.length){const bypass=(await mac.command('/usr/sbin/networksetup',['-getproxybypassdomains',name],step)).trim().split('\n');network.push({name,kinds,bypass:bypass[0].startsWith("There aren't")?[]:bypass})}}});budget.close();
 return {client,root,app:fallbackApp,config,selections,transport,network};
}
async function restoreVerge(root,app,options={}){
 const {monotonicMs}=require('./proxy-deadline.cjs'),engine=require('./proxy-cutover.cjs'),mac=require('./proxy-cutover-macos.cjs'),life=require('./flclash-lifecycle.cjs');
 const startedAt=options.startedAt??monotonicMs(),deadline=options.deadline??startedAt+30000;
 const fallback=options.snapshot||await fallbackSnapshot(root,app),rows=life.rows(),native=require('./clash-app-client.cjs');
 const hasNative=rows.some(p=>[mac.NATIVE,mac.EXT].includes(p.exe)),hasFl=rows.some(p=>[life.APP,life.CORE].includes(p.exe));if(hasNative&&hasFl)throw Error('Ambiguous target clients; no broad shutdown');
 let vpn;try{vpn=native.vpnStatus()}catch(e){if(e.code!=='NO_NATIVE_VPN')throw e}
 const client=hasNative||fallback.client==='flclash'?'clash-app':'flclash',target={client,vpnId:vpn?.id,processes:rows.filter(p=>(client==='clash-app'?[mac.NATIVE,mac.EXT]:[life.APP,life.CORE]).includes(p.exe))};
 const plan={version:1,port:Number(fallback.config['mixed-port']),compatibilityPorts:[...new Set((fallback.config.listeners||[]).filter(x=>x.type==='mixed'&&x.listen==='127.0.0.1').map(x=>Number(x.port)))],uiPrepared:true,compatibilityVerified:true,fallback,target,resumeFallbackLaunch:rows.some(p=>p.exe===fallback.app+'/Contents/MacOS/'+(fallback.client==='flclash'?'FlClash':'clash-verge'))};plan.compatibilityPorts=plan.compatibilityPorts.filter(p=>p!==plan.port);
 const ops=mac.create(plan);if(options.prepareFallback)ops.prepareFallback=options.prepareFallback;
 const result=await engine.recover(plan,ops,{startedAt,deadline,onState:options.onState});if(!result.ok)throw Error(result.error);
 return {...result,client:fallback.client,port:plan.port,publicHttp:200,publicReachable:true};
}
async function rollback(dir,deps={}){
 const claim=path.join(dir,'rollback-claimed');try{fs.writeFileSync(claim,'1',{flag:'wx',mode:0o600})}catch(e){if(e.code==='EEXIST')return read(dir);throw e}
 let j=read(dir);save(dir,{...j,phase:'rolling-back'});
 // Kill only our own setup CLI, never a Codex/other agent that imported this API.
 if(j.workerMayTerminate&&j.workerPid&&j.workerPid!==process.pid){const row=require('./flclash-lifecycle.cjs').rows().find(p=>p.pid===j.workerPid);if(row&&row.born===j.workerStarted&&row.exe===j.workerExe&&row.ruid===process.getuid())try{process.kill(j.workerPid,'SIGTERM')}catch{}}
 const startedAt=require('./proxy-deadline.cjs').monotonicMs(),conflicts=[];let fallback,error;
 try{
  fallback=await (deps.restoreVerge||restoreVerge)(j.fallback,j.fallbackApp,{snapshot:j.fallbackSnapshot,startedAt,deadline:startedAt+30000,prepareFallback:async(_,step)=>{conflicts.push(...await restoreFiles(dir,{check:step.check}))}});
  if(!fallback?.publicReachable)throw Error('Fallback public connectivity is not verified');
 }catch(e){error=e.message;j=read(dir);save(dir,{...j,phase:'recovery-failed',conflicts,error,finishedAt:new Date().toISOString()});return read(dir)}
 // Connectivity is durable evidence separate from slower file/service cleanup.
 // Stop/reinstall of the manager must not consume the outage recovery reserve.
 j=read(dir);save(dir,{...j,phase:'network-restored',fallback,networkRestoredAt:new Date().toISOString(),conflicts});
 for(const label of new Set([manager.LABEL,...j.agents.map(a=>a.label)]))try{(deps.stopManager||manager.stop)(label)}catch{}
 if(deps.restoreEnvironment)await deps.restoreEnvironment(j);else{
  const owner=c.read('environment-owner.json');for(const k of c.KEYS){const value=c.launchctl('getenv',k);if(!owner||value===owner.last[k]){c.launchctl(j.launchd[k]===null?'unsetenv':'setenv',k,j.launchd[k]===null?undefined:j.launchd[k]);if(owner)owner.last[k]=j.launchd[k];}}if(owner)c.write('environment-owner.json',{...(j.environmentOwner||{baseline:j.launchd}),last:owner.last});
 }
 if(j.nativePreferences){try{const fl=require('./flclash-client.cjs');if(fl.running())conflicts.push('FlClash preferences retained while its working client is running');else{const n=j.nativePreferences,prefs=fl.preferences(n.root);for(const x of n.changes){if(String(prefs[x.section][x.key])===String(x.after))prefs[x.section][x.key]=x.before;else conflicts.push('FlClash native preference '+x.section+'.'+x.key)}fl.writePreferences(prefs)}}catch{conflicts.push('FlClash native preferences')}}
 for(const a of j.agents)if(a.loaded&&fs.existsSync(a.file)){
  if(deps.restoreAgent)await deps.restoreAgent(a);else if(!loaded(a.label))cp.spawnSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),a.file],{encoding:'utf8',timeout:10000});
 }
 j=read(dir);save(dir,{...j,phase:'rolled-back',conflicts,fallback,finishedAt:new Date().toISOString()});return read(dir);
}
async function guard(dir){fs.writeFileSync(path.join(dir,'ready'),String(process.pid),{mode:0o600});while(true){const j=read(dir);if(['committed','rolled-back','recovery-failed'].includes(j.phase))return;if(j.phase==='failed'||Date.now()>j.deadline){await rollback(dir);fs.rmSync(path.join(os.homedir(),'Library/LaunchAgents',j.label+'.plist'),{force:true});const cleanup=cp.spawn('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+j.label],{detached:true,stdio:'ignore',env:c.cleanEnv()});cleanup.unref();return;}await pause(500)}}
if(require.main===module&&process.argv[2]==='guard')guard(process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={fallbackSnapshot,begin,read,save,include,write,remove,stage,commit,fail,restoreFiles,rollback,retire,restoreVerge};
