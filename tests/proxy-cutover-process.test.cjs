'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),http=require('node:http'),https=require('node:https'),cp=require('node:child_process');
const base=path.resolve(__dirname,'../skills/clash-smart-routing'),fixture=path.join(__dirname,'helpers/cutover-process-fixture.cjs'),life=require(base+'/scripts/flclash-lifecycle.cjs'),mac=require(base+'/scripts/proxy-cutover-macos.cjs'),{monotonicMs}=require(base+'/scripts/proxy-deadline.cjs'),router=require(base+'/scripts/clash-router.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});const p=s.address().port;await new Promise(r=>s.close(r));assert(![7897,7900,9090,53,80,443].includes(p));return p}
async function until(fn,ms=3000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(30)}throw Error('Isolated fixture readiness timed out')}
function rows(dir,prefix){return fs.readdirSync(dir).filter(n=>n.startsWith(prefix)&&n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(dir+'/'+n,'utf8')))}
function start(dir,mode,role=''){const out=fs.openSync(dir+'/'+mode+'-'+role+'.log','a',0o600);const p=cp.spawn(process.execPath,[fixture,mode,dir,role],{stdio:['ignore',out,out]});fs.closeSync(out);p.on('error',()=>{});return p}
function alive(record){return life.rows().some(p=>life.sameIdentity(record,p))}
async function cleanup(dir){
 const records=fs.readdirSync(dir).filter(n=>/^(?:target|fallback|agent|helper|guard|coordinator)-.*\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(dir+'/'+n,'utf8')));
 for(const p of life.rows().filter(p=>records.some(r=>life.sameIdentity(p,r)))){
  const args=cp.spawnSync('/bin/ps',['-p',String(p.pid),'-o','args='],{encoding:'utf8'}).stdout;
  if(args.includes(fixture)&&args.includes(dir)&&p.pid!==process.pid)try{process.kill(p.pid,'SIGKILL')}catch{}
 }
}
test('independent real guard: hung native stop, cold fallback, coordinator loss and worker restart finish within the same 30s',
 {timeout:45000,skip:process.platform!=='darwin'&&process.platform!=='linux'},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cutover-isolated-'));fs.chmodSync(dir,0o700);let tls,stream,response,ended=false,bytes=0;
 try{
  const values=[];while(values.length<5){const p=await port();if(!values.includes(p))values.push(p)}
  const [primary,legacy,controllerPort,tlsPort,agentPort]=values;
  fs.writeFileSync(dir+'/openssl.cnf','[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\n',{mode:0o600});
  const cert=cp.spawnSync('/usr/bin/openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-sha256','-days','1','-subj','/CN=127.0.0.1','-config',dir+'/openssl.cnf','-keyout',dir+'/key.pem','-out',dir+'/cert.pem'],{encoding:'utf8',timeout:3000});assert.equal(cert.status,0,cert.stderr);
  tls=https.createServer({key:fs.readFileSync(dir+'/key.pem'),cert:fs.readFileSync(dir+'/cert.pem'),minVersion:'TLSv1.2',maxVersion:'TLSv1.2'},(req,res)=>{res.statusCode=req.url==='/google'?204:200;res.end('local-only-proof')});await new Promise(r=>tls.listen(tlsPort,'127.0.0.1',r));
  await new Promise((resolve,reject)=>{let err='';const q=cp.spawn('/usr/bin/curl',['--noproxy','*','--max-time','2','-sS','--cacert',dir+'/cert.pem','https://127.0.0.1:'+tlsPort+'/chatgpt'],{stdio:['ignore','ignore','pipe']});q.stderr.on('data',b=>err+=b);q.once('close',code=>code===0?resolve():reject(Error('Local fixture TLS failed: '+err)))});
  const config=router.engine.apply({proxies:[{name:'fixture-node',type:'ss',server:'127.0.0.1',port:1,cipher:'aes-128-gcm',password:'fixture-only'}],'proxy-groups':[{name:'main',type:'select',proxies:['automatic']},{name:'automatic',type:'url-test',proxies:['fixture-node'],url:'https://example.invalid',interval:0}],rules:['MATCH,main']},{});
  config['mixed-port']=primary;config.listeners=[{name:'legacy',type:'mixed',listen:'127.0.0.1',port:legacy}];
  const vpnId='11111111-2222-4333-8444-555555555555';fs.writeFileSync(dir+'/fixture.json',JSON.stringify({port:primary,compatibilityPort:legacy,controllerPort,tlsPort,agentPort,vpnId,routing:config,fallbackDelayMs:10000}),{mode:0o600});
  start(dir,'agent');await until(()=>rows(dir,'agent-').length);
  stream=http.get({host:'127.0.0.1',port:agentPort},res=>{response=res;res.on('data',b=>bytes+=b.length);res.on('close',()=>ended=true)});stream.on('error',()=>ended=true);await until(()=>bytes>0);
  const agent=rows(dir,'agent-')[0];start(dir,'gui','target');await until(()=>rows(dir,'target-core-').length);
  const gui=rows(dir,'target-gui-')[0],core=rows(dir,'target-core-')[0];
  const plan={version:1,port:primary,compatibilityPorts:[legacy],uiPrepared:true,compatibilityVerified:true,fallback:{client:'verge',app:'/Applications/Clash Verge.app',config,transport:{url:'http://127.0.0.1:'+controllerPort},network:[],selections:{main:'automatic',automatic:'fixture-node'},processes:[]},target:{client:'clash-app',vpnId,transport:{url:'http://127.0.0.1:'+controllerPort},processes:[{...gui,exe:mac.NATIVE},{...core,exe:mac.EXT}]}};
  const token='fixture-generation',startedAt=monotonicMs();fs.writeFileSync(dir+'/plan.json',JSON.stringify(plan),{mode:0o600});fs.writeFileSync(dir+'/journal.json',JSON.stringify({version:1,phase:'prepared',token,preparedAt:startedAt,startedAt,deadline:startedAt+30000}),{mode:0o600});
  const coordinator=start(dir,'coordinator');await until(()=>rows(dir,'guard-driver-').length);await new Promise(r=>coordinator.exitCode!==null?r():coordinator.once('exit',r));
  // Kill the guard only after its launch intent and cold fallback GUI are durable.
  await until(()=>rows(dir,'fallback-gui-').length,18000);const first=rows(dir,'guard-driver-')[0];assert(alive(first));process.kill(first.pid,'SIGKILL');
  const restart=start(dir,'guard');
  const final=await until(()=>{const j=JSON.parse(fs.readFileSync(dir+'/journal.json','utf8'));return ['fallback-verified','failed'].includes(j.phase)?j:null},30000);
  assert.equal(final.phase,'fallback-verified',JSON.stringify(final));assert(final.elapsedMs<30000,'must not renew the clock after worker loss');assert(final.elapsedMs>=19000,'exercise the real cold-start reserve');
  await until(()=>restart.exitCode!==null);
  assert(alive(agent),'unrelated agent process identity must survive');assert.equal(ended,false,'unrelated agent long-lived connection must survive');assert(bytes>1000);
  const events=fs.readFileSync(dir+'/events.log','utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(events.filter(e=>e.name==='fallback-open-requested').length,1,'restart must resume the same fallback');
  assert(!alive(gui)&&!alive(core));assert(rows(dir,'helper-hang-').every(p=>!alive(p)),'all cancelled stop helpers must exit');
  console.log(JSON.stringify({isolated:true,elapsedMs:final.elapsedMs,compatibilityHttpAndSocks:true,coordinatorExited:true,guardRestarted:true,unrelatedAgentStreamPreserved:true,liveProxyPortsUntouched:true}));
 }catch(error){if(fs.existsSync(dir+'/events.log'))console.log(fs.readFileSync(dir+'/events.log','utf8').slice(-6000));throw error}finally{stream?.destroy();response?.destroy();await cleanup(dir);tls?.closeAllConnections();if(tls)await new Promise(r=>tls.close(r));fs.rmSync(dir,{recursive:true,force:true})}
});
