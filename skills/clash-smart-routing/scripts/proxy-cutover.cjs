'use strict';
const {Budget,monotonicMs}=require('./proxy-deadline.cjs');
const TOTAL_MS=30000,RECOVERY_RESERVE_MS=20000;
const terminal=new Set(['target-verified','fallback-verified','cancelled','failed']);
function validate(plan){
 if(!plan||plan.version!==1||!Number.isInteger(plan.port)||plan.port<1||plan.port>65535)throw Error('Invalid cutover plan');
 if(!Array.isArray(plan.compatibilityPorts)||plan.compatibilityPorts.some(p=>!Number.isInteger(p)||p<1||p>65535||p===plan.port))throw Error('Invalid compatibility ports');
 if(!['verge','flclash'].includes(plan.fallback?.client))throw Error('Protected recovery requires a verified Verge fallback or original FlClash');
 if(!['flclash','clash-app'].includes(plan.target?.client)||plan.target.client===plan.fallback.client)throw Error('Invalid target client');
 if(plan.uiPrepared!==true||plan.compatibilityVerified!==true)throw Error('Prepare native UI and compatibility listeners before arming');
 return plan;
}
async function recover(plan,ops,{startedAt=monotonicMs(),deadline=startedAt+TOTAL_MS,now=monotonicMs,onState=()=>{}}={}){
 validate(plan);const budget=new Budget(deadline,{now}),began=now();let lastError=null,attempts=0;
 const report=(phase,data={})=>onState({phase,startedAt,deadline,elapsedMs:now()-startedAt,...data});
 report('recovering');
 try{
  // Cancel the originating GUI/task first. A pending native Start can otherwise
  // reconnect its provider while scutil is being awaited.
  await budget.step('stop target',step=>ops.stopTarget(plan,step),5000);
  if(ops.prepareFallback)await budget.step('restore critical files',step=>ops.prepareFallback(plan,step),1500);
  await budget.step('prove exclusivity',step=>ops.exclusive(plan,step),1500);
  while(budget.remaining()>0){
   attempts++;
   try{
    await budget.step('start fallback',step=>ops.startFallback(plan,step),1000);
    await budget.step('restore fallback',step=>ops.restoreFallback(plan,step),2500);
    const result=await budget.step('verify fallback',step=>ops.verifyFallback(plan,step),2500);
    if(result?.ok===true){report('fallback-verified',{attempts,result});return {phase:'fallback-verified',ok:true,attempts,result,elapsedMs:now()-startedAt,recoveryMs:now()-began,withinBudget:now()<=deadline};}
    lastError=Error('Fallback connectivity is not verified');
   }catch(e){lastError=e;if(e.code==='PROXY_UNSAFE')throw e;}
   report('recovering',{attempts,lastError:lastError.message});
   await budget.sleep(100);
  }
  throw lastError||Error('Recovery deadline exhausted');
 }catch(error){report('failed',{attempts,error:error.message});return {phase:'failed',ok:false,attempts,error:error.message,elapsedMs:now()-startedAt,withinBudget:now()<=deadline};}
 finally{budget.close();}
}
// The guard owns one clock from the first possible interruption through actual
// fallback HTTP/SOCKS verification. Retries and worker restarts never reset it.
async function run(plan,ops,{startedAt=monotonicMs(),now=monotonicMs,onState=()=>{},targetWindowMs=TOTAL_MS-RECOVERY_RESERVE_MS,cancelled=()=>false}={}){
 validate(plan);const deadline=startedAt+TOTAL_MS,budget=new Budget(deadline,{now});
 const targetEnd=Math.min(startedAt+targetWindowMs,deadline-RECOVERY_RESERVE_MS);
 const report=(phase,data={})=>onState({phase,startedAt,deadline,elapsedMs:now()-startedAt,...data});
 if(now()<startedAt)throw Error('Monotonic clock moved backwards; stale guard will not run');
 if(now()>=deadline){report('failed',{error:'Original deadline already expired'});return {phase:'failed',ok:false,error:'Original deadline already expired',withinBudget:false};}
 report('checking-target');
 while(now()<targetEnd&&!cancelled()){
  try{
   const result=await budget.step('target check',step=>ops.verifyTarget(plan,step),Math.min(2500,targetEnd-now()));
   if(result?.ok===true){budget.close();report('target-verified',{result});return {phase:'target-verified',ok:true,result,elapsedMs:now()-startedAt,withinBudget:true};}
  }catch{}
  if(now()<targetEnd)await budget.sleep(Math.min(100,targetEnd-now()));
 }
 budget.close();
 // Before touching a target, preserve an original client that never went down.
 // A delayed UI command must consult the revoked guard token, not reopen an App.
 try{
  const pre=new Budget(Math.min(deadline,now()+1000),{now});
  const untouched=await pre.step('original still healthy',step=>ops.originalHealthy?.(plan,step));pre.close();
  if(untouched?.ok===true){report('cancelled',{reason:'original-client-never-left'});return {phase:'cancelled',ok:true,reason:'original-client-never-left',withinBudget:true};}
 }catch{}
 return recover(plan,ops,{startedAt,deadline,now,onState});
}
module.exports={TOTAL_MS,RECOVERY_RESERVE_MS,terminal,validate,recover,run};
