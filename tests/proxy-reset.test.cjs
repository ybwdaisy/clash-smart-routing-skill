'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const base=path.resolve(__dirname,'../skills/clash-smart-routing'),reset=require(base+'/scripts/proxy-reset.cjs'),shell=require(base+'/scripts/proxy-clean-shell.cjs'),safety=require(base+'/scripts/proxy-safety.cjs'),Y=require(base+'/node_modules/yaml');
function fixture(){const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'proxy-fresh-'))),root=path.join(home,'Library/Application Support/test.clash-verge'),proxyHome=path.join(home,'.config/proxy');function write(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
 const registry={current:'subscription',items:[{uid:'subscription',type:'remote',file:'sub.yaml',url:'https://provider.invalid/private-token',option:{merge:'Merge',script:'Script',login_password:'fixture-only-secret'}},{uid:'Merge',type:'merge',file:'Merge.yaml'},{uid:'Script',type:'script',file:'Script.js'},{uid:'Rules',type:'rules',file:'Rules.yaml'}]};
 write(path.join(root,'profiles.yaml'),Y.stringify(registry));write(path.join(root,'profiles/sub.yaml'),'proxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]\n');write(path.join(root,'profiles/Merge.yaml'),'dns: {enable: true}\nrules: [DOMAIN,old.invalid,REJECT]\n');write(path.join(root,'profiles/Script.js'),'function main(c) {c.old = true; return c;}');write(path.join(root,'profiles/Rules.yaml'),'prepend: [DOMAIN,old.invalid,DIRECT]\n');write(path.join(root,'config.yaml'),'mixed-port: 17890\nsecret: fixture-only-controller\nexternal-controller: 127.0.0.1:9090\ndns: {enable: true}\nhosts: {old.invalid: 1.1.1.1}\ntun: {enable: true}\n');write(path.join(root,'verge.yaml'),'theme_mode: dark\nverge_mixed_port: 17890\nenable_system_proxy: false\nenable_tun_mode: true\n');write(path.join(root,'dns_config.yaml'),'hosts: {old.invalid: 2.2.2.2}\n');write(path.join(root,'smart-routing-state/settings.json'),'{"upstreamGroup":"legacy","preferredNode":"old"}');write(path.join(proxyHome,'settings.json'),'{"noProxy":["old.invalid"]}');write(path.join(home,'.config/zsh/proxy.zsh'),'# old user script\nproxy() { export https_proxy="http://127.0.0.1:7890"; }\nexport KEEP_ME=ok\n');write(path.join(home,'.zshrc'),'export EDITOR=vim\nexport HTTP_PROXY="http://127.0.0.1:7890"\nalias proxy="old-command"\n[[ -r "$HOME/.config/zsh/proxy.zsh" ]] && source "$HOME/.config/zsh/proxy.zsh"\nsource "$HOME/.old-network.zsh"\n');write(path.join(home,'.old-network.zsh'),'export ALL_PROXY="socks5h://localhost:7890"\nexport OTHER=keep\n');write(path.join(home,'.local/bin/proxy'),'#!/bin/sh\necho old\n');const plist='<plist><dict><key>Label</key><string>local.old-proxy</string><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>HTTPS_PROXY</string><string>http://127.0.0.1:7890</string></array></dict></plist>';write(path.join(home,'Library/LaunchAgents/local.old-proxy.plist'),plist);return {home,root,proxyHome,env:{PATH:path.join(home,'.local/bin')},write,done:()=>fs.rmSync(home,{recursive:true,force:true})};}
