'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const {cycle, emptyState, probeKind, transportEvent, logSignals, launchPlist, DEFAULTS} = require('../skills/clash-smart-routing/scripts/node-watchdog.cjs');
const {engine} = require('../skills/clash-smart-routing/scripts/clash-router.cjs');
const clone = x => JSON.parse(JSON.stringify(x));
function fixture() {
  const ctx = {root: '/fixture/clash', stateDir: '/nonexistent/watchdog-test', config: {rules: ['MATCH,Main'],
    'proxy-groups': [{name: 'Main', type: 'select', proxies: ['Auto', '日本1', '美国1']} ]}};
  const proxies = {Main: {type: 'Selector', all: ['Auto', '日本1', '美国1'], now: 'Auto'},
    Auto: {type: 'URLTest', all: ['日本1', '美国1'], now: '日本1', fixed: '日本1', testUrl: 'https://latency.example/204'},
    '日本1': {type: 'Shadowsocks'}, '美国1': {type: 'Shadowsocks'},
    [engine.group]: {type: 'Selector', all: ['Main'], now: 'Main'}};
  const calls = [], saved = [], notifications = [], base = 1793690000000;
  let now = base, mode = 'rule', attempts = 0;
  const api = async (method, route) => {
    calls.push({method, route});
    if (method === 'GET' && route === '/configs') return {mode};
    if (method === 'GET' && route === '/proxies') return {proxies: clone(proxies)};
    throw Error('Watchdog must not directly mutate the controller');
  };
  const deps = {now: () => now, appRunning: () => true, logSignals: s => ({available: true, cursor: s.logCursor ?? 100, events: []}),
    probe: async () => ({publicEndpointReachable: false, routeVerified: false, httpStatus: null, exitCode: 28, localFailure: false}),
    persist: (s, r) => saved.push({state: clone(s), report: clone(r)}), notify: n => notifications.push(n),
    recover: async () => { attempts++; return {status: 'recovered', changes: [{group: 'Main'}]}; }};
  return {ctx, proxies, api, deps, calls, saved, notifications, base, advance: ms => { now += ms; }, setMode: m => { mode = m; }, attempts: () => attempts};
}
test('two separated public transport failures trigger exactly one bounded recovery with a pre-reserved budget', async () => {
  const f = fixture();
  const first = await cycle(f.ctx, f.api, emptyState(), f.deps);
  assert.equal(first.report.status, 'confirming-failure'); assert.equal(f.attempts(), 0);
  f.advance(DEFAULTS.interval);
  const second = await cycle(f.ctx, f.api, first.state, f.deps);
  assert.equal(second.report.status, 'recovered'); assert.equal(f.attempts(), 1);
  assert.equal(second.report.trigger, 'repeated-public-transport-failure');
  assert.equal(second.state.cooldownUntil, f.base + DEFAULTS.interval + DEFAULTS.successCooldown);
  const reserved = f.saved.find(x => x.report.status === 'recovering');
  assert.equal(reserved.state.attempts.length, 1); assert.ok(reserved.state.cooldownUntil > f.base);
  assert.deepEqual(f.notifications, ['recovered']); assert.ok(f.calls.every(x => x.method === 'GET'));
});
test('one transient failure followed by success clears the streak and stays quiet', async () => {
  const f = fixture(), a = await cycle(f.ctx, f.api, emptyState(), f.deps); f.advance(DEFAULTS.interval);
  f.deps.probe = async () => ({publicEndpointReachable: true, routeVerified: true, httpStatus: 200});
  const b = await cycle(f.ctx, f.api, a.state, f.deps);
  assert.equal(b.report.status, 'healthy'); assert.equal(b.state.failures, 0); assert.equal(f.attempts(), 0); assert.deepEqual(f.notifications, []);
});
test('repeated actual Codex TLS transport failures trigger recovery even while robots.txt works', async () => {
  const f = fixture();
  f.deps.probe = async () => ({publicEndpointReachable: true, routeVerified: true, httpStatus: 200});
  f.deps.logSignals = () => ({available: true, cursor: 103, events: [{id: 101, at: f.base - 20000, reason: 'tls-transport'}, {id: 102, at: f.base - 10000, reason: 'tls-transport'}]});
  const r = await cycle(f.ctx, f.api, emptyState(), f.deps);
  assert.equal(r.report.status, 'recovered'); assert.equal(r.report.trigger, 'codex-transport-errors'); assert.equal(r.state.handledLogId, 102);
  f.advance(DEFAULTS.interval);
  const next = await cycle(f.ctx, f.api, r.state, f.deps);
  assert.equal(next.report.status, 'healthy'); assert.equal(f.attempts(), 1);
});
test('auth, quota and server HTTP responses do not cause automatic node changes', async () => {
  for (const httpStatus of [401, 403, 429, 500, 503]) {
    const f = fixture(); f.deps.probe = async () => ({publicEndpointReachable: false, routeVerified: true, httpStatus});
    const r = await cycle(f.ctx, f.api, {...emptyState(), failures: 20, lastCheck: f.base - DEFAULTS.interval}, f.deps);
    assert.equal(r.report.status, 'needs-attention-service-response'); assert.equal(r.state.failures, 0); assert.equal(f.attempts(), 0);
  }
});
test('missing route evidence and failed local curl/listener never trigger recovery', async () => {
  for (const p of [{publicEndpointReachable: true, routeVerified: false, httpStatus: 200}, {publicEndpointReachable: false, localFailure: true}]) {
    const f = fixture(); f.deps.probe = async () => p;
    const r = await cycle(f.ctx, f.api, {...emptyState(), failures: 20, lastCheck: f.base}, f.deps);
    assert.ok(r.report.status.startsWith('needs-attention-')); assert.equal(f.attempts(), 0);
  }
  assert.equal(probeKind({publicEndpointReachable: true, routeVerified: true}), 'healthy');
});
test('Codex closed, Clash unavailable, non-rule mode and manual DIRECT all pause safely', async () => {
  const a = fixture(); a.deps.appRunning = () => false;
  assert.equal((await cycle(a.ctx, a.api, emptyState(), a.deps)).report.status, 'idle-app-closed'); assert.equal(a.calls.length, 0);
  const b = fixture(); b.setMode('global');
  assert.equal((await cycle(b.ctx, b.api, emptyState(), b.deps)).report.status, 'paused-non-rule-mode'); assert.equal(b.attempts(), 0);
  const c = fixture(); c.proxies.Main.now = 'DIRECT'; c.proxies.DIRECT = {type: 'Direct'};
  assert.equal((await cycle(c.ctx, c.api, emptyState(), c.deps)).report.status, 'paused-main-not-automatic'); assert.equal(c.attempts(), 0);
  const d = fixture();
  assert.equal((await cycle(d.ctx, async () => { throw Error('closed'); }, emptyState(), d.deps)).report.status, 'paused-client-or-selection-unavailable');
});
test('cooldown and rolling hourly budget persist through worker restarts', async () => {
  const f = fixture(), state = {...emptyState(), failures: 1, lastCheck: f.base - DEFAULTS.interval, cooldownUntil: f.base + DEFAULTS.successCooldown};
  const r = await cycle(f.ctx, f.api, JSON.parse(JSON.stringify(state)), f.deps);
  assert.equal(r.report.status, 'cooldown'); assert.equal(f.attempts(), 0);
  const full = {...emptyState(), failures: 1, lastCheck: f.base - DEFAULTS.interval, attempts: [f.base - 5000, f.base - 10000, f.base - 15000]};
  assert.equal((await cycle(f.ctx, f.api, full, f.deps)).report.status, 'hourly-limit'); assert.equal(f.attempts(), 0);
});
test('a failed recovery backs off thirty minutes and reserves only one attempt', async () => {
  const f = fixture(); let called = 0;
  f.deps.recover = async () => { called++; throw Error('controller lost'); };
  const r = await cycle(f.ctx, f.api, {...emptyState(), failures: 1, lastCheck: f.base - DEFAULTS.interval}, f.deps);
  assert.equal(r.report.status, 'recovery-failed'); assert.equal(called, 1); assert.equal(r.state.attempts.length, 1);
  assert.equal(r.state.cooldownUntil, f.base + DEFAULTS.failureCooldown); assert.deepEqual(f.notifications, ['failed']);
});
test('confirmed outage changes only the automatic pin through the actual engine, preserving the main group', async () => {
  const f = fixture(), baseAPI = f.api, alias = clone(f.proxies[engine.group]);
  const mutations = [];
  const api = async (method, route, data) => {
    if (method === 'PUT' && route === '/proxies/Auto') { mutations.push({route, data}); f.proxies.Auto.now = data.name; f.proxies.Auto.fixed = data.name; return null; }
    if (method === 'GET' && route.includes('/delay?')) return {delay: route.startsWith('/proxies/Main/') ? 70 : route.startsWith('/proxies/' + encodeURIComponent('美国1') + '/') ? 80 : 100};
    return baseAPI(method, route);
  };
  f.deps.recover = () => require('../skills/clash-smart-routing/scripts/node-recovery.cjs').run(f.ctx, api, 'recover', {},
    {hash: () => 'unchanged', probe: async () => ({publicEndpointReachable: true, routeVerified: true, httpStatus: 200})});
  const result = await cycle(f.ctx, api, {...emptyState(), failures: 1, lastCheck: f.base - DEFAULTS.interval}, f.deps);
  assert.equal(result.report.status, 'recovered'); assert.equal(f.proxies.Main.now, 'Auto'); assert.equal(f.proxies.Auto.fixed, '美国1');
  assert.deepEqual(mutations, [{route: '/proxies/Auto', data: {name: '美国1'}}]);
  assert.deepEqual(f.proxies[engine.group], alias);
});
test('a later manual/automatic node choice resets failure evidence from the previous node', async () => {
  const f = fixture(), r = await cycle(f.ctx, f.api, emptyState(), f.deps);
  f.advance(DEFAULTS.interval); f.proxies.Auto.now = '美国1'; f.proxies.Auto.fixed = '美国1';
  const next = await cycle(f.ctx, f.api, r.state, f.deps);
  assert.equal(next.report.status, 'confirming-failure'); assert.equal(next.state.failures, 1); assert.equal(f.attempts(), 0);
});
test('watchdog pauses when the user changes the main selector away from the automatic group', async () => {
  const f = fixture(); f.proxies.Main.now = '美国1';
  const r = await cycle(f.ctx, f.api, {...emptyState(), failures: 2, lastCheck: f.base}, f.deps);
  assert.equal(r.report.status, 'paused-main-not-automatic'); assert.equal(f.attempts(), 0);
});
test('old errors and long gaps cannot accumulate into a false outage', async () => {
  const f = fixture(); f.deps.logSignals = () => ({available: true, cursor: 200, events: [{id: 199, at: f.base - 500000}, {id: 200, at: f.base - 490000}]});
  const s = {...emptyState(), failures: 1, lastCheck: f.base - DEFAULTS.interval * 5};
  const r = await cycle(f.ctx, f.api, s, f.deps);
  assert.equal(r.report.status, 'confirming-failure'); assert.equal(r.state.failures, 1); assert.equal(f.attempts(), 0);
});
test('operational log parser accepts concrete network errors and drops auth/quota/server failures', () => {
  const base = {id: 1, ts: 12, level: 'WARN', target: 'codex_core::responses_retry'};
  const parse = message => transportEvent({...base, feedback_log_body: message});
  assert.equal(parse('span{thread_id=private}: stream disconnected before completion: tls handshake eof').reason, 'tls-transport');
  assert.equal(parse('stream connection failed; error=Connection failed: error sending request').reason, 'request-transport');
  assert.equal(parse('request timed out').reason, 'network-transport');
  for (const text of ['401 Unauthorized: tls handshake eof', '429 rate limit: connection reset', '503 service unavailable', 'quota exceeded', 'token expired', 'normal completion']) assert.equal(parse(text), null);
  assert.equal(transportEvent({...base, target: 'tool-output', feedback_log_body: 'tls handshake eof'}), null);
});
test('read-only SQLite log reader ignores old history and persists only classified metadata', {skip: !fs.existsSync('/usr/bin/sqlite3')}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-log-test-')), file = path.join(root, 'logs.sqlite');
  const sql = text => {
    const r = cp.spawnSync('/usr/bin/sqlite3', [file, text], {encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr);
  };
  try {
    const now = 1793690000000;
    sql("CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,level TEXT,target TEXT,feedback_log_body TEXT); INSERT INTO logs VALUES(1," + now / 1000 + ",'WARN','codex_core::responses_retry','tls handshake eof');");
    assert.deepEqual(logSignals(emptyState(), now, file), {available: true, cursor: 1, events: []});
    sql("INSERT INTO logs VALUES(2," + now / 1000 + ",'WARN','codex_core::responses_retry','span{thread_id=private-marker}: tls handshake eof');");
    const r = logSignals({...emptyState(), logCursor: 1}, now, file);
    assert.equal(r.cursor, 2); assert.deepEqual(r.events, [{id: 2, at: now, reason: 'tls-transport'}]);
    assert.ok(!JSON.stringify(r).includes('private-marker'));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
test('launch arguments are literal and XML-safe, with stable service identity and bounded restarts', () => {
  const plist = launchPlist('/node & runtime', '/skill path/watchdog.cjs', '/config <dir>');
  assert.ok(plist.includes('/node &amp; runtime')); assert.ok(plist.includes('/config &lt;dir&gt;'));
  assert.ok(plist.includes('<string>watch</string>')); assert.ok(plist.includes('<key>ThrottleInterval</key><integer>30</integer>'));
  assert.ok(!plist.includes('/bin/sh')); assert.ok(!plist.includes('auth.json'));
});
