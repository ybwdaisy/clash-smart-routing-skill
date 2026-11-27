'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const base=path.resolve(__dirname,'../skills/clash-smart-routing/scripts'),guard=require(base+'/proxy-switch-guard.cjs'),safety=require(base+'/proxy-safety.cjs'),{monotonicMs}=require(base+'/proxy-deadline.cjs');
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-journal-'));fs.chmodSync(dir,0o700);return {dir,done:()=>fs.rmSync(dir,{recursive:true,force:true})}}
test('loading the guard never installs a service, queries VPN or starts/stops Apps',()=>{
 const program="const c=require('child_process');c.spawn=()=>{throw Error('Unexpected spawn')};c.spawnSync=()=>{throw Error('Unexpected spawnSync')};const f=require('fs');f.writeFileSync=()=>{throw Error('Unexpected write')};require("+JSON.stringify(base+'/proxy-switch-guard.cjs')+");process.stdout.write('read-only import');";
 const out=cp.spawnSync(process.execPath,['-e',program],{encoding:'utf8'});assert.equal(out.status,0,out.stderr);assert.equal(out.stdout,'read-only import');
});
test('terminal/expired journal cannot rearm or reset an old outage clock',async()=>{
 const f=fixture();try{
  const plan={version:1,port:34567,compatibilityPorts:[],uiPrepared:true,compatibilityVerified:true,fallback:{client:'verge'},target:{client:'clash-app'}};
  fs.writeFileSync(f.dir+'/plan.json',JSON.stringify(plan));fs.writeFileSync(f.dir+'/journal.json',JSON.stringify({phase:'recovering',token:'one-generation',preparedAt:monotonicMs()-31000,startedAt:monotonicMs()-31000,deadline:monotonicMs()-1000}));
  let calls=0;const result=await guard.watch(f.dir,{create:()=>({verifyTarget:async()=>{calls++;return {ok:true}},records:[]})});assert.equal(result.phase,'failed');assert.equal(calls,0);
  await assert.rejects(guard.arm(f.dir),/prepared/);assert.equal((await guard.watch(f.dir)).phase,'failed');
 }finally{f.done()}
});
test('stale start token is rejected before writing any request or changing a client',async()=>{
 const f=fixture();try{fs.writeFileSync(f.dir+'/journal.json',JSON.stringify({phase:'armed',token:'current'}));await assert.rejects(guard.start(f.dir,'old'),/revoked/);assert(!fs.existsSync(f.dir+'/start.json'));}finally{f.done()}
});
test('network is verified before manager/environment bookkeeping and exact file restoration preserves later edits',async()=>{
 const f=fixture();try{
  const file=f.dir+'/owned',backup=f.dir+'/before';fs.writeFileSync(file,'installed');fs.writeFileSync(backup,'original');
  const hash=x=>require('node:crypto').createHash('sha256').update(x).digest('hex');safety.save(f.dir,{phase:'failed',entries:[{file,backup,original:{exists:true,hash:hash('original'),mode:0o600},expected:{exists:true,hash:hash('installed')}}],agents:[],fallback:'/fixture',launchd:{}});
  const events=[];const out=await safety.rollback(f.dir,{restoreVerge:async(_,__,options)=>{events.push('stop-target');await options.prepareFallback(null,{check:()=>{}});assert.equal(fs.readFileSync(file,'utf8'),'original');events.push('network-verified');return {publicReachable:true}},stopManager:()=>events.push('stop-manager'),restoreEnvironment:async()=>events.push('environment')});
  assert.equal(out.phase,'rolled-back');assert.deepEqual(events,['stop-target','network-verified','stop-manager','environment']);assert(out.networkRestoredAt);
 }finally{f.done()}
});
test('failed public verification is never reported as rolled back or followed by service mutations',async()=>{
 const f=fixture();try{safety.save(f.dir,{phase:'failed',entries:[],agents:[],fallback:'/fixture',launchd:{}});let mutations=0;const out=await safety.rollback(f.dir,{restoreVerge:async()=>({publicReachable:false}),stopManager:()=>mutations++,restoreEnvironment:async()=>mutations++});assert.equal(out.phase,'recovery-failed');assert.equal(mutations,0);assert.match(out.error,/not verified/);}finally{f.done()}
});
test('late installer cannot overwrite a recovery result or regain write permission',()=>{
 const f=fixture();try{
  const file=f.dir+'/owned';fs.writeFileSync(file,'preserve');
  for(const phase of ['rolling-back','network-restored','recovery-failed','rolled-back','committed']){
   safety.save(f.dir,{phase,deadline:Date.now()+60000,entries:[]});
   assert.throws(()=>safety.stage(f.dir,'installing'),/no longer active/);
   assert.throws(()=>safety.write(f.dir,file,'late'),/no longer active/);
   safety.fail(f.dir,'late installer error');assert.equal(safety.read(f.dir).phase,phase);
  }
  assert.equal(fs.readFileSync(file,'utf8'),'preserve');
 }finally{f.done()}
});
test('host restart makes an in-progress guard terminal without querying or mutating Apps',async()=>{
 const f=fixture();try{
  const plan={version:1,port:34567,compatibilityPorts:[],uiPrepared:true,compatibilityVerified:true,fallback:{client:'verge'},target:{client:'clash-app'}};
  fs.writeFileSync(f.dir+'/plan.json',JSON.stringify(plan));fs.writeFileSync(f.dir+'/journal.json',JSON.stringify({phase:'recovering',token:'old-host',preparedAt:90000,startedAt:100000}));
  const result=await guard.watch(f.dir,{now:()=>100,create:()=>{throw Error('must not query OS')}});
  assert.equal(result.phase,'failed');assert.match(result.error,/Host restarted/);
 }finally{f.done()}
});
