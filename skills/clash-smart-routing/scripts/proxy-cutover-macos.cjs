'use strict';
// Never executed on import. Only an explicitly armed cutover may use these
// adapters. Tests inject the OS boundary; no live client is used as a fixture.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http'),net=require('node:net');
const life=require('./flclash-lifecycle.cjs'),native=require('./clash-app-client.cjs'),svc=require('./verge-service.cjs'),context=require('./proxy-context.cjs');
const {DeadlineError}=require('./proxy-deadline.cjs');
const NATIVE='/Applications/Clash.app/Contents/MacOS/Clash';
const EXT='/Applications/Clash.app/Contents/PlugIns/ClashmacOSExtension.appex/Contents/MacOS/ClashmacOSExtension';
const VERGE='/Applications/Clash Verge.app/Contents/MacOS/clash-verge';
const VERGE_REV='/Applications/Clash Verge Rev.app/Contents/MacOS/clash-verge';
const unsafe=message=>Object.assign(Error(message),{code:'PROXY_UNSAFE'});
function command(file,args,step,{mutating=false,limitMs=650,input,maxBuffer=2*1024*1024}={}){
 step.check();
 return new Promise((resolve,reject)=>{
  let child,timer,out='',err='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);step.signal.removeEventListener('abort',abort);error?reject(error):resolve(value)};
  const abort=()=>{child?.kill('SIGKILL');finish(new DeadlineError('Owned helper cancelled'))};
  try{if(mutating)step.check();child=cp.spawn(file,args,{env:{...context.cleanEnv(),LC_ALL:'C'},stdio:['pipe','pipe','pipe']})}catch(e){finish(e);return}
  step.signal.addEventListener('abort',abort,{once:true});
  child.stdout.on('data',b=>{out+=b;if(out.length>maxBuffer)abort()});child.stderr.on('data',b=>{err+=b;if(err.length>maxBuffer)abort()});
  child.stdin.on('error',e=>finish(e));
  child.once('error',e=>finish(e));child.once('close',code=>{if(code!==0)finish(Object.assign(Error(path.basename(file)+' failed'),{exitCode:code,stderr:err}));else finish(null,out)});
  timer=setTimeout(abort,Math.max(1,Math.min(limitMs,step.remaining())));
  child.stdin.end(input);if(step.signal.aborted)abort();
 });
}
function rawApi(transport,method,route,data,step){
 step.check();const headers=transport.secret?{Authorization:'Bearer '+transport.secret}:{};
 if(/[\r\n]/.test(transport.secret||''))throw unsafe('Invalid private controller secret');
 let address;if(transport.socketPath){if(!path.isAbsolute(transport.socketPath))throw unsafe('Invalid local socket');address={socketPath:transport.socketPath}}else{const u=new URL(transport.url);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/')throw unsafe('Remote controller refused');address={hostname:u.hostname.replace(/^\[|\]$/g,''),port:u.port}}
 const body=data===undefined?undefined:JSON.stringify(data);if(body){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(body)}
 return new Promise((resolve,reject)=>{
  const q=http.request({...address,path:route,method,headers,agent:false},res=>{let text='';res.on('data',b=>{text+=b;if(text.length>12*1024*1024)q.destroy(Error('Controller response too large'))});res.on('end',()=>{cleanup();if(res.statusCode<200||res.statusCode>=300)return reject(Error('Controller HTTP '+res.statusCode));try{resolve(text?JSON.parse(text):null)}catch{reject(Error('Invalid controller JSON'))}})});
  const abort=()=>q.destroy(new DeadlineError('Controller cancelled')),timer=setTimeout(abort,Math.max(1,Math.min(650,step.remaining())));
  function cleanup(){clearTimeout(timer);step.signal.removeEventListener('abort',abort)}
  q.on('error',e=>{cleanup();reject(e)});step.signal.addEventListener('abort',abort,{once:true});step.check();q.end(body);if(step.signal.aborted)abort();
 });
}
function pause(ms,step){step.check();return new Promise(resolve=>{const done=()=>{clearTimeout(timer);step.signal.removeEventListener('abort',done);resolve()},timer=setTimeout(done,Math.min(ms,step.remaining()));step.signal.addEventListener('abort',done,{once:true});});}
function portOpen(port,step){step.check();return new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});const done=value=>{s.destroy();step.signal.removeEventListener('abort',abort);resolve(value)},abort=()=>done(false);s.once('connect',()=>done(true));s.once('error',()=>done(false));s.setTimeout(Math.max(1,Math.min(80,step.remaining())),abort);step.signal.addEventListener('abort',abort,{once:true});});}
function checkedPort(port){if(!Number.isInteger(port)||port<1||port>65535)throw unsafe('Invalid proxy port');return port;}
async function listenerProof(port,transport,step,api=rawApi){
 step.check();const sockets=new Set();let request,sourcePort,arrive;
 const received=new Promise(resolve=>{arrive=resolve}),server=net.createServer(s=>{sockets.add(s);s.once('data',()=>arrive(true));s.on('error',()=>{});s.on('close',()=>sockets.delete(s))});
 const abort=()=>{request?.destroy();for(const s of sockets)s.destroy();try{server.close()}catch{}arrive(false)};step.signal.addEventListener('abort',abort,{once:true});
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});step.check();const destinationPort=server.address().port;
  request=http.request({host:'127.0.0.1',port,method:'HEAD',path:'http://127.0.0.1:'+destinationPort+'/owned-listener',headers:{Host:'127.0.0.1:'+destinationPort},agent:false});
  request.on('socket',s=>s.once('connect',()=>{sourcePort=s.localPort}));request.on('error',()=>arrive(false));request.setTimeout(Math.min(600,step.remaining()),()=>arrive(false));request.end();
  if(!await received||!sourcePort)return false;
  const data=await api(transport,'GET','/connections',undefined,step);
  return (data.connections||[]).some(x=>Number(x.metadata?.sourcePort)===sourcePort&&Number(x.metadata?.destinationPort)===destinationPort);
 }finally{step.signal.removeEventListener('abort',abort);abort();}
}
function create(plan,deps={}){
 const uid=deps.uid??process.getuid(),run=deps.command||command,api=deps.api||rawApi;
 const scan=deps.scan|| (async step=>life.processRows(await run('/bin/ps',['-axo','pid=,ppid=,ruid=,uid=,lstart=,comm='],step)));
 const signal=deps.signal||((pid,name)=>process.kill(pid,name));
 const vpn=deps.vpn|| (async step=>native.vpnService(await run('/usr/sbin/scutil',['--nc','list'],step)));
 const wait=deps.pause||pause,openPort=deps.portOpen||portOpen;
 const isFl=plan.fallback.client==='flclash',fallbackExe=path.join(plan.fallback.app,'Contents/MacOS/'+(isFl?'FlClash':'clash-verge'));
 if(![VERGE,VERGE_REV,life.APP].includes(fallbackExe))throw unsafe('Unsupported fallback executable');
 const targetExe=plan.target.client==='flclash'?life.APP:NATIVE;
 const targetCore=plan.target.client==='flclash'?life.CORE:EXT;
 const records=[...(plan.target.processes||[])];let configuredPid=null,opened=!!plan.resumeFallbackLaunch,progress=new Set();
 const ports=[...new Set([checkedPort(plan.port),...plan.compatibilityPorts.map(checkedPort)])];
 if(plan.fallback.config?.['mixed-port']!==plan.port)throw unsafe('Saved fallback port differs from the requested port');
 for(const port of plan.compatibilityPorts)if(!(plan.fallback.config.listeners||[]).some(x=>x.type==='mixed'&&x.listen==='127.0.0.1'&&Number(x.port)===port))throw unsafe('Fallback lacks an inherited compatibility listener');
 const fallbackUserCore=path.join(plan.fallback.app,'Contents/MacOS/'+(isFl?'FlClashCore':'verge-mihomo'));
 const relevant=p=>[NATIVE,EXT,life.APP,life.CORE,VERGE,VERGE_REV,svc.CORE,fallbackUserCore].includes(p.exe);
 async function nativeState(step){try{return await vpn(step)}catch(e){if(e.code==='NO_NATIVE_VPN')return {status:'Disconnected',connected:false,id:plan.target.vpnId,absent:true};throw e}}
 function assertOwned(record){
  if(record.exe===targetExe&&record.ruid===uid&&record.uid===uid)return;
  if(record.exe===targetCore&&record.ruid===uid&&[uid,0].includes(record.uid))return;
  throw unsafe('Unowned target process refused');
 }
 async function remember(step,{mayAttach=false}={}){
  const rows=await scan(step),guis=rows.filter(p=>p.exe===targetExe),known=records.find(p=>p.exe===targetExe);
  if(guis.length>1)throw unsafe('Multiple target GUIs');
  if(guis[0]){assertOwned(guis[0]);if(known&&!life.sameIdentity(known,guis[0]))throw unsafe('Target GUI restarted; user state is preserved');if(!known){if(!mayAttach)throw unsafe('Target GUI was not captured');records.push(guis[0]);}}
  for(const p of rows.filter(p=>p.exe===targetCore)){
   if(records.some(old=>life.sameIdentity(old,p)))continue;
   const gui=guis[0];if(!gui)throw unsafe('Unattributed target core');assertOwned(p);
   if(plan.target.client==='flclash'&&p.ppid!==gui.pid)throw unsafe('Unrelated FlClash core');
   if(plan.target.client==='clash-app'){const v=await nativeState(step);if(v.id!==plan.target.vpnId||v.status==='Disconnected')throw unsafe('Unattributed native provider');}
   records.push(p);
  }
  return rows;
 }
 async function send(record,name,step){
  assertOwned(record);const actual=(await scan(step)).find(p=>p.pid===record.pid);if(!actual)return;
  if(!life.sameIdentity(record,actual))throw unsafe('PID was reused; process preserved');step.check();
  try{signal(actual.pid,name)}catch(e){if(e.code!=='ESRCH')throw e}
 }
 async function stopTarget(_,step){
  const initial=await remember(step); // Captured GUI/core identity, never a process-name sweep.
  if(!initial.some(p=>p.exe===targetExe||p.exe===targetCore)&&plan.target.client==='flclash')return {stopped:true};
  const gui=records.find(p=>p.exe===targetExe);if(gui)await send(gui,'SIGTERM',step);
  async function requestVpnStop(){if(plan.target.client!=='clash-app')return;const v=await nativeState(step);if(v.id!==plan.target.vpnId)throw unsafe('Native VPN identity changed');if(v.status!=='Disconnected')try{await run('/usr/sbin/scutil',['--nc','stop',v.id],step,{mutating:true,limitMs:500})}catch(e){if(e.code==='PROXY_UNSAFE')throw e;}}
  await requestVpnStop();
  for(const p of records.filter(p=>p.exe===targetCore))await send(p,'SIGTERM',step);
  await wait(180,step);
  // A hung GUI/provider cannot hold recovery hostage. Still signal only the
  // same recorded executable, UID and start time, even if its parent changed.
  for(const p of records)await send(p,'SIGKILL',step);
  await requestVpnStop();
  while(step.remaining()>0){
   const rows=await scan(step),left=rows.filter(p=>p.exe===targetExe||p.exe===targetCore);
   if(left.some(p=>!records.some(old=>life.sameIdentity(old,p))))throw unsafe('New target instance appeared; no broad termination');
   const disconnected=plan.target.client!=='clash-app'||(await nativeState(step)).status==='Disconnected';
   if(!left.length&&disconnected)return {stopped:true};await wait(60,step);
  }
  throw Error('Target GUI/provider did not stop');
 }
 async function exclusive(_,step){
  const rows=await scan(step);const remaining=rows.filter(relevant);
  if((await nativeState(step)).status!=='Disconnected')throw unsafe('Native VPN still active');
  const original=plan.fallback.processes||[];
  if(remaining.length&&remaining.every(p=>[fallbackExe,svc.CORE,fallbackUserCore].includes(p.exe)&&original.some(old=>life.sameIdentity(old,p))))opened=true;
  if(opened&&remaining.every(p=>[fallbackExe,svc.CORE,fallbackUserCore].includes(p.exe)))return true;
  if(remaining.length)throw unsafe('Another client/core remains; fallback not opened');
  if((await Promise.all(ports.map(p=>openPort(p,step)))).some(Boolean))throw unsafe('Requested proxy port is still occupied');return true;
 }
 async function fallbackTransport(step){
  // Prefer the explicit per-user service socket only after registered parent,
  // executable and UID evidence. Never redirect an arbitrary config directory.
  const rows=await scan(step);
  if(isFl){const gui=rows.find(p=>p.exe===life.APP&&p.uid===uid&&p.ruid===uid),core=rows.find(p=>p.exe===life.CORE&&p.ppid===gui?.pid&&p.ruid===uid&&[uid,0].includes(p.uid));if(!core)throw Error('Owned FlClash core not ready');return {pid:core.pid,transport:plan.fallback.transport}}
  let registered='';try{registered=await run('/bin/launchctl',['print','system/'+svc.LABEL],step)}catch{}
  const core=rows.find(p=>svc.serviceOwns(p,rows.find(a=>a.pid===p.ppid),registered));
  if(!core){
   const gui=rows.find(p=>p.exe===fallbackExe&&p.uid===uid&&p.ruid===uid),kernel=rows.find(p=>p.exe===path.join(plan.fallback.app,'Contents/MacOS/verge-mihomo')&&p.uid===uid&&p.ruid===uid&&p.ppid===gui?.pid);
   if(!kernel)throw Error('Trusted Verge core not ready');return {pid:kernel.pid,transport:plan.fallback.transport};
  }
  const socket='/var/run/clash-verge-service/users/'+uid+'/verge-mihomo.sock';
  const args=await run('/bin/ps',['-p',String(core.pid),'-o','args='],step);
  if(!args.trim().split(/\s+/).some((p,i,a)=>p==='-ext-ctl-unix'&&a[i+1]===socket))throw unsafe('Wrong per-user Verge controller');
  return {pid:core.pid,transport:{socketPath:socket,secret:plan.fallback.config.secret||''}};
 }
 async function startFallback(_,step){
  const rows=await scan(step);if(rows.some(p=>relevant(p)&&![fallbackExe,svc.CORE,fallbackUserCore].includes(p.exe)))throw unsafe('Concurrent client refused');
  if((await nativeState(step)).status!=='Disconnected')throw unsafe('Native VPN reconnected; fallback not opened');
  const gui=rows.find(p=>p.exe===fallbackExe);
  if(gui){if(gui.uid!==uid||gui.ruid!==uid)throw unsafe('Fallback GUI ownership mismatch');return}
  if(rows.some(p=>p.exe===svc.CORE))throw unsafe('Old privileged core remains without its GUI');
  if((await Promise.all(ports.map(p=>openPort(p,step)))).some(Boolean))throw unsafe('Fallback port unexpectedly occupied');
  // LaunchServices reuses a running App. Retries never open another client or
  // silently move the configured mixed port when the shared one is occupied.
  step.check();deps.onMutation?.('fallback-open-requested');
  await run('/usr/bin/open',['-a',plan.fallback.app],step,{mutating:true,limitMs:700});opened=true;
 }
 async function restoreFallback(_,step){
  const own=await fallbackTransport(step),request=(m,p,b)=>api(own.transport,m,p,b,step),live=await request('GET','/configs');
  if(live['mixed-port']!==plan.port)throw unsafe('Fallback selected an alternate port; canonical port was not adopted');
  if(configuredPid!==own.pid){configuredPid=own.pid;progress=new Set();}
  async function part(key,work){if(progress.has(key))return;await work();step.check();progress.add(key);}
  {
   await part('runtime',()=>request('PUT','/configs?force=true',{payload:require('yaml').stringify(plan.fallback.config)}));
   for(const [group,name]of Object.entries(plan.fallback.selections||{}))await part('selection:'+group,()=>name===null?request('DELETE','/proxies/'+encodeURIComponent(group)):request('PUT','/proxies/'+encodeURIComponent(group),{name}));
   // Restore only endpoints captured as owned before the cutover. No scanning
   // and overwriting unrelated services or default browser settings.
   for(const entry of plan.fallback.network||[]){
    for(const kind of entry.kinds){if(!['web','secureweb','socksfirewall'].includes(kind))throw unsafe('Invalid captured proxy kind');await part(entry.name+':'+kind,()=>run('/usr/sbin/networksetup',['-set'+kind+'proxy',entry.name,'127.0.0.1',String(plan.port)],step,{mutating:true}));await part(entry.name+':'+kind+':on',()=>run('/usr/sbin/networksetup',['-set'+kind+'proxystate',entry.name,'on'],step,{mutating:true}))}
    await part(entry.name+':bypass',()=>run('/usr/sbin/networksetup',['-setproxybypassdomains',entry.name,...(entry.bypass.length?entry.bypass:['Empty'])],step,{mutating:true}));
   }
  }
 }
 async function publicChecks(step){
  const endpoints=[{name:'ChatGPT',url:'https://chatgpt.com/robots.txt',status:200},{name:'Google',url:'https://www.google.com/generate_204',status:204},{name:'GitHub',url:'https://github.com/robots.txt',status:200}];
  const checks=endpoints.map(e=>({...e,port:plan.port,socks:false}));for(const port of plan.compatibilityPorts){checks.push({...endpoints[0],port,socks:false},{...endpoints[1],port,socks:true})}
  const results=await Promise.all(checks.map(async e=>{try{const timeout=Math.max(0.05,Math.min(1.7,step.remaining()/1000));const text=await run('/usr/bin/curl',['--noproxy','',...(e.socks?['--socks5-hostname','127.0.0.1:'+e.port]:['--proxy','http://127.0.0.1:'+e.port]),'--connect-timeout','1','--max-time',String(timeout),'-sS','-I','-o','/dev/null','-w','%{http_code}',e.url],step,{limitMs:Math.min(1900,step.remaining())});return {name:e.name,port:e.port,socks:e.socks,ok:+text.trim()===e.status}}catch{return {name:e.name,port:e.port,socks:e.socks,ok:false}}}));
  return {ok:results.every(r=>r.ok),checks:results};
 }
 async function verifyFallback(_,step){const own=await fallbackTransport(step),cfg=await api(own.transport,'GET','/configs',undefined,step);if(cfg['mixed-port']!==plan.port)return {ok:false};if(!(await Promise.all(ports.map(p=>listenerProof(p,own.transport,step,api)))).every(Boolean))return {ok:false};return publicChecks(step)}
 async function verifyTarget(_,step){
  const rows=await remember(step,{mayAttach:true});
  if(!rows.some(p=>p.exe===targetExe)||rows.some(p=>relevant(p)&&![targetExe,targetCore].includes(p.exe)))return {ok:false};
  if(plan.target.client==='clash-app'){const v=await vpn(step);if(v.id!==plan.target.vpnId||!v.connected)return {ok:false};const caps=await api(plan.target.transport,'GET','/clash/v1/capabilities',undefined,step);if(caps.api!==1||caps.platform!=='macos')throw unsafe('Wrong native controller');}
  const live=await api(plan.target.transport,'GET','/configs',undefined,step);if(live['mixed-port']!==plan.port)return {ok:false};
  if(!(await Promise.all(ports.map(p=>listenerProof(p,plan.target.transport,step,api)))).every(Boolean))return {ok:false};
  const router=require('./clash-router.cjs');let config=plan.target.config;
  if(plan.target.client==='clash-app'){const [rules,catalog]=await Promise.all([api(plan.target.transport,'GET','/rules',undefined,step),api(plan.target.transport,'GET','/proxies',undefined,step)]);config={...native.policy(rules.rules||[],catalog.proxies||{}),...live}}
  await router.verify({config},(m,p,b)=>api(plan.target.transport,m,p,b,step),{});return publicChecks(step);
 }
 async function originalHealthy(_,step){
  if(opened)return {ok:false};const rows=await scan(step);const old=plan.fallback.processes||[];
  if(rows.some(p=>p.exe===targetCore)||(await nativeState(step)).status!=='Disconnected')return {ok:false};
  if(!old.length||!old.every(p=>rows.some(x=>life.sameIdentity(p,x))))return {ok:false};
  try{const own=await fallbackTransport(step);await api(own.transport,'GET','/version',undefined,step);return {ok:(await Promise.all(ports.map(p=>openPort(p,step)))).every(Boolean)}}catch{return {ok:false}}
 }
 return {stopTarget,exclusive,startFallback,restoreFallback,verifyFallback,verifyTarget,originalHealthy,records};
}
module.exports={create,command,rawApi,pause,portOpen,listenerProof,NATIVE,EXT,VERGE,VERGE_REV};
