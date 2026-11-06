'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const router=require('./clash-router.cjs'),ready=require('./client-readiness.cjs');
const KEYS=['http_proxy','https_proxy','all_proxy','no_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'];
const base=()=>process.env.PROXY_HOME||path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'proxy');
const file=name=>path.join(base(),name);
function read(name,fallback=null){try{return JSON.parse(fs.readFileSync(file(name),'utf8'));}catch{return fallback;}}
function write(name,value){const text=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';const f=file(name);if(fs.existsSync(f)&&fs.readFileSync(f,'utf8')===text)return false;router.writePrivate(f,text);return true;}
function cleanEnv(env=process.env){return Object.fromEntries(Object.entries(env).filter(([k])=>!KEYS.includes(k)&&!['PROXY_SHELL_MODE','PROXY_CONTEXT'].includes(k)));}
function defaults(){return {recoveryEnabled:true,learningEnabled:true,noProxy:['localhost','127.0.0.1','::1','.local','.lan','.internal']};}
function settings(){return {...defaults(),...read('settings.json',{})};}
function noProxy(values){if(!Array.isArray(values)||values.some(x=>typeof x!=='string'||!x||!/^[-A-Za-z0-9_.*:/]+$/.test(x)))throw Error('Invalid no_proxy entry');return [...new Set(values)].join(',');}
function variables(context,config=settings()){
 if(context.phase!=='ready')return Object.fromEntries(KEYS.map(k=>[k,null]));
 const http='http://127.0.0.1:'+context.ports.http,socks=context.ports.socks?'socks5h://127.0.0.1:'+context.ports.socks:null,bypass=noProxy(config.noProxy);
 return {http_proxy:http,https_proxy:http,all_proxy:socks,no_proxy:bypass,HTTP_PROXY:http,HTTPS_PROXY:http,ALL_PROXY:socks,NO_PROXY:bypass};
}
const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
function shell(context,config=settings()){
 const lines=['# Managed by proxy; generated from verified local listener state.'];
 for(const [key,value]of Object.entries(variables(context,config)))lines.push(value===null?'unset '+key:'export '+key+'='+quote(value));
 lines.push('export PROXY_CONTEXT='+quote(context.generation||context.phase), '_PROXY_HTTP_PORT='+quote(context.phase==='ready'?context.ports.http:''));
 return lines.join('\n')+'\n';
}
function ownsListener(port,selection){
 const ids=cp.spawnSync('/usr/sbin/lsof',['-nP','-t','-a','-iTCP:'+port,'-sTCP:LISTEN'],{encoding:'utf8',timeout:2000});
 if(ids.status!==0)return false;
 const pids=[...new Set(ids.stdout.trim().split(/\s+/).filter(x=>/^\d+$/.test(x)))];if(!pids.length)return false;
 const processes=cp.spawnSync('/bin/ps',['-p',pids.join(','),'-o','comm='],{encoding:'utf8',timeout:2000});
 return processes.status===0&&processes.stdout.split('\n').some(x=>(x.trim().startsWith(selection.app+'/Contents/MacOS/')||selection.client==='clash-app'&&x.trim()===selection.app+'/Contents/PlugIns/ClashmacOSExtension.appex/Contents/MacOS/ClashmacOSExtension'));
}
function systemMatches(proxy,ports){return ['http','https'].every(k=>proxy[k]?.enabled&&['127.0.0.1','localhost','::1'].includes(proxy[k].host)&&proxy[k].port===ports.http)&&(!ports.socks||(proxy.socks?.enabled&&proxy.socks.port===ports.socks&&['127.0.0.1','localhost','::1'].includes(proxy.socks.host)));}
async function discover(deps={}){
 const selection=(deps.select||router.activeSelection)();
 if(selection.status!=='active')return {phase:selection.status,selection};
 try{
  const ctx=(deps.load||router.load)(selection.root),api=(deps.api||router.controller)(ctx,{followActive:true,timeoutMs:1500});
  const live=await api('GET','/configs');
  if(ctx.client==='clash-app'&&!ctx.config.rules?.length)await api('GET','/proxies');
  const ports={http:Number(live['mixed-port']||live.port||0),socks:Number(live['mixed-port']||live['socks-port']||0)};
  if(!Number.isInteger(ports.http)||ports.http<=0||ports.http>65535)throw Error('No supported HTTP listener');
  const owns=deps.owns||ownsListener,listen=deps.listener||ready.listener;
  for(const port of new Set([ports.http,ports.socks].filter(Boolean)))if(!await listen(port)||!await owns(port,selection))throw Error('Listener is not owned by the active client');
  const proxy=(deps.systemProxy||ready.systemProxy)();
  const generation=crypto.createHash('sha256').update(JSON.stringify([selection.root,selection.pid,ports])).digest('hex').slice(0,16);
  const vpn=ctx.client==='clash-app'?(deps.vpnStatus||require('./clash-app-client.cjs').vpnStatus)():null;if(vpn&&!vpn.connected)throw Error('Clash native VPN is not connected');
  return {phase:'ready',transport:vpn?'native-vpn':'system-proxy',vpn,capabilities:ctx.capabilities,selection,clientName:selection.appName||path.basename(selection.app,'.app'),ports,generation,systemProxy:{matches:systemMatches(proxy,ports)},checkedAt:Date.now()};
 }catch(e){return {phase:'starting',selection,reason:e.message,checkedAt:Date.now()};}
}
function launchctl(action,key,value){
 if(!KEYS.includes(key))throw Error('Unexpected proxy variable');
 const args=[action,key,...(value===undefined?[]:[value])];
 const r=cp.spawnSync('/bin/launchctl',args,{encoding:'utf8',timeout:2000,env:cleanEnv()});
 if(action==='getenv')return r.status===0?(r.stdout.trim()||null):null;
 if(r.status!==0)throw Error('Cannot update launchd proxy environment');
}
function syncLaunchd(values,ops=launchctl,ownership=read('environment-owner.json')){
 const current=Object.fromEntries(KEYS.map(k=>[k,ops('getenv',k)]));
 const owner=ownership||{baseline:current,last:current};
 if(KEYS.some(k=>current[k]!==owner.last[k]))return {ok:false,conflict:true,ownership:owner};
 const applied=[];
 try{for(const k of KEYS){if(current[k]===values[k])continue;ops(values[k]===null?'unsetenv':'setenv',k,values[k]===null?undefined:values[k]);applied.push(k);}}
 catch(e){for(const k of applied.reverse())ops(current[k]===null?'unsetenv':'setenv',k,current[k]===null?undefined:current[k]);throw e;}
 const next={...owner,last:values};if(ops===launchctl)write('environment-owner.json',next);
 return {ok:true,changed:applied.length>0,ownership:next};
}
function restoreLaunchd(ops=launchctl,ownership=read('environment-owner.json')){
 if(!ownership)return;for(const key of KEYS)if(ops('getenv',key)===ownership.last[key])ops(ownership.baseline[key]===null?'unsetenv':'setenv',key,ownership.baseline[key]===null?undefined:ownership.baseline[key]);
}
function guiReady(state){return state.transport==='native-vpn'?state.vpn?.connected===true:state.systemProxy?.matches===true;}
module.exports={guiReady,defaults,KEYS,base,file,read,write,cleanEnv,settings,noProxy,variables,quote,shell,discover,ownsListener,systemMatches,launchctl,syncLaunchd,restoreLaunchd};
