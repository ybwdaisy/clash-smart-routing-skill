'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const base='../skills/clash-smart-routing/scripts/',mac=require(base+'proxy-cutover-macos.cjs'),life=require(base+'flclash-lifecycle.cjs'),{Budget,monotonicMs}=require(base+'proxy-deadline.cjs');
const gui={pid:123,ppid:1,ruid:501,uid:501,born:'Fri Nov 27 09:00:00 2026',exe:mac.NATIVE};
const provider={pid:124,ppid:1,ruid:501,uid:501,born:'Fri Nov 27 09:00:01 2026',exe:mac.EXT};
const agent={pid:555,ppid:1,ruid:501,uid:501,born:'Fri Nov 27 08:00:00 2026',exe:'/Applications/ChatGPT.app/Contents/MacOS/codex'};
const widget={pid:666,ppid:1,ruid:501,uid:501,born:'Fri Nov 27 08:00:01 2026',exe:'/Applications/Clash.app/Contents/PlugIns/ClashmacOSWidgets.appex/Contents/MacOS/ClashmacOSWidgets'};
const vpnId='11111111-2222-4333-8444-555555555555';
function plan(){return {version:1,port:34567,compatibilityPorts:[34568],uiPrepared:true,compatibilityVerified:true,fallback:{client:'verge',app:'/Applications/Clash Verge.app',config:{'mixed-port':34567,listeners:[{name:'legacy',type:'mixed',listen:'127.0.0.1',port:34568}]}},target:{client:'clash-app',vpnId,processes:[gui,provider]}}}
function fixture(){
 let rows=[gui,provider,agent,widget],connected=true;const events=[];
 const deps={uid:501,scan:async()=>rows,vpn:async()=>({id:vpnId,status:connected?'Connected':'Disconnected',connected}),pause:async()=>{},portOpen:async()=>false,signal:(pid,sig)=>{events.push(['signal',pid,sig]);assert([123,124].includes(pid));rows=rows.filter(p=>p.pid!==pid);if(pid===124)connected=false},command:async(file,args)=>{events.push(['command',file,args]);if(file.endsWith('scutil')){assert.equal(args[2],vpnId);if(rows.some(p=>p.pid===123))throw Error('GUI reconnects the VPN');connected=false;return ''}if(file.endsWith('open'))return '';throw Error('Unexpected OS call')}};
 return {deps,events,get rows(){return rows},set rows(value){rows=value},get connected(){return connected},set connected(v){connected=v}};
}
test('native GUI is stopped before scutil is awaited; only its captured provider follows',async()=>{
 const f=fixture(),ops=mac.create(plan(),f.deps),b=new Budget(monotonicMs()+1000);await b.step('stop',s=>ops.stopTarget(plan(),s));await b.step('exclusive',s=>ops.exclusive(plan(),s));assert.deepEqual(f.events[0],['signal',123,'SIGTERM']);assert(f.rows.some(p=>p.pid===agent.pid));assert(f.rows.some(p=>p.pid===widget.pid));assert.equal(f.connected,false);
});
test('a hung VPN stop request does not prevent terminating the captured provider',async()=>{
 const f=fixture(),orig=f.deps.command;f.deps.command=async(file,args,s,o)=>{if(file.endsWith('scutil'))throw Error('request timed out');return orig(file,args,s,o)};const ops=mac.create(plan(),f.deps),b=new Budget(monotonicMs()+1000);await b.step('stop',s=>ops.stopTarget(plan(),s));assert.equal(f.connected,false);assert(f.events.some(x=>x[0]==='signal'&&x[1]===124));
});
test('SIGTERM-ignoring GUI/provider are escalated only after exact identity revalidation',async()=>{
 const f=fixture();f.deps.signal=(pid,sig)=>{f.events.push(['signal',pid,sig]);if(sig==='SIGKILL'){f.rows=f.rows.filter(p=>p.pid!==pid);if(pid===124)f.connected=false}};const ops=mac.create(plan(),f.deps),b=new Budget(monotonicMs()+1000);await b.step('stop',s=>ops.stopTarget(plan(),s));assert.deepEqual(f.events.filter(x=>x[2]==='SIGKILL').map(x=>x[1]),[123,124]);
});
test('a changed/restarted GUI is never adopted or killed by an old guard',async()=>{
 const f=fixture();f.rows=[{...gui,pid:999,born:'Fri Nov 27 09:10:00 2026'},provider,agent];const ops=mac.create(plan(),f.deps),b=new Budget(monotonicMs()+1000);await assert.rejects(b.step('stop',s=>ops.stopTarget(plan(),s)),/restarted/);assert.deepEqual(f.events,[]);
});
test('PID reuse between scan and signal preserves the unrelated replacement',async()=>{
 const f=fixture();let scans=0;f.deps.scan=async()=>{scans++;return scans===2?[{...gui,exe:agent.exe,born:'Fri Nov 27 10:00:00 2026'},provider]:f.rows};const ops=mac.create(plan(),f.deps),b=new Budget(monotonicMs()+1000);await assert.rejects(b.step('stop',s=>ops.stopTarget(plan(),s)),/PID was reused/);assert.deepEqual(f.events,[]);
});
test('wrong VPN UUID cannot stop OpenVPN or open the fallback',async()=>{
 const f=fixture();f.deps.vpn=async()=>({id:'66666666-7777-4888-8999-AAAAAAAAAAAA',status:'Connected'});const ops=mac.create(plan(),f.deps),b=new Budget(monotonicMs()+1000);await assert.rejects(b.step('stop',s=>ops.stopTarget(plan(),s)),/VPN identity/);assert(!f.events.some(x=>x[0]==='command'));
});
test('an occupied shared port refuses fallback and never moves it to another number',async()=>{
 const f=fixture();f.rows=[agent,widget];f.connected=false;f.deps.portOpen=async()=>true;const ops=mac.create(plan(),f.deps),b=new Budget(monotonicMs()+1000);await assert.rejects(b.step('exclusive',s=>ops.exclusive(plan(),s)),/occupied/);assert.deepEqual(f.events,[]);
});
test('FlClash setuid core is captured through its real UID and GUI parent, then awaited after reparenting',async()=>{
 const flgui={...gui,exe:life.APP},core={...provider,exe:life.CORE,uid:0,ppid:123},f=fixture(),p=plan();p.target={client:'flclash',processes:[flgui,core]};f.rows=[flgui,core,agent,widget];const ops=mac.create(p,f.deps),b=new Budget(monotonicMs()+1000);await b.step('stop',s=>ops.stopTarget(p,s));assert(f.rows.every(x=>![123,124].includes(x.pid)));assert(!f.events.some(x=>x[0]==='command'));
});
test('an inherited legacy port missing from the saved runtime blocks arming',()=>{const p=plan();p.fallback.config.listeners=[];assert.throws(()=>mac.create(p,fixture().deps),/lacks an inherited/)});
