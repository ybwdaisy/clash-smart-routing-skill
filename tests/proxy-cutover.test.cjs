'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const p='../skills/clash-smart-routing/scripts/',{Budget,monotonicMs}=require(p+'proxy-deadline.cjs'),engine=require(p+'proxy-cutover.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function plan(){return {version:1,port:34567,compatibilityPorts:[34568],uiPrepared:true,compatibilityVerified:true,fallback:{client:'verge'},target:{client:'clash-app'}}}
function fixture(){const events=[];return {events,ops:{verifyTarget:async()=>({ok:false}),originalHealthy:async()=>({ok:false}),stopTarget:async()=>{events.push('stop')},exclusive:async()=>{events.push('exclusive')},startFallback:async()=>{events.push('start')},restoreFallback:async()=>{events.push('restore')},verifyFallback:async()=>{events.push('verified');return {ok:true}}}}}
test('one cutover budget includes target checking, process shutdown, retries and public verification',async()=>{
 const f=fixture(),states=[];let n=0;f.ops.restoreFallback=async()=>{f.events.push('restore');if(n++<2)throw Error('controller-starting')};
 const result=await engine.run(plan(),f.ops,{targetWindowMs:10,onState:s=>states.push(s)});
 assert.equal(result.phase,'fallback-verified');assert.equal(result.attempts,3);assert.equal(new Set(states.map(s=>s.deadline)).size,1);assert.deepEqual(f.events.slice(0,4),['stop','exclusive','start','restore']);assert.equal(states.at(-1).phase,'fallback-verified');
});
test('a healthy target is preserved without any fallback mutation',async()=>{
 const f=fixture();f.ops.verifyTarget=async()=>({ok:true});const out=await engine.run(plan(),f.ops);assert.equal(out.phase,'target-verified');assert.deepEqual(f.events,[]);
});
test('an original client that never left is not stopped when the prepared UI command is cancelled',async()=>{
 const f=fixture();f.ops.originalHealthy=async()=>({ok:true});const out=await engine.run(plan(),f.ops,{cancelled:()=>true});assert.equal(out.phase,'cancelled');assert.deepEqual(f.events,[]);
});
test('expired state after a worker restart gets no new recovery budget and launches nothing',async()=>{
 const f=fixture(),out=await engine.run(plan(),f.ops,{startedAt:monotonicMs()-30001});assert.equal(out.ok,false);assert.deepEqual(f.events,[]);
});
test('an unsafe/foreign process or occupied port prevents launching a second client',async()=>{
 const f=fixture();f.ops.exclusive=async()=>{throw Object.assign(Error('foreign owner'),{code:'PROXY_UNSAFE'})};const out=await engine.recover(plan(),f.ops);assert.equal(out.ok,false);assert.deepEqual(f.events,['stop']);
});
test('hanging recovery consumes the remaining original budget rather than renewing it',async()=>{
 const f=fixture();f.ops.restoreFallback=()=>new Promise(()=>{});const begin=monotonicMs();const out=await engine.recover(plan(),f.ops,{startedAt:begin-29900});assert.equal(out.ok,false);assert(monotonicMs()-begin<500);assert(!f.events.includes('verified'));
});
test('a timed-out asynchronous operation cannot perform a late mutation after fallback begins',async()=>{
 let mutations=0;const b=new Budget(monotonicMs()+100);
 await assert.rejects(b.step('slow GUI',async step=>{await sleep(45);step.check();mutations++},15),/timed out/);await sleep(60);assert.equal(mutations,0);b.close();
});
test('elapsed local deadlines cannot be bypassed by returning after an event-loop delay',async()=>{
 let clock=100;const b=new Budget(200,{now:()=>clock});await assert.rejects(b.step('blocked helper',async()=>{clock=151;return {ok:true}},50),/authorized/);
});
test('unprepared UI, missing compatibility and unsupported fallback are refused before any effects',()=>{
 assert.throws(()=>engine.validate({...plan(),uiPrepared:false}),/Prepare/);assert.throws(()=>engine.validate({...plan(),compatibilityPorts:[0]}),/compatibility/);assert.throws(()=>engine.validate({...plan(),fallback:{client:'clash-app'}}),/Verge fallback/);
});
