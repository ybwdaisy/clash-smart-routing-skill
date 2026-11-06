'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const router=require('./clash-router.cjs'),context=require('./proxy-context.cjs'),follow=require('./client-follow.cjs');
const LABEL='io.github.clash-smart-routing.proxy-manager';
const legacy=['io.github.clash-smart-routing.node-watchdog','io.github.clash-smart-routing.monitor'];
const plist=()=>path.join(os.homedir(),'Library/LaunchAgents',LABEL+'.plist');
function loaded(label=LABEL){return cp.spawnSync('/bin/launchctl',['print','gui/'+process.getuid()+'/'+label],{encoding:'utf8',timeout:3000}).status===0;}
function serviceStatus(){const r=cp.spawnSync('/bin/launchctl',['print','gui/'+process.getuid()+'/'+LABEL],{encoding:'utf8',timeout:3000});return {loaded:r.status===0,running:r.status===0&&/state = running/.test(r.stdout),pid:Number(r.stdout.match(/\bpid = (\d+)/)?.[1])||null};}
function stop(label=LABEL){
 const target='gui/'+process.getuid()+'/'+label;
 const prior=cp.spawnSync('/bin/launchctl',['print',target],{encoding:'utf8',timeout:3000});if(prior.status!==0)return;
 const pid=Number(prior.stdout.match(/\bpid = (\d+)/)?.[1]);
 const result=cp.spawnSync('/bin/launchctl',['bootout',target],{encoding:'utf8',timeout:45000});if(result.status!==0)throw Error('Cannot stop '+label);
 // bootout can acknowledge removal before the old worker finishes shutdown.
 // Do not bootstrap another generation until that process has exited.
 if(pid)for(let i=0;i<300;i++){try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH')return;throw e}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)}
 if(pid)throw Error('Previous '+label+' process did not exit');
}

const xml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function nodeBinary(){return ['/opt/homebrew/bin/node','/usr/local/bin/node'].find(f=>fs.existsSync(f)&&fs.realpathSync(f)===fs.realpathSync(process.execPath))||process.execPath;}
function launchPlist(node=nodeBinary()){return '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>'+LABEL+'</string><key>ProgramArguments</key><array>'+[node,fs.realpathSync(__filename),'run'].map(x=>'<string>'+xml(x)+'</string>').join('')+'</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>30</integer><key>ProcessType</key><string>Background</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>'+(process.env.PROXY_HOME?'<key>PROXY_HOME</key><string>'+xml(process.env.PROXY_HOME)+'</string>':'')+'</dict><key>StandardErrorPath</key><string>'+xml(context.file('manager-error.log'))+'</string></dict></plist>'}
function compileEvents(){
 const source=path.resolve(__dirname,'../assets/proxy-events.swift'),binary=context.file('bin/proxy-events');
 fs.mkdirSync(path.dirname(binary),{recursive:true,mode:0o700});
 if(fs.existsSync(binary)&&fs.statSync(binary).mtimeMs>=fs.statSync(source).mtimeMs)return {available:true,binary};
 const r=cp.spawnSync('/usr/bin/xcrun',['swiftc','-O',source,'-o',binary],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024,env:context.cleanEnv()});
 if(r.status!==0)return {available:false,reason:'event-helper-compile-unavailable'};
 fs.chmodSync(binary,0o700);return {available:true,binary};
}
function delayFor(state,startingSince,now=Date.now()){return state.phase==='starting'&&now-startingSince<15000?250:15000;}
function stopLegacy(){for(const label of legacy){stop(label);const p=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');if(fs.existsSync(p)&&/node-watchdog\.cjs|routing-monitor\.cjs/.test(fs.readFileSync(p,'utf8')))fs.unlinkSync(p);}}
async function install(){
 if(process.platform!=='darwin')throw Error('Automatic proxy integration currently supports macOS');
 fs.mkdirSync(context.base(),{recursive:true,mode:0o700});const events=compileEvents();
 stopLegacy();stop();
 const node=['/opt/homebrew/bin/node','/usr/local/bin/node'].find(f=>fs.existsSync(f)&&fs.realpathSync(f)===fs.realpathSync(process.execPath))||process.execPath;
 router.writePrivate(plist(),launchPlist(node));
 let r;for(let attempt=0;attempt<25;attempt++){r=cp.spawnSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),plist()],{encoding:'utf8',timeout:10000});if(r.status===0)break;if(!/Bootstrap failed: 5:/.test(r.stderr||''))break;await new Promise(yes=>setTimeout(yes,200));}
 if(r.status!==0)throw Error('Cannot start proxy manager: '+(r.stderr||r.error?.message||r.status).toString().trim());
 return {installed:true,...serviceStatus(),events:events.available,fallbackSeconds:15};
}
async function run(){
 const lock=context.file('manager.lock');fs.mkdirSync(context.base(),{recursive:true,mode:0o700});
 if(fs.existsSync(lock)){const pid=Number(fs.readFileSync(lock,'utf8'));if(!Number.isInteger(pid)||pid<=0)throw Error('Invalid manager lock');try{process.kill(pid,0);throw Error('Proxy manager already running')}catch(e){if(e.code!=='ESRCH')throw e}fs.unlinkSync(lock)}
 fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
 let stopping=false,wake,queued=false,eventTimer,eventChild,eventMode='timer-fallback',state={phase:'starting'},startKey='',startingSince=Date.now(),lastEnv=null,lastAudit=0;
 const metrics={discoveries:0,events:0,fallbackSeconds:15};const watches=new Map();
 const trigger=()=>{queued=true;if(wake)wake();};
 const event=()=>{clearTimeout(eventTimer);eventTimer=setTimeout(()=>{metrics.events++;trigger()},250);};
 const stopSignal=()=>{stopping=true;trigger()};process.on('SIGTERM',stopSignal);process.on('SIGINT',stopSignal);
 const monitor=require('./routing-monitor.cjs');
 const workers=Object.fromEntries([['recovery','node-watchdog.cjs'],['learning','routing-monitor.cjs']].map(([kind,script])=>[kind,new follow.Follower({
  select:()=>state.phase==='ready'&&!(kind==='learning'&&state.capabilities?.learning===false)&&context.settings()[kind==='recovery'?'recoveryEnabled':'learningEnabled']?state.selection:{status:'paused-'+state.phase},now:Date.now,
  spawn:root=>{const child=cp.spawn(process.execPath,[path.join(__dirname,script),'watch','--config-dir',root],{detached:true,env:{...context.cleanEnv(),CLASH_NET_FOLLOW_ACTIVE:'1'},stdio:'inherit'});child.on('error',()=>{});return child},
  stop:follow.stopChild,cleanup:async(root,pid)=>{follow.cleanOwnedLocks(root,pid);if(kind==='learning')await monitor.clearOnLeave(root)},
  report:()=>{} })]));
 function addWatch(dir,accept){if(watches.has(dir)||!fs.existsSync(dir))return;try{const w=fs.watch(dir,(_,name)=>{if(!name||accept(String(name)))event()});w.on('error',()=>{});watches.set(dir,w)}catch{}}
 addWatch(context.base(),name=>name==='settings.json');
 addWatch(path.join(os.homedir(),'Library/Preferences'),name=>/clash|verge|follow/i.test(name));
 const helper=context.file('bin/proxy-events');
 if(fs.existsSync(helper)){
  eventChild=cp.spawn(helper,[],{env:context.cleanEnv(),stdio:['ignore','pipe','ignore']});let buffer='';
  eventChild.stdout.on('data',data=>{buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const x=JSON.parse(line);if(x.event==='ready')eventMode='events+timer';if(['ready','launch','terminate'].includes(x.event))event()}catch{}}});
  eventChild.on('error',()=>{eventMode='timer-fallback'});eventChild.on('exit',()=>{eventMode='timer-fallback';if(!stopping)trigger()});
 }
 try{
  while(!stopping){
   queued=false;metrics.discoveries++;state=await context.discover();
   const key=JSON.stringify([state.selection?.root,state.selection?.pid]);if(key!==startKey){startKey=key;startingSince=Date.now()}
   for(const root of router.discover())addWatch(root,name=>/^(native\.json|config\.yaml|clash-verge\.yaml|verge\.yaml|profiles\.yaml|database\.sqlite(?:-wal)?)$/.test(name));
   const config=context.settings(),values=context.variables(state,config),encoded=JSON.stringify(values);let environment=context.read('runtime.json')?.launchd||null;
   try{if(lastEnv!==encoded||Date.now()-lastAudit>=60000){environment=context.syncLaunchd(values);lastAudit=Date.now();if(environment.ok)lastEnv=encoded}}
   catch{environment={ok:false,error:'launchd-sync-failed'}}
   context.write('shell-env.zsh',context.shell(state,config));
   for(const worker of Object.values(workers))await worker.tick();
   const workerStates=Object.fromEntries(Object.entries(workers).map(([kind,w])=>[kind,{enabled:config[kind==='recovery'?'recoveryEnabled':'learningEnabled']&&!(kind==='learning'&&state.capabilities?.learning===false),reason:kind==='learning'&&state.capabilities?.learning===false?'native-app-managed-configuration':null,pid:w.current?.child.pid||null,root:w.current?.selection.root||null}]));
   // Do not export saved launchd baseline values or controller credentials in runtime/status.
   context.write('runtime.json',{...state,managerPid:process.pid,eventMode,metrics:{...metrics},workers:workerStates,launchd:environment?{ok:environment.ok,conflict:!!environment.conflict,error:environment.error}:null,updatedAt:new Date().toISOString()});
   if(stopping)break;
   if(!queued)await new Promise(yes=>{const timer=setTimeout(yes,delayFor(state,startingSince));wake=()=>{clearTimeout(timer);yes()}});wake=null;
  }
 }finally{
  clearTimeout(eventTimer);for(const w of watches.values())w.close();eventChild?.kill();
  for(const worker of Object.values(workers))try{await worker.stop()}catch{}
  try{context.syncLaunchd(context.variables({phase:'stopped'}));context.write('shell-env.zsh',context.shell({phase:'stopped'}));}catch{}
  context.write('runtime.json',{phase:'stopped',updatedAt:new Date().toISOString()});
  process.removeListener('SIGTERM',stopSignal);process.removeListener('SIGINT',stopSignal);
  if(fs.existsSync(lock)&&fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);
 }
}
if(require.main===module){const action=process.argv[2];(action==='run'?run():action==='install'?install():Promise.reject(Error('Use run|install'))).then(x=>{if(x)console.log(JSON.stringify(x))}).catch(e=>{console.error(e.message);process.exitCode=1});}
module.exports={LABEL,legacy,plist,loaded,serviceStatus,stop,stopLegacy,launchPlist,nodeBinary,compileEvents,delayFor,install,run};
