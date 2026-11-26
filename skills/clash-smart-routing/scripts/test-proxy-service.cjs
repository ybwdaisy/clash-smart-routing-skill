'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const c=require('./proxy-context.cjs'),{summary}=require('./proxy-cli.cjs');
const service=require('./verge-service.cjs');
const app='/Applications/Clash Verge.app',core='/Library/Application Support/clash-verge-service/cores/verge-mihomo';
const helper='/Library/PrivilegedHelperTools/io.github.clash-verge-rev.clash-verge-rev.service.bundle/Contents/MacOS/clash-verge-service';
const selection={status:'active',app,client:'verge',appName:'Clash Verge',root:'/fixture',pid:12};
const sockets='tcp4 0 0 127.0.0.1.7897 *.* LISTEN 0 0 131072 131072 verge-mihomo:38266 00180\n'+
 'tcp6 0 0 *.9999 *.* LISTEN 0 0 0 0 unrelated:20 00180\n'+
 'tcp4 0 0 127.0.0.1.7897 127.0.0.1.50001 ESTABLISHED 0 0 0 0 unrelated:21 0';
function runner(overrides={}){return (cmd,args)=>{
 const key=cmd.split('/').pop();let text;
 if(key==='lsof')return {status:1,stdout:''};
 if(key==='netstat')text=sockets;
 if(key==='launchctl')text='state = running\nprogram = '+helper+'\npid = 38258\n';
 if(key==='ps')text=args[1]==='38266'?'38266 38258 0 '+core:'38258 1 0 '+helper;
 return {status:0,stdout:overrides[key]??text??''};
}}
test('root service listener is verified when user lsof cannot see it',()=>assert.equal(c.ownsListener(7897,selection,{run:runner()}),true));
test('netstat associates only LISTEN sockets on the requested local port',()=>assert.deepEqual(c.netstatPids(sockets,7897),['38266']));
test('a matching kernel filename is insufficient without the registered parent',()=>{
 assert.equal(c.ownsListener(7897,selection,{run:runner({launchctl:'state = running\npid = 99\nprogram = '+helper})}),false);
 assert.equal(c.ownsListener(7897,selection,{run:runner({ps:'38266 38258 501 '+core})}),false);
 assert.equal(c.ownsListener(7897,selection,{run:runner({launchctl:'state = stopped\npid = 38258\nprogram = '+helper})}),false);
});
test('Verge service cannot be mistaken for FlClash',()=>assert.equal(c.ownsListener(7897,{...selection,client:'flclash'},{run:runner()}),false));
test('unavailable process or socket evidence fails closed',()=>{
 assert.equal(c.ownsListener(7897,selection,{run:runner({netstat:''})}),false);
 assert.equal(c.ownsListener(7897,selection,{run:runner({ps:''})}),false);
});
test('ordinary app-owned listeners remain supported',()=>{
 const run=(cmd,args)=>cmd.endsWith('lsof')?{status:0,stdout:'42\n'}:{status:0,stdout:'42 12 501 '+app+'/Contents/MacOS/verge-mihomo'};
 assert.equal(c.ownsListener(7897,selection,{run}),true);
});
const proxy={http:{enabled:true,host:'127.0.0.1',port:7897},https:{enabled:true,host:'127.0.0.1',port:7897},socks:{enabled:true,host:'127.0.0.1',port:7897}};
function discover(tun,owns=true){return c.discover({select:()=>selection,load:()=>({client:'verge'}),api:()=>async()=>({'mixed-port':7897,...(tun===undefined?{}:{tun})}),listener:async()=>true,owns:()=>owns,systemProxy:()=>proxy})}
test('live controller TUN states survive discovery without guessing',async()=>{
 for(const enabled of [true,false]){const s=await discover({enable:enabled,device:'utun10'});assert.equal(s.phase,'ready');assert.equal(s.tun.enabled,enabled)}
 assert.equal((await discover()).tun.enabled,null);
 const failed=await discover({enable:true},false);assert.equal(failed.phase,'starting');assert.equal(failed.clientName,'Clash Verge');assert.equal(failed.tun.enabled,true);assert.ok(failed.reason);
});
test('status reports enabled, disabled and unknown TUN and preserves terminal opt-out',async()=>{
 for(const [value,label] of [[true,'已开启'],[false,'已关闭'],[null,'未知']]){
  const s=await discover(value===null?undefined:{enable:value});
  const text=summary({...s,shell:{optOut:true},launchd:{matches:true},manager:{running:true}});
  assert.ok(text.includes('TUN 虚拟网卡：'+label));assert.ok(text.includes('当前终端：已关闭'));
 }
});
test('service socket discovery rejects another UID and stale/untrusted services',()=>{
 const run=(cmd,args)=>cmd.endsWith('launchctl')?{status:0,stdout:'state = running\nprogram = '+helper+'\npid = 38258'}:
  args[0]==='-axo'?{status:0,stdout:'38258 1 0 '+helper+'\n38266 38258 0 '+core}:{status:0,stdout:core+' -ext-ctl-unix /var/run/clash-verge-service/users/501/verge-mihomo.sock'};
 assert.equal(service.socketPath({run,uid:501,isSocket:()=>true}),'/var/run/clash-verge-service/users/501/verge-mihomo.sock');
 assert.equal(service.socketPath({run,uid:502,isSocket:()=>true}),null);
 assert.equal(service.socketPath({run,uid:501,isSocket:()=>false}),null);
 assert.equal(service.socketPath({run:()=>({status:1}),uid:501,isSocket:()=>true}),null);
});
test('loopback ownership check requires matching source and destination ports',async()=>{
 const http=require('node:http'),net=require('node:net');let metadata;const connections=new Set();
 const proxy=http.createServer(req=>{const target=new URL(req.url);metadata={sourcePort:req.socket.remotePort,destinationPort:Number(target.port)};
  const backend=net.connect(Number(target.port),'127.0.0.1',()=>backend.write('HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n'));
  connections.add(backend);backend.on('error',()=>{});req.socket.on('close',()=>backend.destroy());
 });
 proxy.on('connection',socket=>{connections.add(socket);socket.on('error',()=>{})});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 try{
  assert.equal(await service.verifyListener(proxy.address().port,async()=>({connections:[{metadata}]})),true);
  assert.equal(await service.verifyListener(proxy.address().port,async()=>({connections:[{metadata:{...metadata,sourcePort:metadata.sourcePort+1}}]})),false);
  assert.equal(await service.verifyListener(proxy.address().port,async()=>({connections:[]})),false);
 }finally{for(const socket of connections)socket.destroy();await new Promise(resolve=>proxy.close(resolve))}
});
