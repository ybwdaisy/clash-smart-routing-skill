'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {parseProxy, matches, waitReady} = require('../skills/clash-smart-routing/scripts/client-readiness.cjs');
const complete = port => Object.fromEntries(['http', 'https', 'socks'].map(k => [k, {enabled: true, host: '127.0.0.1', port}]));
test('system proxy readiness requires HTTP, HTTPS and SOCKS to match the actual loopback port', () => {
  const proxy = parseProxy('<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 7890\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7897\n SOCKSEnable : 0\n}');
  assert.equal(proxy.http.port, 7890); assert.equal(proxy.https.port, 7897); assert.equal(matches(proxy, 7890), false);
  assert.equal(matches(complete(7890), 7890), true);
  const wrong = complete(7890); wrong.https.host = 'remote.example'; assert.equal(matches(wrong, 7890), false);
});
test('waits for asynchronous OS proxy updates and listener even after the control API would be ready', async () => {
  let time = 0, samples = 0;
  const result = await waitReady(7890, {now: () => time, sleep: async ms => { time += ms; }, timeoutMs: 2000,
    readProxy: async () => time < 500 ? complete(7897) : complete(7890), checkListener: async () => time >= 1000,
    onSample: () => samples++});
  assert.equal(result.ready, true); assert.equal(result.elapsedMs, 1000); assert.ok(samples > 1);
});
test('bounded readiness failure preserves evidence and never changes system proxy settings', async () => {
  let time = 0, checks = 0;
  await assert.rejects(waitReady(7890, {now: () => time, sleep: async ms => { time += ms; }, timeoutMs: 750,
    readProxy: async () => { checks++; return complete(7897); }, checkListener: async () => { throw Error('Must not probe wrong proxy'); }}),
  e => e.code === 'CLIENT_NOT_READY' && e.lastState.proxy.http.port === 7897 && e.lastState.elapsedMs === 750);
  assert.equal(checks, 4);
});
