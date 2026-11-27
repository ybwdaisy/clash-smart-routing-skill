'use strict';
class DeadlineError extends Error {
 constructor(message){super(message);this.name='DeadlineError';this.code='PROXY_DEADLINE';}
}
// hrtime has the same monotonic origin across a guard and its replacement.
const monotonicMs=()=>Number(process.hrtime.bigint()/1000000n);
class Budget {
 constructor(end,{now=monotonicMs}={}){if(!Number.isFinite(end))throw Error('Invalid deadline');this.end=end;this.now=now;this.closed=false;}
 remaining(){return Math.max(0,this.end-this.now());}
 assert(){if(this.closed||this.remaining()<=0)throw new DeadlineError('Proxy recovery deadline expired');}
 close(){this.closed=true;}
 async step(name,operation,maxMs=this.remaining()){
  this.assert();const limit=Math.min(maxMs,this.remaining());if(limit<=0)throw new DeadlineError(name+' has no time left');
  const controller=new AbortController();let timer,finished=false;
  const deadline=this.now()+limit;
  const check=()=>{this.assert();if(finished||controller.signal.aborted||this.now()>=deadline)throw new DeadlineError(name+' is no longer authorized');};
  try{
   const result=await Promise.race([
    Promise.resolve().then(()=>operation({signal:controller.signal,check,deadline,remaining:()=>Math.max(0,Math.min(this.remaining(),deadline-this.now()))})),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DeadlineError(name+' timed out'));},limit);})
   ]);
   check();return result;
  }finally{finished=true;clearTimeout(timer);controller.abort();}
 }
 async sleep(ms){if(this.remaining()<=0)return;await this.step('retry pause',({signal,remaining})=>new Promise(resolve=>{const timer=setTimeout(resolve,Math.min(ms,remaining()));signal.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true});}));}
}
module.exports={Budget,DeadlineError,monotonicMs};