function snap(dir){const result={};function walk(p){for(const x of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,x.name);if(x.isDirectory())walk(f);else result[path.relative(dir,f)]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}}walk(dir);return result}
test('fresh shell cleanup removes proxy definitions and exports while retaining unrelated settings',()=>{
 const input='export EDITOR=vim HTTPS_PROXY="http://localhost:1234" OTHER="a b"\nproxy() { print "}"; export all_proxy="socks5://localhost:1234"; }\nalias proxy="old" ll="ls -la"\nunalias proxy ll\nlaunchctl setenv HTTP_PROXY http://localhost:1234\nexport KEEP=1\n';
 const result=shell.clean(input);assert.deepEqual(result.issues,[]);assert.doesNotMatch(result.text,/HTTPS_PROXY|all_proxy|old|launchctl/);assert.match(result.text,/EDITOR=vim/);assert.match(result.text,/OTHER="a b"/);assert.match(result.text,/alias ll="ls -la"/);assert.match(result.text,/unalias ll/);assert.match(result.text,/KEEP=1/);
});
test('ambiguous proxy logic is reported instead of deleting a mixed-purpose function',()=>{
 const input='function init_everything() {\n  export HTTP_PROXY=http://localhost:1\n  export KEEP=1\n}\n';const result=shell.clean(input);assert.ok(result.issues.length);assert.match(result.text,/init_everything/);assert.match(result.text,/KEEP=1/);
 assert.ok(shell.clean('if test -f /tmp/foo; then export HTTP_PROXY=x; fi').issues.length);
});
test('fresh plan is read-only, inventories literal sourced files and redacts private contents',()=>{
 const f=fixture();try{const before=snap(f.home),p=reset.plan(f),report=reset.summary(p);assert.deepEqual(report.issues,[]);assert.equal(report.ready,true);assert.deepEqual(snap(f.home),before);assert.ok(p.edits.some(x=>x.file.endsWith('.old-network.zsh')));assert.ok(p.edits.some(x=>x.kind==='old-service'));assert.equal(report.subscriptionsPreserved,1);assert.doesNotMatch(JSON.stringify(report),/private-token|fixture-only/);assert.equal(p.loaderRemainder.trim(),'# old user script\n\nexport KEEP_ME=ok');}finally{f.done()}
});
test('fresh cleanup backs up every edit, preserves client/subscriptions and can restore exact original bytes',async()=>{
 const f=fixture();try{const before=snap(f.home),p=reset.plan(f),journal=path.join(f.home,'transaction');fs.mkdirSync(journal);safety.save(journal,{phase:'installing',deadline:Date.now()+10000,entries:[]});reset.apply(p,journal);
 assert.equal(reset.verifySubscriptions(p),true);assert.equal(fs.readFileSync(path.join(f.root,'profiles.yaml'),'utf8').includes('fixture-only-secret'),true);
 assert.equal(fs.readFileSync(path.join(f.root,'profiles/Script.js'),'utf8'),reset.neutral('script'));assert.deepEqual(Y.parse(fs.readFileSync(path.join(f.root,'profiles/Merge.yaml'),'utf8')),{});
 assert.equal(fs.existsSync(path.join(f.home,'.local/bin/proxy')),false);assert.equal(fs.existsSync(path.join(f.home,'Library/LaunchAgents/local.old-proxy.plist')),false);
 const core=Y.parse(fs.readFileSync(path.join(f.root,'config.yaml'),'utf8'));assert.equal(core['mixed-port'],17890);assert.equal(core.secret,'fixture-only-controller');assert.equal(core.dns,undefined);assert.equal(core.hosts,undefined);assert.equal(core.tun.enable,false);
 const prefs=Y.parse(fs.readFileSync(path.join(f.root,'verge.yaml'),'utf8'));assert.equal(prefs.theme_mode,'dark');assert.equal(prefs.enable_tun_mode,false);assert.equal(prefs.enable_system_proxy,true);
 assert.match(fs.readFileSync(path.join(f.home,'.old-network.zsh'),'utf8'),/OTHER=keep/);assert.doesNotMatch(fs.readFileSync(path.join(f.home,'.old-network.zsh'),'utf8'),/ALL_PROXY/);
 assert.deepEqual(await safety.restoreFiles(journal),[]);fs.rmSync(journal,{recursive:true});assert.deepEqual(snap(f.home),before);
 }finally{f.done()}
});
test('a changed input aborts before cleanup and subscription aliases/traversal are rejected',()=>{
 const f=fixture();try{const p=reset.plan(f);fs.appendFileSync(path.join(f.home,'.zshrc'),'# later edit\n');assert.throws(()=>reset.apply(p,'unused'),/changed after preview/);assert.equal(fs.existsSync(path.join(f.home,'.local/bin/proxy')),true);
 const file=path.join(f.root,'profiles.yaml'),v=Y.parse(fs.readFileSync(file,'utf8'));v.items[1].file='sub.yaml';fs.writeFileSync(file,Y.stringify(v));assert.throws(()=>reset.plan(f),/aliases a subscription/);v.items[1].file='../elsewhere';fs.writeFileSync(file,Y.stringify(v));assert.throws(()=>reset.plan(f),/Unsafe profile/);
 }finally{f.done()}
});
test('symlinks are never silently replaced and mixed-purpose LaunchAgents require review',()=>{
 const f=fixture();try{fs.symlinkSync(path.join(f.home,'.zshrc'),path.join(f.home,'.zprofile'));assert.throws(()=>reset.plan(f),/regular file/);fs.unlinkSync(path.join(f.home,'.zprofile'));
 f.write(path.join(f.home,'Library/LaunchAgents/local.proxy-and-work.plist'),'<plist><dict><key>Label</key><string>local.proxy-and-work</string><key>ProgramArguments</key><array><string>/usr/bin/something-unrelated</string></array></dict></plist>');const p=reset.plan(f);assert.ok(p.issues.some(x=>x.includes('Unrecognized proxy LaunchAgent')));assert.ok(!p.edits.some(x=>x.file.endsWith('local.proxy-and-work.plist')));
 }finally{f.done()}
});
module.exports={fixture};
const cp=require('node:child_process'),http=require('node:http'),router=require(base+'/scripts/clash-router.cjs');
const core=process.env.MIHOMO_TEST_BIN||'/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
const cacheRoot=process.env.MIHOMO_TEST_CACHE||path.join(os.homedir(),'Library/Application Support/io.github.fqfqgo.clash-verge-for-v2free');
test('real kernel accepts rebuilt routing and a late apply failure restores pre-cleanup files',{
 skip:!fs.existsSync(core)||!fs.existsSync(path.join(cacheRoot,'ruleset/smart-routing'))
},async()=>{
 const f=fixture(),socketDir=fs.mkdtempSync('/tmp/proxy-fresh-sock-'),wait=ms=>new Promise(y=>setTimeout(y,ms));let child;const reserve=http.createServer();
 try{
  await new Promise(y=>reserve.listen(0,'127.0.0.1',y));const port=reserve.address().port;await new Promise(y=>reserve.close(y));
  const subscription={proxies:[{name:'fixture-node',type:'ss',server:'127.0.0.1',port:1,cipher:'aes-128-gcm',password:'fixture-only'}],'proxy-groups':[{name:'main',type:'select',proxies:['automatic']},{name:'automatic',type:'url-test',url:'https://example.invalid/',interval:0,proxies:['fixture-node']}],rules:['DOMAIN,original.invalid,DIRECT','MATCH,main']};
  f.write(path.join(f.root,'profiles/sub.yaml'),Y.stringify(subscription));f.write(path.join(f.root,'config.yaml'),Y.stringify({'mixed-port':port,'external-controller-unix':path.join(socketDir,'api.sock'),secret:'fixture-only',dns:{enable:true},tun:{enable:true}}));
  const oldRuntime={...subscription,rules:['DOMAIN,legacy.invalid,REJECT',...subscription.rules]};f.write(path.join(f.root,'clash-verge.yaml'),Y.stringify(oldRuntime));
  const originalFiles=snap(f.home),p=reset.plan(f),journal=path.join(f.home,'transaction');fs.mkdirSync(journal);safety.save(journal,{phase:'installing',deadline:Date.now()+60000,entries:[]});reset.apply(p,journal);
  const native=Y.parse(fs.readFileSync(path.join(f.root,'config.yaml'),'utf8')),raw={...native,...subscription};
  // Model native regeneration from neutral extensions; run the generated core
  // configuration through the actual installed Mihomo, not a mocked validator.
  safety.include(journal,path.join(f.root,'clash-verge.yaml'));safety.write(journal,path.join(f.root,'clash-verge.yaml'),Y.stringify(raw));
  const generated=router.engine.apply(JSON.parse(JSON.stringify(raw)),{monitorEnabled:true});
  for(const provider of Object.values(generated['rule-providers']))if(provider.type==='http'){const target=path.resolve(f.root,provider.path),source=path.resolve(cacheRoot,provider.path);assert.ok(fs.existsSync(source),'Public classification cache required');fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target)}
  const options=path.join(f.home,'routing.json');fs.writeFileSync(options,'{"monitorEnabled":true}');
  child=cp.spawn(core,['-d',f.root,'-f',path.join(f.root,'clash-verge.yaml')],{stdio:['ignore','ignore','pipe']});let logs='';child.stderr.on('data',b=>{logs+=b});
  for(let i=0;i<100&&!fs.existsSync(raw['external-controller-unix']);i++)await wait(30);
  let ctx=router.load(f.root),api=router.controller(ctx,{followActive:false});for(let i=0;i<100;i++){try{await api('GET','/version');break}catch{await wait(30)}}
  const io={write:(file,data)=>{safety.include(journal,file);safety.write(journal,file,data)}};
  const applied=await router.apply(ctx,api,{'settings-file':options,core},io);assert.equal(applied.subscriptionUnchanged,true);assert.equal(applied.domesticDirectBeforeSubscription,true);
  ctx=router.load(f.root);assert.deepEqual(ctx.config.rules.filter(x=>!router.engine.managedRule(x)),subscription.rules);assert.doesNotMatch(fs.readFileSync(ctx.scriptFile,'utf8'),/legacy\.invalid|c\.old/);
  assert.equal((await api('GET','/rules')).rules[0].payload,'smart-routing-ai-guard');assert.equal(reset.verifySubscriptions(p),true);
  let injected=false;const failing={write:(file,data)=>{io.write(file,data);if(!injected&&file===path.join(ctx.stateDir,'state.json')){injected=true;throw Error('injected late write failure')}}};
  await assert.rejects(router.apply(ctx,api,{'settings-file':options,core},failing),/injected late write failure/);assert.equal(injected,true);
  await new Promise(y=>{child.once('exit',y);child.kill('SIGTERM')});child=null;
  assert.deepEqual(await safety.restoreFiles(journal),[]);
  for(const [name,digest]of Object.entries(originalFiles))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(f.home,name))).digest('hex'),digest,name);
 }finally{if(child&&child.exitCode===null)await new Promise(y=>{child.once('exit',y);child.kill('SIGTERM')});if(reserve.listening)await new Promise(y=>reserve.close(y));fs.rmSync(socketDir,{recursive:true,force:true});f.done()}
});
test('one setup --fresh call replaces an unmanaged command and rebuilds the complete integration',async()=>{
 const f=fixture(),installer=require(base+'/scripts/proxy-install.cjs'),context=require(base+'/scripts/proxy-context.cjs'),manager=require(base+'/scripts/proxy-manager.cjs'),native=require(base+'/scripts/proxy-system.cjs'),recovery=require(base+'/scripts/node-recovery.cjs'),gui=require(base+'/scripts/proxy-gui.cjs');
 const undo=[],patch=(object,key,value)=>{const old=object[key];object[key]=value;undo.push(()=>object[key]=old)},savedHome=process.env.HOME,savedProxy=process.env.PROXY_HOME;process.env.HOME=f.home;process.env.PROXY_HOME=f.proxyHome;
 let transaction,opened=false,quit=false,applied=false;const labels=[],selection={status:'active',client:'verge',root:f.root,app:'/Applications/Clash Verge.app',appName:'Clash Verge',pid:123};
 try{
  const original={proxies:[{name:'fixture-node',type:'ss'}],'proxy-groups':[{name:'main',type:'select',proxies:['fixture-node']}],rules:['MATCH,main']};f.write(path.join(f.root,'profiles/sub.yaml'),Y.stringify(original));f.write(path.join(f.root,'clash-verge.yaml'),Y.stringify({...original,rules:['DOMAIN,legacy.invalid,REJECT',...original.rules]}));
  patch(router,'activeSelection',()=>selection);patch(manager,'stop',label=>labels.push(label||manager.LABEL));patch(manager,'serviceStatus',()=>({loaded:true,running:true,pid:123}));patch(manager,'launchPlist',()=>'<fixture-manager/>');
  patch(native,'quit',async()=>{quit=true});const spawn=cp.spawnSync;patch(cp,'spawnSync',(command,args,options)=>{if(command==='/usr/bin/open'){assert.equal(quit,true);const nativeCore=Y.parse(fs.readFileSync(path.join(f.root,'config.yaml'),'utf8'));assert.equal(nativeCore.dns,undefined);f.write(path.join(f.root,'clash-verge.yaml'),Y.stringify({...nativeCore,...original}));opened=true;return {status:0}}return spawn(command,args,options)});
  patch(context,'discover',async()=>({phase:'ready',selection,ports:{http:17890,socks:17890},systemProxy:{matches:true}}));
  const vars=Object.fromEntries(context.KEYS.map(k=>[k,'legacy']));patch(context,'launchctl',(action,key,value)=>{if(action==='getenv')return vars[key];vars[key]=action==='unsetenv'?null:value});
  patch(safety,'begin',async(files,options)=>{assert.ok(options.extraAgents.some(a=>a.label==='local.old-proxy'));transaction=path.join(f.home,'transaction');fs.mkdirSync(transaction);safety.save(transaction,{phase:'armed',deadline:Date.now()+30000,entries:[],agents:[],launchd:{}});for(const file of files)safety.include(transaction,file);return transaction});patch(safety,'commit',dir=>{const j=safety.read(dir);safety.save(dir,{...j,phase:'committed'})});
  patch(router,'controller',()=>async()=>({}));patch(router,'verify',async()=>{if(!applied)throw Error('missing overlay');return {}});patch(router,'apply',async(ctx,api,args,io)=>{assert.equal(opened,true);assert.deepEqual(ctx.config.rules,original.rules);assert.equal(JSON.parse(fs.readFileSync(args['settings-file'])).monitorEnabled,true);io.write(ctx.scriptFile,router.render('',{monitorEnabled:true}));io.write(path.join(ctx.stateDir,'state.json'),'{"fresh":true}');applied=true;return {}});
  patch(manager,'install',async()=>{context.write('runtime.json',{phase:'ready',managerPid:123,clientName:'Clash Verge',selection,ports:{http:17890,socks:17890},launchd:{ok:true},eventMode:'events+timer'});return {pid:123,events:true}});patch(recovery,'main',async()=>({status:'public-endpoint-ok'}));patch(gui,'probe',async()=>({ok:true}));
  await assert.rejects(installer.setup({platform:'darwin'}),/not managed/);
  const result=await installer.setup({fresh:true,platform:'darwin'});assert.equal(result.installed,true);assert.equal(result.fresh,true);assert.equal(result.cleanup.subscriptionsUnchanged,true);assert.equal(result.verification.gui,true);assert.ok(labels.includes('local.old-proxy'));
  const loader=fs.readFileSync(path.join(f.home,'.config/zsh/proxy.zsh'),'utf8');assert.match(loader,/KEEP_ME=ok/);assert.match(loader,/proxy-shell.zsh/);assert.doesNotMatch(loader,/https_proxy/);
  assert.match(fs.readFileSync(path.join(f.home,'.local/bin/proxy'),'utf8'),/Managed by clash-smart-routing/);assert.equal(context.read('installation.json').first,transaction);assert.ok(context.settings().noProxy.every(x=>x!=='old.invalid'));
 }finally{for(const restore of undo.reverse())restore();if(savedHome===undefined)delete process.env.HOME;else process.env.HOME=savedHome;if(savedProxy===undefined)delete process.env.PROXY_HOME;else process.env.PROXY_HOME=savedProxy;f.done()}
});
test('source guards preserve unrelated commands and complex proxy functions require review',()=>{
 const loader='/home/user/.config/zsh/proxy.zsh',home='/home/user';
 const ordinary=shell.clean('[[ -r "$HOME/.config/zsh/proxy.zsh" ]] && source "$HOME/.config/zsh/proxy.zsh"',{home,loader});assert.equal(ordinary.text,'');assert.deepEqual(ordinary.issues,[]);
 const mixed=shell.clean('initialize_unrelated && source "$HOME/.config/zsh/proxy.zsh"',{home,loader});assert.ok(mixed.issues.length);assert.match(mixed.text,/initialize_unrelated/);
 const heredoc=shell.clean('proxy() {\n cat <<END\n}\nEND\n}\n');assert.ok(heredoc.issues.length);assert.match(heredoc.text,/cat/);
 const plugins=shell.clean('plugins=(git proxy zsh-autosuggestions)');assert.equal(plugins.text,'plugins=(git  zsh-autosuggestions)');
});
test('a proxy-named startup script with unrelated work is not removed',()=>{
 const f=fixture();try{const file=path.join(f.home,'proxy-start.sh');f.write(file,'#!/bin/sh\nlaunchctl setenv HTTP_PROXY http://localhost:1\necho unrelated-work\n');f.write(path.join(f.home,'Library/LaunchAgents/local.proxy-mixed.plist'),'<plist><dict><key>Label</key><string>local.proxy-mixed</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>'+file+'</string></array></dict></plist>');const p=reset.plan(f);assert.ok(p.issues.some(x=>x.includes('local.proxy-mixed')));assert.ok(!p.edits.some(x=>x.file===file));}finally{f.done()}
});
test('replanning after shutdown never adopts concurrent unrelated shell edits',()=>{
 const f=fixture();try{const before=reset.plan(f);fs.appendFileSync(path.join(f.home,'.zshrc'),'export NEW_USER_SETTING=1\n');const after=reset.plan(f);assert.throws(()=>reset.recheck(before,after),/changed during shutdown/);assert.equal(fs.existsSync(path.join(f.home,'.local/bin/proxy')),true);}finally{f.done()}
});
