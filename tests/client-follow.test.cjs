'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {Follower} = require('../skills/clash-smart-routing/scripts/client-follow.cjs');
function fixture() {
  let selection = {status:'active',client:'flclash',root:'/fl'}, time = 0, pid = 10;
  const actions = [], reports = [];
  const f = new Follower({select:()=>selection,now:()=>time,
    spawn:root=>{actions.push(['spawn',root]);return {pid:pid++,exitCode:null,signalCode:null};},
    stop:async child=>{actions.push(['stop',child.pid]);child.exitCode=0;},
    cleanup:async(root,pid)=>actions.push(['cleanup',root,pid]),report:r=>{reports.push(r);return r;}});
  return {f,actions,reports,select:x=>{selection=x;time+=6000;}};
}
test('live switching stops and cleans the old worker before starting the new client without restarting apps', async () => {
  const x=fixture();await x.f.tick();const old=x.f.current.child.pid;
  x.select({status:'active',client:'verge',root:'/verge'});await x.f.tick();
  assert.deepEqual(x.actions,[['spawn','/fl'],['stop',old],['cleanup','/fl',old],['spawn','/verge']]);
  assert.equal(x.reports.at(-1).root,'/verge');
  x.select({status:'active',client:'flclash',root:'/fl'});await x.f.tick();assert.equal(x.f.current.selection.root,'/fl');
  await x.f.stop();assert.equal(x.f.current,null);
});
test('both or no apps suspend the workers and automatically resume when one is running', async () => {
  const x=fixture();await x.f.tick();
  x.select({status:'paused-multiple-clients'});await x.f.tick();assert.equal(x.f.current,null);
  x.select({status:'paused-no-client'});await x.f.tick();assert.equal(x.actions.filter(a=>a[0]==='spawn').length,1);
  x.select({status:'active',client:'verge',root:'/verge'});await x.f.tick();assert.equal(x.f.current.selection.root,'/verge');
});
test('an exited worker is cleaned and restart attempts are bounded', async () => {
  const x=fixture();await x.f.tick();x.f.current.child.exitCode=1;await x.f.tick();
  assert.equal(x.reports.at(-1).status,'waiting-worker-restart');assert.equal(x.f.current,null);
  x.select({status:'active',client:'flclash',root:'/fl'});await x.f.tick();assert.equal(x.actions.filter(a=>a[0]==='spawn').length,2);
});
test('automatic LaunchAgents have no fixed configuration directory; explicit installations retain it', () => {
  const w=require('../skills/clash-smart-routing/scripts/node-watchdog.cjs');
  const m=require('../skills/clash-smart-routing/scripts/routing-monitor.cjs');
  for(const mod of [w,m]){
    assert.ok(!mod.launchPlist('/node','/skill/watch.cjs',null).includes('--config-dir'));
    assert.ok(mod.launchPlist('/node','/skill/watch.cjs','/fl').includes('--config-dir'));
  }
});
