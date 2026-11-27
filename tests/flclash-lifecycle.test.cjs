'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process');
const life=require('../skills/clash-smart-routing/scripts/flclash-lifecycle.cjs');
const gui={pid:123,ppid:1,ruid:501,uid:501,born:'Fri Nov 27 09:00:00 2026',exe:life.APP};
const core={pid:124,ppid:123,ruid:501,uid:0,born:'Fri Nov 27 09:00:01 2026',exe:life.CORE};
function fixture(list=[gui,core]){let t=0,processes=list;const signals=[];return {signals,get t(){return t},set processes(v){processes=v},deps:{uid:501,rows:()=>processes,now:()=>t,pause:async ms=>{t+=ms},request:()=>{},signal:(pid,sig)=>{signals.push({pid,sig});processes=processes.filter(p=>p.pid!==pid)}}}}
test('authenticates GUI parent and real UID before accepting a setuid root core',()=>{
 assert.deepEqual(life.capture([gui,core],501),[gui,core]);
 assert.throws(()=>life.capture([core],501),/ambiguous/);
 assert.throws(()=>life.capture([gui,{...core,ppid:999}],501),/Unattributed/);
 assert.throws(()=>life.capture([gui,{...core,ruid:0}],501),/Unattributed/);
 assert.throws(()=>life.capture([gui,{...gui,pid:125}],501),/ambiguous/);
});
test('captures a root child before GUI exit and terminates only that child after reparenting',async()=>{
 const f=fixture();f.deps.request=()=>{f.processes=[{...core,ppid:1}]};
 assert.deepEqual(await life.quit({forceCaptured:true,timeoutMs:3000},f.deps),{exited:true,signalled:1});
 assert.deepEqual(f.signals,[{pid:124,sig:'SIGTERM'}]);
});
test('ordinary quit does not succeed when GUI is gone but core still owns its port',async()=>{
 const f=fixture();f.deps.request=()=>{f.processes=[{...core,ppid:1}]};
 await assert.rejects(life.quit({timeoutMs:2000},f.deps),/GUI\/core did not exit/);
 assert.equal(f.signals.length,0);assert.equal(f.t,2000);
});
test('PID reuse after a quit request aborts without signalling the replacement',async()=>{
 const f=fixture();f.deps.request=()=>{f.processes=[{...core,born:'Fri Nov 27 09:30:01 2026',ppid:1}]};
 await assert.rejects(life.quit({forceCaptured:true},f.deps),/identity changed/);assert.equal(f.signals.length,0);
});
test('rechecks process identity immediately before a signal',async()=>{
 const f=fixture();let scans=0;f.deps.rows=()=>{scans++;return scans===3?[{...gui,born:'Fri Nov 27 10:00:00 2026'},core]:[gui,core]};
 f.deps.now=()=>scans>1?2000:0;
 await assert.rejects(life.quit({forceCaptured:true},f.deps),/PID reused/);assert.equal(f.signals.length,0);
});
test('quit returns only after every captured executable has exited',async()=>{
 const f=fixture();f.deps.request=()=>{f.processes=[{...core,ppid:1}]};
 f.deps.pause=async()=>{f.processes=[]};
 assert.deepEqual(await life.quit({},f.deps),{exited:true,signalled:0});
});
test('real isolated processes: GUI exit alone cannot complete fallback; captured core is awaited',
 {skip:process.platform!=='darwin'},async()=>{
 const uid=process.getuid(),children=[];
 try{
  const a=cp.spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'}),b=cp.spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});children.push(a,b);
  await Promise.all(children.map(child=>new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})));
  const exits=children.map(child=>new Promise(resolve=>child.once('exit',resolve)));
  const scan=()=>life.rows().filter(p=>children.some(c=>c.pid===p.pid)&&!children.find(c=>c.pid===p.pid).signalCode).map(p=>({...p,exe:p.pid===a.pid?life.APP:life.CORE,ppid:p.pid===b.pid&&a.exitCode===null&&a.signalCode===null?a.pid:p.ppid}));
  const signals=[];
  const result=await life.quit({forceCaptured:true,timeoutMs:4000},{uid,rows:scan,request:()=>a.kill('SIGTERM'),signal:(pid,sig)=>{assert.equal(pid,b.pid);signals.push(pid);process.kill(pid,sig)}});
  await Promise.all(exits);assert.equal(result.exited,true);assert.deepEqual(signals,[b.pid]);
 }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')}
});
