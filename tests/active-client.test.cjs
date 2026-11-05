'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const active = require('../skills/clash-smart-routing/scripts/active-client.cjs');
const roots = ['/data/com.follow.clash', '/data/io.github.fqfqgo.clash-verge-for-v2free'];
const fl = '/Applications/FlClash.app/Contents/MacOS/FlClash', verge = '/Applications/Clash Verge.app/Contents/MacOS/clash-verge';
const bundleId = app => app.includes('FlClash') ? 'com.follow.clash' : 'io.github.fqfqgo.clash-verge-for-v2free';
test('selection follows the running desktop app, never the shared proxy port or idle installed core', () => {
  const first = active.detect(roots, {processes: '1 ' + fl + '\n2 /Applications/Clash Verge.app/Contents/MacOS/verge-mihomo', bundleId});
  assert.equal(first.root, roots[0]); assert.equal(first.client, 'flclash');
  assert.equal(active.detect(roots, {processes: '3 ' + verge, bundleId}).root, roots[1]);
});
test('both clients, neither client, unsupported root and failed process inspection pause instead of guessing', () => {
  for (const [text, expected] of [['1 '+fl+'\n2 '+verge, 'paused-multiple-clients'], ['', 'paused-no-client']])
    assert.equal(active.detect(roots, {processes: text, bundleId}).status, expected);
  assert.equal(active.detect([], {processes: '1 '+fl, bundleId}).status, 'paused-unconfigured-client');
  assert.equal(active.detect(roots, {processes: '1 '+fl, bundleId: () => {throw Error('metadata denied');}}).status, 'paused-detection-error');
  assert.throws(() => active.requireRoot({status:'paused-multiple-clients'}), /close the other client/);
});
test('an in-flight automatic operation refuses a write after the active client changes', async () => {
  const http=require('node:http'),r=require('../skills/clash-smart-routing/scripts/clash-router.cjs');let requests=0,selected='/old';
  const server=http.createServer((req,res)=>{requests++;res.end('{}');});
  await new Promise(yes=>server.listen(0,'127.0.0.1',yes));
  try{
    const api=r.controller({root:'/old',config:{'external-controller':'127.0.0.1:'+server.address().port}},
      {followActive:true,activeCheck:root=>{if(root!==selected)throw Error('Active client changed');}});
    await api('GET','/proxies');selected='/new';await assert.rejects(api('PUT','/proxies/Auto',{name:'node'}),/Active client changed/);
    assert.equal(requests,1);
  }finally{server.closeAllConnections();await new Promise(yes=>server.close(yes));}
});
