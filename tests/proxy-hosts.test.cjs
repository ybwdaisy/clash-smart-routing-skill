'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const scripts=path.resolve(__dirname,'../skills/clash-smart-routing/scripts'),context=require(scripts+'/proxy-context.cjs');
const ready={phase:'ready',ports:{http:17890,socks:17890},generation:'hosts-fixture'};

test('hosts bypass reads active IPv4/IPv6 aliases and preserves manual entries',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-hosts-')),hosts=path.join(root,'hosts');
 try{
  fs.writeFileSync(hosts,'# 10.0.0.1 disabled.test\r\n127.0.0.1 localhost\r\n10.0.0.2 Service.test alias.test # comment.test\n::1 ipv6.test\n2001:db8::1 public-v6.test\n203.0.113.2 public.test.\ninvalid ignored.test\n10.0.0.3 service.test *.wild.test bad/alias $(invalid)\n');
  assert.deepEqual(context.hostsNames(hosts),['localhost','service.test','alias.test','ipv6.test','public-v6.test','public.test']);
  const config={noProxy:['localhost','manual.test'],noProxyHostsFile:hosts},values=context.variables(ready,config);
  assert.equal(values.no_proxy,values.NO_PROXY);
  assert.deepEqual(values.no_proxy.split(','),['localhost','manual.test','service.test','alias.test','ipv6.test','public-v6.test','public.test']);
  assert.deepEqual(config.noProxy,['localhost','manual.test']);
  fs.writeFileSync(hosts,'# 10.0.0.2 service.test\n');
  assert.equal(context.variables(ready,config).no_proxy,'localhost,manual.test');
  assert.equal(context.variables(ready,{...config,noProxyHostsFile:''}).no_proxy,'localhost,manual.test');
  fs.unlinkSync(hosts);
  assert.equal(context.variables(ready,config).no_proxy,'localhost,manual.test');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('manager republishes hosts edits, atomic replacements, deletion and recreation',{timeout:30000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-hosts-events-')),home=path.join(root,'proxy'),hostsDir=path.join(root,'sources'),hosts=path.join(hostsDir,'hosts');
 fs.mkdirSync(home);fs.mkdirSync(hostsDir);
 fs.writeFileSync(hosts,'10.0.0.1 original.test\n');
 const settings={recoveryEnabled:false,learningEnabled:false,noProxy:['manual.test'],noProxyHostsFile:hosts};
 fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify(settings));
 // Isolate discovery, launchd and workers; exercise the real manager's filesystem watches.
 const code=`const scripts=${JSON.stringify(scripts)};
 const context=require(scripts+'/proxy-context.cjs');
 context.discover=async()=>(${JSON.stringify(ready)});
 context.syncLaunchd=()=>({ok:true});
 require(scripts+'/clash-router.cjs').discover=()=>[];
 require(scripts+'/proxy-manager.cjs').run().catch(e=>{console.error(e);process.exitCode=1});`;
 const child=cp.spawn(process.execPath,['-e',code],{env:{...context.cleanEnv(),PROXY_HOME:home},stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',x=>errors+=x);
 const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
 async function waitFor(predicate){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
   assert.equal(child.exitCode,null,errors||'Fixture manager exited');
   const file=path.join(home,'shell-env.zsh');
   if(fs.existsSync(file)){
    const text=fs.readFileSync(file,'utf8'),lower=text.match(/^export no_proxy='([^']*)'$/m)?.[1],upper=text.match(/^export NO_PROXY='([^']*)'$/m)?.[1];
    if(lower&&predicate(lower.split(','))){assert.equal(lower,upper);assert(lower.split(',').includes('manual.test'));return}
   }
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.fail('Hosts change was not published by a filesystem event: '+errors);
 }
 try{
  await waitFor(names=>names.includes('original.test'));
  fs.appendFileSync(hosts,'10.0.0.2 appended.test\n');
  await waitFor(names=>names.includes('appended.test'));
  fs.writeFileSync(hosts+'.next','10.0.0.3 replaced.test\n');fs.renameSync(hosts+'.next',hosts);
  await waitFor(names=>names.includes('replaced.test')&&!names.includes('original.test')&&!names.includes('appended.test'));
  fs.unlinkSync(hosts);
  await waitFor(names=>!names.includes('replaced.test'));
  fs.writeFileSync(hosts,'::1 recreated.test\n');
  await waitFor(names=>names.includes('recreated.test'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home,'settings.json'))),settings);
 }finally{
  if(child.exitCode===null)child.kill('SIGTERM');
  await exited;fs.rmSync(root,{recursive:true,force:true});
 }
});
