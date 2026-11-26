'use strict';
const cp=require('node:child_process'),fs=require('node:fs');
const LABEL='io.github.clash-verge-rev.clash-verge-rev.service';
const HELPER='/Library/PrivilegedHelperTools/'+LABEL+'.bundle/Contents/MacOS/clash-verge-service';
const CORE='/Library/Application Support/clash-verge-service/cores/verge-mihomo';
const run=(cmd,args)=>cp.spawnSync(cmd,args,{encoding:'utf8',timeout:2000});
function processRows(text){return text.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);return m?[{pid:Number(m[1]),ppid:Number(m[2]),uid:Number(m[3]),exe:m[4]}]:[]})}
function serviceOwns(row,parent,service){
 const pid=Number(service.match(/^\s*pid = (\d+)\s*$/m)?.[1]);
 const program=service.match(/^\s*program = (.+)\s*$/m)?.[1]?.trim();
 return row.exe===CORE&&row.uid===0&&row.ppid===pid&&parent?.pid===pid&&parent.uid===0&&parent.exe===HELPER&&program===HELPER&&/^\s*state = running\s*$/m.test(service);
}
function socketPath(deps={}){
 const exec=deps.run||run,uid=deps.uid??process.getuid();
 const socket='/var/run/clash-verge-service/users/'+uid+'/verge-mihomo.sock';
 const isSocket=deps.isSocket||(p=>{try{return fs.statSync(p).isSocket()}catch{return false}});
 if(!isSocket(socket))return null;
 const service=exec('/bin/launchctl',['print','system/'+LABEL]);if(service.status!==0)return null;
 const processes=exec('/bin/ps',['-axo','pid=,ppid=,uid=,comm=']);if(processes.status!==0)return null;
 const rows=processRows(processes.stdout);
 for(const row of rows){
  if(!serviceOwns(row,rows.find(p=>p.pid===row.ppid),service.stdout))continue;
  const args=exec('/bin/ps',['-p',String(row.pid),'-o','args=']);
  if(args.status===0&&args.stdout.trim().split(/\s+/).some((p,i,a)=>p==='-ext-ctl-unix'&&a[i+1]===socket))return socket;
 }
 return null;
}
module.exports={LABEL,HELPER,CORE,processRows,serviceOwns,socketPath};

// macOS may hide root sockets from both user lsof and child netstat. Correlate
// a harmless loopback proxy request with the authenticated core's connection
// table instead. A different listener forwarding to this core has a different
// source port and cannot satisfy this check. No Internet traffic is generated.
async function verifyListener(port,api){
 const net=require('node:net'),http=require('node:http');
 const sockets=new Set();let request,sourcePort,received;
 const arrived=new Promise(resolve=>{received=resolve});
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('data',()=>received());socket.on('close',()=>sockets.delete(socket))});
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const target=server.address().port;
  request=http.request({host:'127.0.0.1',port,method:'HEAD',path:'http://127.0.0.1:'+target+'/proxy-listener-check',headers:{Host:'127.0.0.1:'+target},agent:false});
  request.on('socket',socket=>socket.once('connect',()=>{sourcePort=socket.localPort}));request.on('error',()=>received(false));request.end();
  let timer;const ok=await Promise.race([arrived,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1500)})]);clearTimeout(timer);
  if(ok===false||!sourcePort)return false;
  const live=await api('GET','/connections');
  return (live.connections||[]).some(c=>Number(c.metadata?.sourcePort)===sourcePort&&Number(c.metadata?.destinationPort)===target);
 }catch{return false}finally{request?.destroy();for(const s of sockets)s.destroy();server.close()}
}
module.exports.verifyListener=verifyListener;
