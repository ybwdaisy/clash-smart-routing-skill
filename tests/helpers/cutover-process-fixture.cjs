'use strict';
// Public, synthetic processes only. No real App, subscription or Internet route.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net'),http=require('node:http');
const [mode,dir,role]=process.argv.slice(2),cfg=JSON.parse(fs.readFileSync(dir+'/fixture.json','utf8'));
const base=path.resolve(__dirname,'../../skills/clash-smart-routing/scripts'),life=require(base+'/flclash-lifecycle.cjs'),mac=require(base+'/proxy-cutover-macos.cjs');
function register(kind){const row=life.rows().find(p=>p.pid===process.pid);fs.writeFileSync(path.join(dir,kind+'-'+process.pid+'.json'),JSON.stringify({...row,kind}),{mode:0o600});}
function children(){return fs.readdirSync(dir).filter(n=>/^(?:target|fallback|agent|helper|guard|coordinator)-.*\.json$/.test(n)).map(n=>{try{return JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'))}catch{return null}}).filter(Boolean)}
function actualRows(){const all=life.rows();return children().flatMap(record=>{const p=all.find(p=>p.pid===record.pid&&life.sameIdentity(p,record));if(!p)return [];const aliases={'target-gui':mac.NATIVE,'target-core':mac.EXT,'fallback-gui':mac.VERGE,'fallback-core':'/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo','agent':'/Applications/ChatGPT.app/Contents/MacOS/codex'};return aliases[record.kind]?[{...p,exe:aliases[record.kind]}]:[]})}
function event(name){fs.appendFileSync(dir+'/events.log',JSON.stringify({name,pid:process.pid,at:Date.now()})+'\n')}
function child(nextMode,nextRole){const p=cp.spawn(process.execPath,[__filename,nextMode,dir,nextRole],{stdio:'ignore',detached:true});p.unref();return p}
if(mode==='gui'){
 register(role+'-gui');event(role+'-gui-start');
 if(role==='target'){process.on('SIGTERM',()=>event('target-gui-ignored-TERM'));child('server',role)}
 else setTimeout(()=>child('server',role),cfg.fallbackDelayMs);
 setInterval(()=>{},10000);
}else if(mode==='server'){
 register(role+'-core');event(role+'-core-start');const connections=new Map(),servers=[];let sequence=0,sourceConfig=cfg.routing;
 const endpoints=[cfg.port,cfg.compatibilityPort];
 function allowed(host){return ['127.0.0.1','localhost'].includes(host)}
 function remember(socket,destination){const id=String(++sequence);connections.set(id,{id,metadata:{sourcePort:socket.remotePort,destinationPort:destination}});socket.on('close',()=>connections.delete(id));return id}
 for(const port of endpoints){const server=http.createServer((req,res)=>{const url=new URL(req.url);if(!allowed(url.hostname)){res.writeHead(403);return res.end()}const id=remember(req.socket,Number(url.port)||80),up=http.request({host:url.hostname,port:url.port,path:url.pathname,method:req.method},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});up.on('error',()=>{res.writeHead(502);res.end()});req.pipe(up);res.on('close',()=>connections.delete(id))});
  server.on('connect',(req,socket)=>{if(role==='target'){socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');return socket.end()}const [host,p]=req.url.split(':');if(!allowed(host))return socket.destroy();remember(socket,Number(p));const upstream=net.connect(Number(p),host,()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.pipe(upstream);upstream.pipe(socket)});upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy())});
  // Detect SOCKS before handing other bytes to the Node HTTP server.
  const mixed=net.createServer(socket=>{socket.once('data',first=>{if(first[0]!==5){socket.unshift(first);server.emit('connection',socket);socket.resume();return}socket.write(Buffer.from([5,0]));socket.once('data',b=>{if(b[0]!==5||b[1]!==1)return socket.destroy();let host,offset;if(b[3]===1){host=[...b.subarray(4,8)].join('.');offset=8}else if(b[3]===3){host=b.subarray(5,5+b[4]).toString();offset=5+b[4]}else return socket.destroy();const p=b.readUInt16BE(offset);if(!allowed(host))return socket.destroy();if(role==='target')return socket.destroy();remember(socket,p);const upstream=net.connect(p,host,()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));socket.pipe(upstream);upstream.pipe(socket)});upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy())})})});mixed.listen(port,'127.0.0.1');servers.push(mixed);
 }
 const catalog={main:{type:'Selector',all:['automatic'],now:'automatic'},automatic:{type:'URLTest',all:['fixture-node'],now:'fixture-node',fixed:'fixture-node'},'fixture-node':{type:'Shadowsocks'},'Smart Routing · Proxy':{type:'Selector',all:['main'],now:'main'}};
 const rules=cfg.routing.rules.map(s=>{const f=s.split(',');return f[0]==='RULE-SET'?{type:'RuleSet',payload:f[1],proxy:f[2]}:{type:'Match',payload:'',proxy:f[1]}});
 const controller=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{res.setHeader('Content-Type','application/json');if(req.url==='/clash/v1/capabilities')return res.end('{"api":1,"platform":"macos"}');if(req.url==='/version')return res.end('{"version":"fixture-only"}');if(req.url==='/connections')return res.end(JSON.stringify({connections:[...connections.values()]}));if(req.url==='/configs')return res.end(JSON.stringify({'mixed-port':cfg.port,mode:'rule',tun:{enable:true}}));if(req.url==='/rules')return res.end(JSON.stringify({rules}));if(req.url==='/proxies')return res.end(JSON.stringify({proxies:catalog}));if(req.url==='/providers/rules')return res.end(JSON.stringify({providers:Object.fromEntries(Object.keys(cfg.routing['rule-providers']).map(n=>[n,{ruleCount:1}]))}));if(req.method==='PUT'||req.method==='DELETE'){res.statusCode=204;return res.end()}res.statusCode=404;res.end('{}')})});controller.listen(cfg.controllerPort,'127.0.0.1');servers.push(controller);
 if(role==='target')process.on('SIGTERM',()=>event('target-core-ignored-TERM'));
}else if(mode==='hang'){
 register('helper-hang');process.on('SIGTERM',()=>{});setInterval(()=>{},10000);
}else if(mode==='agent'){
 http.createServer((req,res)=>{res.writeHead(200);res.write('independent-agent\n');const t=setInterval(()=>res.write('tick\n'),40);res.on('close',()=>clearInterval(t))}).listen(cfg.agentPort,'127.0.0.1',()=>register('agent'));
}else if(mode==='coordinator'){
 register('coordinator-driver');child('guard','');setTimeout(()=>process.exit(0),100);
}else if(mode==='guard'){
 register('guard-driver');const watch=require(base+'/proxy-switch-guard.cjs').watch;
 const deps={uid:process.getuid(),scan:async()=>actualRows(),vpn:async()=>({id:cfg.vpnId,connected:actualRows().some(p=>p.exe===mac.EXT),status:actualRows().some(p=>p.exe===mac.EXT)?'Connected':'Disconnected'}),command:async(file,args,step,options)=>{
  if(file==='/usr/sbin/scutil')return mac.command(process.execPath,[__filename,'hang',dir,''],step,{limitMs:500});
  if(file==='/usr/bin/open'){event('fallback-open-requested');child('gui','fallback');return ''}
  if(file==='/bin/launchctl')throw Error('No privileged fixture service');
  if(file==='/usr/bin/curl'){const e=args.at(-1),pathname=e.includes('google.com')?'/google':e.includes('github.com')?'/github':'/chatgpt';try{const out=await mac.command(file,[...args.slice(0,-1),'--cacert',dir+'/cert.pem','https://127.0.0.1:'+cfg.tlsPort+pathname],step,options);event('curl '+pathname+' '+out);return out}catch(error){event('curl-error '+pathname+' '+error.message+' '+(error.stderr||'').slice(0,350));throw error}}
  throw Error('Unexpected OS command in isolated test: '+file);
 }};
 watch(dir,{create:(plan,options)=>mac.create(plan,{...deps,...options})}).then(out=>{writeResult(out);process.exit(0)}).catch(e=>{writeResult({error:e.message});process.exit(1)});
 function writeResult(out){fs.writeFileSync(dir+'/fixture-result.json',JSON.stringify(out),{mode:0o600})}
}
