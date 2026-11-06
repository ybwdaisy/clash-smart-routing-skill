'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const base='../skills/clash-smart-routing/scripts/',native=require(base+'clash-app-client.cjs'),active=require(base+'active-client.cjs'),context=require(base+'proxy-context.cjs');
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'clash-native-test-'));
const vpnId='11111111-2222-3333-4444-555555555555';
test('native GUI and surviving packet tunnel identify one app; wrong identity and multiple apps pause',()=>{
 const app='/Applications/Clash.app',gui=app+'/Contents/MacOS/Clash',ext=app+'/Contents/PlugIns/ClashmacOSExtension.appex/Contents/MacOS/ClashmacOSExtension',roots=['/private/com.hako.network'];
 for(const p of ['1 '+gui+'\n2 '+ext,'2 '+ext+'\n1 '+gui]){const s=active.detect(roots,{processes:p,bundleId:()=>native.ID});assert.equal(s.client,'clash-app');assert.equal(s.pid,1)}
 assert.equal(active.detect(roots,{processes:'2 '+ext,bundleId:()=>native.ID}).status,'active');
 assert.equal(active.detect(roots,{processes:'1 '+gui,bundleId:()=> 'wrong.app'}).status,'paused-unconfigured-client');
 assert.equal(active.detect(roots,{processes:'1 '+gui+'\n3 /Applications/Clash Verge.app/Contents/MacOS/clash-verge',bundleId:()=>native.ID}).status,'paused-multiple-clients');
});
test('pairing requires explicit native VPN permission and private authenticated loopback',()=>{
 const root=dir(),secretFile=path.join(root,'secret');fs.writeFileSync(secretFile,'test-private-controller-secret');
 try{assert.throws(()=>native.register({dir:root,controller:'http://127.0.0.1:9090',secretFile}),/authorization/);
 for(const controller of ['https://127.0.0.1:9090','http://example.com:9090','http://user@localhost:9090','http://localhost:9090/path','http://localhost:9090?secret=x'])assert.throws(()=>native.register({dir:root,controller,secretFile,allowNativeVpn:true}));
 const result=native.register({dir:root,controller:'http://127.0.0.1:9090',secretFile,allowNativeVpn:true});assert.equal(result.paired,true);assert.ok(!JSON.stringify(result).includes('test-private'));assert.equal(fs.statSync(path.join(root,'native.json')).mode&0o777,0o600);
 const ctx=native.load(root);assert.equal(ctx.capabilities.learning,false);assert.equal(ctx.sourceEvidenceKind,'controller-observation');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('observed policy excludes temporary selection but detects membership and rules changes',()=>{
 const rules=[{type:'RuleSet',payload:'smart-routing-cn',proxy:'DIRECT'},{type:'DomainSuffix',payload:'example.com',proxy:'Main'},{type:'Match',proxy:'Main'}];
 const proxies={Main:{type:'Selector',all:['Auto'],now:'Auto'},Auto:{type:'URLTest',all:['US','JP'],now:'US',fixed:'US',testUrl:'https://test.invalid'},US:{type:'SS'},JP:{type:'SS'}};
 const first=native.policy(rules,proxies);proxies.Auto.now='JP';proxies.Auto.fixed='JP';assert.deepEqual(native.policy(rules,proxies),first);
 proxies.Auto.all.push('TW');assert.notDeepEqual(native.policy(rules,proxies),first);assert.equal(first.observedRules.length,2);assert.deepEqual(first.rules,['MATCH,Main']);
 assert.throws(()=>native.policy([],proxies),/fallback/);
});
test('native API verifies capabilities, blocks reload and provider writes, observes live ports and permits pin',async()=>{
 const root=dir(),seen=[];let valid=true;
 const server=http.createServer((req,res)=>{seen.push([req.method,req.url]);if(req.headers.authorization!=='Bearer test-private-controller-secret'){res.writeHead(401);return res.end('{}')};res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify(req.url==='/clash/v1/capabilities'?{api:valid?1:2,platform:'macos'}:req.url==='/configs'?{port:17890,'socks-port':17891,mode:'rule'}:req.url==='/proxies'?{proxies:{Main:{type:'Selector',all:['Auto']},Auto:{type:'URLTest',all:['US']},US:{type:'SS'}}}:req.url==='/rules'?{rules:[{type:'Match',proxy:'Main'}]}:{}));});
 await new Promise(y=>server.listen(0,'127.0.0.1',y));
 try{const secretFile=path.join(root,'secret');fs.writeFileSync(secretFile,'test-private-controller-secret');native.register({dir:root,controller:'http://127.0.0.1:'+server.address().port,secretFile,allowNativeVpn:true});
 const ctx=native.load(root),api=native.controller(ctx,{followActive:false});await api('GET','/configs');await api('GET','/proxies');assert.equal(ctx.config.port,17890);assert.equal(native.load(root).config['socks-port'],17891);assert.ok(fs.existsSync(ctx.subscriptionFile));
 for(const route of ['/configs','/providers/rules/smart-routing-cn'])await assert.rejects(api('PUT',route,{}),/unavailable/);
 await api('PUT','/proxies/Auto',{name:'US'});assert.equal(seen.at(-1)[0],'PUT');assert.ok(!seen.some(([m,u])=>m==='PUT'&&u==='/configs'));
 let selected=true;const following=native.controller(ctx,{followActive:true,activeCheck:()=>{if(!selected)throw Error('Client changed')}});await following('GET','/configs');selected=false;const before=seen.length;await assert.rejects(following('PUT','/proxies/Auto',{name:'US'}),/Client changed/);assert.equal(seen.length,before);
 valid=false;await assert.rejects(native.controller(ctx)('GET','/configs'),/not a supported/);
 }finally{server.closeAllConnections();await new Promise(y=>server.close(y));fs.rmSync(root,{recursive:true,force:true})}
});
test('native VPN stop targets the bundle-matched service and preserves OpenVPN',async()=>{
 const listing='* (Connected) 99999999-2222-3333-4444-555555555555 VPN (org.openvpn.client.app) "Clash"\n* (Connected) '+vpnId+' VPN (com.hako.network) "Clash"';
 assert.equal(native.vpnService(listing).id,vpnId);assert.throws(()=>native.vpnService(listing+'\n'+listing),/uniquely/);
 const calls=[];let stopped=false;const result=await native.disconnect({status:()=>({id:vpnId,status:stopped?'Disconnected':'Connected'}),spawn:(command,args)=>{calls.push(args);stopped=true;return {status:0}}});
 assert.equal(result.status,'Disconnected');assert.deepEqual(calls,[['--nc','stop',vpnId]]);
 await assert.rejects(native.disconnect({status:()=>{const e=Error('ambiguous');e.code='AMBIGUOUS_VPN';throw e}}),/ambiguous/);
});
test('native GUI readiness needs both owned live listener and connected VPN, independent of HTTP proxy',async()=>{
 const deps={select:()=>({status:'active',root:'/native',app:'/Applications/Clash.app',client:'clash-app'}),load:()=>({client:'clash-app',config:{rules:['MATCH,Main']},capabilities:{learning:false}}),api:()=>async()=>({port:17890}),listener:()=>true,owns:()=>true,systemProxy:()=>({}),vpnStatus:()=>({connected:true,status:'Connected'})};
 const state=await context.discover(deps);assert.equal(state.phase,'ready');assert.equal(state.transport,'native-vpn');assert.equal(state.systemProxy.matches,false);assert.equal(context.guiReady(state),true);
 assert.equal((await context.discover({...deps,vpnStatus:()=>({connected:false})})).phase,'starting');assert.equal((await context.discover({...deps,owns:()=>false})).phase,'starting');
});
test('native script export preserves original rule order and previous script; export is not activation',()=>{
 const root=dir();try{const result=native.exportScript(root,'function main(config){config.custom=true;return config}');assert.equal(result.requiresNativeImport,true);
 const box={};vm.runInNewContext(fs.readFileSync(result.file,'utf8'),box);const input={proxies:[{name:'US',type:'ss'}],'proxy-groups':[{name:'Main',type:'select',proxies:['US']}],rules:['DOMAIN,foreign.example,Main','MATCH,Main']};const output=box.main(input);assert.equal(output.custom,true);assert.deepEqual(Array.from(output.rules.slice(-2)),['DOMAIN,foreign.example,Main','MATCH,Main']);assert.ok(output.rules[0].includes('ai-guard'));assert.ok(!output['rule-providers']['smart-routing-learned']);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('native plan is read-only and rejects recursively composing its managed export',async()=>{
 const root=dir();try{const result=await native.main('plan',{root});assert.equal(result.requiresNativeImport,true);assert.deepEqual(fs.readdirSync(root),[]);const generated=native.exportScript(root);assert.throws(()=>native.exportScript(root,fs.readFileSync(generated.file,'utf8')),/original user script/);}finally{fs.rmSync(root,{recursive:true,force:true})}
});
