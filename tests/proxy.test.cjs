'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const dir=path.resolve(__dirname,'../skills/clash-smart-routing'),c=require(dir+'/scripts/proxy-context.cjs'),manager=require(dir+'/scripts/proxy-manager.cjs'),install=require(dir+'/scripts/proxy-install.cjs'),safety=require(dir+'/scripts/proxy-safety.cjs');
const active={status:'active',root:'/private/config',app:'/Applications/FlClash.app',appName:'FlClash',pid:123};
const proxy=port=>Object.fromEntries(['http','https','socks'].map(k=>[k,{enabled:true,host:'127.0.0.1',port}]));
function deps(live,extra={}){return {select:()=>active,load:()=>({}),api:()=>async()=>live,owns:()=>true,listener:()=>true,systemProxy:()=>proxy(live['mixed-port']||live.port),...extra}}
test('proxy discovers live mixed and separate ports rather than saved or fixed values',async()=>{
 const a=await c.discover(deps({'mixed-port':17890}));assert.equal(a.phase,'ready');assert.deepEqual(a.ports,{http:17890,socks:17890});assert.equal(a.systemProxy.matches,true);
 const b=await c.discover(deps({port:17897,'socks-port':17898},{systemProxy:()=>({...proxy(17897),socks:{enabled:true,host:'localhost',port:17898}})}));assert.deepEqual(b.ports,{http:17897,socks:17898});assert.equal(b.systemProxy.matches,true);assert.notEqual(a.generation,b.generation);
 const httpOnly=await c.discover(deps({port:12345}));assert.equal(c.variables(httpOnly,{noProxy:['localhost']}).ALL_PROXY,null);
});
test('proxy refuses foreign listeners, invalid ports, unavailable API and ambiguous Apps',async()=>{
 for(const extra of [{owns:()=>false},{listener:()=>false},{api:()=>async()=>{throw Error('not ready')}}])assert.equal((await c.discover(deps({'mixed-port':17890},extra))).phase,'starting');
 assert.equal((await c.discover(deps({'mixed-port':70000}))).phase,'starting');
 for(const status of ['no-running-client','ambiguous-running-clients']){const s=await c.discover({select:()=>({status})});assert.equal(s.phase,status);assert.ok(Object.values(c.variables(s)).every(x=>x===null));}
});
test('proxy synchronizes eight launchd variables transactionally and preserves manual changes',()=>{
 const current=Object.fromEntries(c.KEYS.map(k=>[k,null])),baseline={...current};let calls=[];
 const ops=(op,k,v)=>{if(op==='getenv')return current[k];calls.push([op,k,v]);current[k]=op==='unsetenv'?null:v};
 const state={phase:'ready',ports:{http:17890,socks:17891}},values=c.variables(state,{noProxy:['localhost','.lan']});
 const first=c.syncLaunchd(values,ops,null);assert.equal(first.ok,true);assert.deepEqual(current,values);assert.equal(calls.length,8);
 calls=[];assert.equal(c.syncLaunchd(values,ops,first.ownership).changed,false);assert.equal(calls.length,0);
 current.https_proxy='http://manual:99';assert.equal(c.syncLaunchd(values,ops,first.ownership).conflict,true);assert.equal(calls.length,0);
 c.restoreLaunchd(ops,first.ownership);assert.equal(current.https_proxy,'http://manual:99');assert.equal(current.http_proxy,null);
 Object.assign(current,baseline);let fail=true;const failing=(op,k,v)=>{if(op==='setenv'&&k==='all_proxy'&&fail){fail=false;throw Error('denied')}return ops(op,k,v)};
 assert.throws(()=>c.syncLaunchd(values,failing,null),/denied/);assert.deepEqual(current,baseline);
});
test('generated shell uses allowlisted variables, escapes values and rejects injected bypass entries',()=>{
 const code=c.shell({phase:'ready',ports:{http:18888,socks:18889},generation:"a'b"},{noProxy:['localhost','10.0.0.0/8']});
 const r=cp.spawnSync('/bin/sh',['-c',code+'\nprintf "%s\\n" "$PROXY_CONTEXT" "$HTTPS_PROXY"'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,"a'b\nhttp://127.0.0.1:18888\n");
 assert.throws(()=>c.noProxy(['$(touch /tmp/unsafe)']),/Invalid/);
 assert.equal(c.noProxy(['localhost','localhost','.lan']),'localhost,.lan');
 assert.ok(!Object.keys(c.cleanEnv({HTTP_PROXY:'x',PROXY_CONTEXT:'x',KEEP:'1'})).some(k=>k!=='KEEP'));
});
test('zsh loader preserves unrelated configuration and remains idempotent',()=>{
 const original='custom-before\n[[ -r ~/.config/zsh/proxy.zsh ]] && source ~/.config/zsh/proxy.zsh\n# syntax highlighting last\ncustom-after\n';
 const result=install.updateZshrc(original);assert.ok(result.indexOf('# >>> proxy')<result.indexOf('# syntax'));assert.ok(result.startsWith('custom-before\n'));assert.ok(result.endsWith('custom-after\n'));assert.equal(install.updateZshrc(result),result);
 assert.deepEqual(install.legacyNoProxy("local bypass='localhost,.example.internal,10.0.0.0/8'"),['localhost','.example.internal','10.0.0.0/8']);
});
test('idle fallback is 15s and rapid startup polling stops at 15s',()=>{
 assert.equal(manager.delayFor({phase:'ready'},0,2000),15000);
 assert.equal(manager.delayFor({phase:'starting'},0,14999),250);
 assert.equal(manager.delayFor({phase:'starting'},0,15000),15000);
 assert.equal(manager.delayFor({phase:'no-running-client'},0,1),15000);
});
test('installation refuses unmanaged commands and rollback retains later user edits',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-safe-'));try{
 const p=Object.fromEntries(['binary','oldBinary','loader'].map(k=>[k,path.join(temp,k)]));fs.writeFileSync(p.binary,'user script');assert.throws(()=>install.checkOwnership(p),/not managed/);
 const file=path.join(temp,'owned'),backup=path.join(temp,'backup');fs.writeFileSync(file,'before',{mode:0o755});fs.copyFileSync(file,backup);
 const crypto=require('node:crypto'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 fs.writeFileSync(path.join(temp,'journal.json'),JSON.stringify({phase:'installing',deadline:Date.now()+10000,entries:[{file,backup,original:{exists:true,hash:hash('before'),mode:0o755},expected:{exists:true,hash:hash('before')}}]}));
 safety.write(temp,file,'installed',0o600);assert.deepEqual(await safety.restoreFiles(temp),[]);assert.equal(fs.readFileSync(file,'utf8'),'before');assert.equal(fs.statSync(file).mode&0o777,0o755);
 safety.write(temp,file,'installed');fs.writeFileSync(file,'user change');assert.deepEqual(await safety.restoreFiles(temp),[file]);assert.equal(fs.readFileSync(file,'utf8'),'user change');
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
test('zsh terminal opt-out stays off while other shells follow updated state',{skip:!fs.existsSync('/bin/zsh')},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-shell-'));try{
 const env=path.join(temp,'shell-env.zsh');fs.writeFileSync(env,c.shell({phase:'ready',ports:{http:17890,socks:17890}},{noProxy:['localhost']}));
 const code='source "$ASSET"\nprint "$HTTPS_PROXY"\nproxy off >/dev/null\n_proxy_refresh\nprint "${HTTPS_PROXY-unset}:$PROXY_SHELL_MODE"\n';
 const r=cp.spawnSync('/bin/zsh',['-f','-c',code],{encoding:'utf8',env:{...c.cleanEnv(),PROXY_HOME:temp,ASSET:path.join(dir,'assets/proxy-shell.zsh')}});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'http://127.0.0.1:17890\nunset:off\n');
 fs.writeFileSync(env,c.shell({phase:'ready',ports:{http:17897,socks:17897}},{noProxy:['localhost']}));
 const other=cp.spawnSync('/bin/zsh',['-f','-c','source "$ASSET"; print "$HTTPS_PROXY"'],{encoding:'utf8',env:{...c.cleanEnv(),PROXY_HOME:temp,ASSET:path.join(dir,'assets/proxy-shell.zsh')}});assert.equal(other.stdout,'http://127.0.0.1:17897\n');
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
test('unified proxy launcher forwards arguments literally and resolves an installed skill',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-cli-'));try{
 const bin=path.join(temp,'bin'),codex=path.join(temp,'codex home'),scripts=path.join(codex,'skills/clash-smart-routing/scripts');fs.mkdirSync(bin);fs.mkdirSync(scripts,{recursive:true});
 fs.copyFileSync(path.join(dir,'scripts/proxy'),path.join(bin,'proxy'));fs.writeFileSync(path.join(scripts,'proxy-cli.cjs'),'');fs.writeFileSync(path.join(bin,'node'),'#!/bin/sh\nprintf "%s\\n" "$@"\n',{mode:0o755});
 const args=['exec','--','program','a b','$(literal)'];
 const r=cp.spawnSync('/bin/sh',[path.join(bin,'proxy'),...args],{encoding:'utf8',env:{...process.env,CODEX_HOME:codex,PATH:bin+path.delimiter+process.env.PATH}});assert.equal(r.status,0,r.stderr);assert.deepEqual(r.stdout.trimEnd().split('\n'),[path.join(scripts,'proxy-cli.cjs'),...args]);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});
test('launchctl normalizes successful empty getenv output as unset',()=>{
 const original=cp.spawnSync;try{cp.spawnSync=()=>({status:0,stdout:'\n'});assert.equal(c.launchctl('getenv','http_proxy'),null);cp.spawnSync=()=>({status:1,stdout:''});assert.equal(c.launchctl('getenv','http_proxy'),null);assert.throws(()=>c.launchctl('setenv','UNRELATED','x'),/Unexpected/)}finally{cp.spawnSync=original}
});
test('public all-in-one subcommands expose their actual callable entry points',()=>{
 assert.equal(typeof require(dir+'/scripts/traffic-audit.cjs').main,'function');assert.equal(typeof require(dir+'/scripts/shadowrocket.cjs').main,'function');
});
test('setup ignores stale runtime state from a previous manager generation',()=>{
 const state={phase:'ready',managerPid:123,selection:{root:'/a'},launchd:{ok:true}};
 assert.equal(install.managerReady(state,{running:true,pid:123},'/a'),true);
 for(const service of [{running:false,pid:123},{running:true,pid:null},{running:true,pid:456}])assert.equal(install.managerReady(state,service,'/a'),false);
 assert.equal(install.managerReady(state,{running:true,pid:123},'/b'),false);
});
