'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {isHongKong, region, resolve, inspect, measure, pool, restore, run, argsOf} = require('../skills/clash-smart-routing/scripts/node-recovery.cjs');
const {engine} = require('../skills/clash-smart-routing/scripts/clash-router.cjs');
const copy = x => JSON.parse(JSON.stringify(x));
function fixture(overrides = {}) {
  const names = ['日本 1', '台湾 1', '美国 1', '香港 1', '🇭🇰 Japan relay', 'Singapore', 'JP group', 'JP DIRECT'];
  const proxies = {Main: {type: 'Selector', all: ['Auto', ...names], now: 'Auto'},
    Auto: {type: 'URLTest', all: names, now: '香港 1', testUrl: 'https://latency.example/204'},
    [engine.group]: {type: 'Selector', all: ['Main'], now: 'Main'}};
  for (const name of names) proxies[name] = {type: 'Shadowsocks'};
  proxies['JP group'] = {type: 'Selector', all: ['香港 1'], now: '香港 1'};
  proxies['JP DIRECT'] = {type: 'Direct'};
  const ctx = {stateDir: '/nonexistent/node-recovery-fixture', config: {rules: ['MATCH,Main'], 'proxy-groups': [{name: 'Main', type: 'select', proxies: ['Auto', ...names]}]}};
  const histories = {};
  const calls = [], delays = {'日本 1': 90, '台湾 1': 60, '美国 1': 100, Main: 70, ...overrides.delays};
  const api = async (method, route, data) => {
    calls.push({method, route, data});
    if (method === 'GET' && route === '/proxies') return {proxies: copy(proxies)};
    const match = route.match(/^\/proxies\/([^/]+)(\/delay\?.*)?$/);
    if (!match) throw Error('Unexpected API request: ' + route);
    const name = decodeURIComponent(match[1]);
    if (method === 'GET' && !match[2]) return {...copy(proxies[name]), extra: copy(histories[name] || {})};
    if (method === 'GET' && match[2]) {
      if (overrides.onDelay) await overrides.onDelay(name, proxies);
      const query = new URL('http://fixture'+route).searchParams;
      const delay = query.has('expected') && overrides.onService
        ? await overrides.onService(name, query.get('url'), Number(query.get('expected'))) : delays[name];
      if (!Number.isFinite(delay)) throw Error('test timeout');
      if (query.has('expected')) {
        histories[name] ||= {};
        histories[name][query.get('url')] = overrides.onHistory ? overrides.onHistory(name, query.get('url'))
          : {alive:true,history:[{time:new Date().toISOString(),delay}]};
      }
      return {delay};
    }
    if (method === 'PUT' && !match[2]) {
      if (name !== 'Auto' || !proxies.Auto.all.includes(data.name)) throw Error('Only automatic-group pin changes are allowed');
      proxies.Auto.now = data.name; proxies.Auto.fixed = data.name;
      if (overrides.afterPut) await overrides.afterPut(data, proxies);
      return null;
    }
    if (method === 'DELETE' && name === 'Auto' && !match[2]) {
      delete proxies.Auto.fixed; proxies.Auto.now = '香港 1'; return null;
    }
    throw Error('Unexpected operation');
  };
  const deps = {hash: () => 'unchanged', saveUndo: x => { fixture.undo = x; },
    probe: async () => ({publicEndpointReachable: true, routeVerified: true, authenticatedCodexSessionVerified: false})};
  return {ctx, proxies, api, calls, deps};
}
test('region labels report metadata without determining candidate eligibility', () => {
  for (const name of ['香港 日本', '🇭🇰 USA', 'HK01 JP', 'HKG-01 TW', 'Hong Kong-US', 'HongKong01 日本', 'Singapore', 'Australia', 'Jupiter']) assert.equal(region(name), null, name);
  for (const name of ['日本1', '🇯🇵 node', 'JP01', 'Japan-2']) assert.equal(region(name), 'JP', name);
  for (const name of ['台湾1', '台灣2', '臺灣3', '🇹🇼 node', 'TW-01', 'Taiwan 2']) assert.equal(region(name), 'TW', name);
  for (const name of ['美国1', '美國2', '🇺🇸 node', 'US01', 'USA-2', 'United States']) assert.equal(region(name), 'US', name);
});
test('Hong Kong exclusion matches flags, full-width codes and mixed relay names without matching unrelated words', () => {
  for (const name of ['🇭🇰 Japan relay', '香港01', 'HK01', 'SG_HKG_01', 'ｈｋ-1', 'Hong Kong-US', 'HongKong01']) assert.ok(isHongKong(name), name);
  for (const name of ['Singapore', 'Taiwan', 'Japan', 'Shkodër', 'HKUSTest']) assert.ok(!isHongKong(name), name);
});
test('only real leaf nodes in the automatic group are eligible, including leaves absent from the main list', () => {
  const f = fixture();
  f.proxies.Auto.all.push('JP outside'); f.proxies['JP outside'] = {type: 'Shadowsocks'};
  assert.deepEqual(inspect(f.ctx, f.proxies).candidates.map(x => x.name), ['日本 1', '台湾 1', '美国 1', 'Singapore', 'JP outside']);
  f.proxies[engine.group].all.push('美国 1');
  assert.throws(() => inspect(f.ctx, f.proxies), /AI alias/);
});
test('missing/ambiguous automatic group and non-selector main fail without guessing', () => {
  const f = fixture(); delete f.proxies.Auto.testUrl;
  assert.throws(() => inspect(f.ctx, f.proxies), /Identify/);
  f.proxies.Main.type = 'URLTest'; assert.throws(() => inspect(f.ctx, f.proxies), /manual Selector/);
});
test('plan freshly measures eligible nodes without changing selection or rules', async () => {
  const f = fixture(), before = copy(f.proxies);
  const r = await run(f.ctx, f.api, 'plan', {}, f.deps);
  assert.equal(r.status, 'planned'); assert.equal(r.fastest.name, '台湾 1'); assert.equal(r.tested, 4);
  assert.deepEqual(f.proxies, before); assert.ok(f.calls.every(c => c.method === 'GET'));
  const {SERVICES} = require('../skills/clash-smart-routing/scripts/node-recovery.cjs');
  const allowed = ['https://latency.example/204', ...SERVICES.map(s => s.url)];
  assert.ok(f.calls.filter(c => c.route.includes('/delay?')).every(c => allowed.includes(new URL('http://fixture'+c.route).searchParams.get('url'))));
  assert.equal(r.qualified, 3); assert.ok(r.best.rounds.length === 2);
});
test('recovery allows Singapore and other regions but never measures Hong Kong even if its delay is best', async () => {
  const f = fixture({delays: {Singapore: 20, '香港 1': 1, '🇭🇰 Japan relay': 2}});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'recovered'); assert.equal(r.selected, 'Singapore');
  assert.ok(!f.calls.some(c => c.route.includes(encodeURIComponent('香港 1')) || c.route.includes(encodeURIComponent('🇭🇰 Japan relay'))));
  assert.equal(f.proxies.Main.now, 'Auto');
});
test('non-macOS default commands retain manual client selection without requiring a running macOS app', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const router=require('../skills/clash-smart-routing/scripts/clash-router.cjs');
  const f=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'clash-nonmac-')),descriptor=Object.getOwnPropertyDescriptor(process,'platform');
  const saved={load:router.load,resolve:router.resolveConfigDir,controller:router.controller};
  try{
    Object.defineProperty(process,'platform',{value:'linux'});f.ctx.stateDir=dir;f.ctx.client='verge';f.ctx.root=dir;
    f.ctx.subscriptionFile=path.join(dir,'subscription.yaml');fs.writeFileSync(f.ctx.subscriptionFile,'original-subscription');
    router.resolveConfigDir=()=>dir;router.load=()=>f.ctx;
    router.controller=(ctx,options)=>{assert.equal(options.followActive,false);return f.api;};
    const announced=[];
    const r=await require('../skills/clash-smart-routing/scripts/node-recovery.cjs').main(['plan'],{onClient: x=>announced.push(x)});
    assert.equal(r.status,'planned');assert.ok(f.calls.every(c=>c.method==='GET'));
    assert.equal(r.clientName,'Clash Verge');assert.equal(r.selectionMode,'saved');assert.equal(announced[0].clientName,r.clientName);
  }finally{
    Object.defineProperty(process,'platform',descriptor);router.load=saved.load;router.resolveConfigDir=saved.resolve;router.controller=saved.controller;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('recover pins only the automatic group and preserves main -> automatic hierarchy and AI alias', async () => {
  const f = fixture(), alias = copy(f.proxies[engine.group]), main = copy(f.proxies.Main);
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'recovered'); assert.equal(f.proxies.Main.now, 'Auto'); assert.equal(r.finalLatency.delayMs, 70);
  assert.equal(r.authenticatedCodexSessionVerified, false); assert.equal(r.subscriptionUnchanged, true);
  assert.deepEqual(f.proxies[engine.group], alias); assert.deepEqual(f.proxies.Main, main);
  assert.equal(f.proxies.Auto.fixed, '台湾 1'); assert.equal(f.proxies.Auto.now, '台湾 1'); assert.equal(r.hierarchyPreserved, true);
  assert.deepEqual(f.calls.filter(c => c.method !== 'GET'), [{method: 'PUT', route: '/proxies/Auto', data: {name: '台湾 1'}}]);
});
test('timeouts and zero delays stop before any selection change when no candidates respond', async () => {
  const f = fixture({delays: {'日本 1': 0, '台湾 1': NaN, '美国 1': NaN}});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'no-responsive-candidate'); assert.equal(f.proxies.Main.now, 'Auto');
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal((await measure(async () => ({delay: -1}), 'JP', 'https://example.com')).reachable, false);
});
test('failed public endpoint restores unpinned automatic mode via DELETE without touching the main group', async () => {
  const f = fixture(); f.deps.probe = async () => ({publicEndpointReachable: false, routeVerified: true});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'verification-failed'); assert.equal(r.rollback.restored, true); assert.equal(f.proxies.Main.now, 'Auto');
  assert.equal(f.proxies.Auto.fixed, undefined); assert.equal(r.rollback.reason, 'original-automatic-mode');
  assert.deepEqual(f.calls.filter(c => c.method !== 'GET').map(c => [c.method, c.route]), [['PUT', '/proxies/Auto'], ['DELETE', '/proxies/Auto']]);
});
test('failed verification restores the previously pinned node inside the automatic group', async () => {
  const f = fixture(); f.proxies.Auto.fixed = '日本 1'; f.proxies.Auto.now = '日本 1';
  f.deps.probe = async () => ({publicEndpointReachable: false, routeVerified: true});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.rollback.restored, true); assert.equal(r.rollback.reason, 'original-fixed-node');
  assert.equal(f.proxies.Auto.fixed, '日本 1'); assert.equal(f.proxies.Main.now, 'Auto');
  assert.deepEqual(f.calls.filter(c => c.method === 'PUT').map(c => [c.route, c.data.name]), [['/proxies/Auto', '台湾 1'], ['/proxies/Auto', '日本 1']]);
});
test('a main group deliberately pointing elsewhere pauses recovery without any selection writes', async () => {
  const f = fixture(); f.proxies.Main.now = '美国 1';
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'paused-main-not-automatic'); assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('public HTTP success without actual selected connection evidence is not success', async () => {
  const f = fixture(); f.deps.probe = async () => ({publicEndpointReachable: true, routeVerified: false});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'verification-failed'); assert.equal(r.rollback.restored, true);
});
test('a latency spike does not reject a node after all real service and chain checks pass', async () => {
  const f = fixture({delays: {Main: 586, '日本 1': 210, '台湾 1': 260, '美国 1': 300}}), r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'recovered'); assert.equal(r.finalLatency.delayMs, 586); assert.equal(r.best.name, '日本 1');
  assert.equal(r.serviceChecks.length, 3); assert.equal(r.rollback, undefined);
});
test('intervening manual choice or changed subscription aborts before switching', async () => {
  const f = fixture({onDelay: async (name, p) => { p.Main.now = '美国 1'; }});
  await assert.rejects(run(f.ctx, f.api, 'recover', {}, f.deps), /changed during measurement/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
  const z = fixture(); let reads = 0; z.deps.hash = () => ++reads === 1 ? 'before' : 'after';
  await assert.rejects(run(z.ctx, z.api, 'recover', {}, z.deps), /changed during measurement/);
  assert.ok(z.calls.every(c => c.method === 'GET'));
  const a = fixture({onDelay: async (name, p) => { p.Auto.fixed = '美国 1'; p.Auto.now = '美国 1'; }});
  await assert.rejects(run(a.ctx, a.api, 'recover', {}, a.deps), /changed during measurement/);
  assert.ok(a.calls.every(c => c.method === 'GET'));
});
test('controller response lost after applying selection is compensated', async () => {
  const f = fixture({afterPut: async data => { if (data.name === '台湾 1') throw Error('response lost'); }});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'verification-failed'); assert.equal(r.rollback.restored, true); assert.equal(f.proxies.Main.now, 'Auto');
});
test('rollback never overwrites a later manual selection', async () => {
  const f = fixture(); f.proxies.Auto.fixed = '美国 1'; f.proxies.Auto.now = '美国 1';
  const undo = {version: 2, main: 'Main', group: 'Auto', selected: '台湾 1', previousFixed: null};
  assert.deepEqual(await restore(f.api, undo), {restored: false, reason: 'selection-changed-externally'});
  assert.ok(f.calls.every(c => c.method === 'GET'));
  f.proxies.Main.now = '美国 1';
  assert.deepEqual(await restore(f.api, undo), {restored: false, reason: 'main-selection-changed-externally'});
  await assert.rejects(restore(f.api, {version: 1, main: 'Main', previous: 'Auto', selected: '台湾 1'}), /Legacy/);
});
test('cancelled measurement stops before switching and check never PUTs', async () => {
  const f = fixture(); f.deps.cancelled = () => true;
  assert.equal((await run(f.ctx, f.api, 'recover', {}, f.deps)).status, 'cancelled');
  assert.ok(f.calls.every(c => c.method === 'GET'));
  const z = fixture(), r = await run(z.ctx, z.api, 'check', {}, z.deps);
  assert.equal(r.status, 'public-endpoint-ok'); assert.equal(r.current.node, '香港 1');
  assert.ok(z.calls.every(c => c.method === 'GET'));
});
test('bounded pool preserves results, selection cycles and unsupported CLI options fail', async () => {
  let busy = 0, peak = 0;
  const results = await pool([1, 2, 3, 4, 5], 2, async n => { busy++; peak = Math.max(peak, busy); await new Promise(r => setTimeout(r, 2)); busy--; return n * 2; });
  assert.equal(peak, 2); assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.throws(() => resolve({A: {now: 'B'}, B: {now: 'A'}}, 'A'), /cycle/);
  assert.throws(() => argsOf(['recover', '--install-daemon']), /option/);
  assert.throws(() => argsOf(['recover', '--config-dir', 'one', '--config-dir', 'two']), /Duplicate/);
  assert.deepEqual(argsOf([]), {command: 'check', opts: {}});
});

test('fast Google-only node is rejected before any switch and a fully working candidate wins', async () => {
  const f = fixture({delays: {'日本 1': 10, '台湾 1': 60}, onService: async (name, url, expected) => {
    assert.equal(expected, url.includes('generate_204') ? 204 : 200);
    if (name === '日本 1' && url.includes('chatgpt')) throw Error('TLS failed');
    return name === '台湾 1' ? 100 : 200;
  }});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'recovered'); assert.equal(r.fastest.name, '日本 1'); assert.equal(r.selected, '台湾 1');
  assert.equal(r.preflight.find(c => c.name === '日本 1').qualified, false);
  assert.deepEqual(f.calls.filter(c => c.method === 'PUT').map(c => c.data.name), ['台湾 1']);
  const firstPut = f.calls.findIndex(c => c.method === 'PUT');
  assert.ok(f.calls.slice(0, firstPut).filter(c => c.route.includes('expected=')).length >= 6);
});
test('candidate must pass both service rounds and scoring favors worst service response over Google latency', async () => {
  let count = 0;
  const f = fixture({delays: {'日本 1': 10, '台湾 1': 80, '美国 1': 60}, onService: async (name, url) => {
    if (name === '日本 1' && url.includes('chatgpt') && ++count === 2) throw Error('Intermittent TLS');
    return name === '台湾 1' ? 90 : 300;
  }});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.selected, '台湾 1'); assert.equal(r.best.scoreMs, 90);
  assert.equal(r.preflight.find(c => c.name === '日本 1').rounds.length, 2);
});
test('all candidates failing a required service leave the current node and undo untouched', async () => {
  const f = fixture({onService: async () => {throw Error('No service response')}}); let saved = false;
  f.deps.saveUndo = () => {saved = true};
  const before = copy(f.proxies), r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'no-verified-candidate'); assert.equal(r.qualified, 0); assert.equal(saved, false);
  assert.deepEqual(f.proxies, before); assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('real Google failure after switching rolls back even when ChatGPT works', async () => {
  const f = fixture(); f.deps.probe = async (ctx, api, main, selected, options) => ({publicEndpointReachable: !options.url.includes('google'), routeVerified: true});
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'verification-failed'); assert.equal(r.probe.publicEndpointReachable, true);
  assert.equal(r.serviceChecks.length, 3); assert.equal(r.rollback.restored, true);
});
test('automatic recovery can exclude the failing current node while leaving all non-Hong-Kong regions eligible', async () => {
  const f = fixture({delays: {Singapore: 1}}); f.proxies.Auto.fixed = 'Singapore'; f.proxies.Auto.now = 'Singapore';
  const r = await run(f.ctx, f.api, 'recover', {excludeCurrent: true}, f.deps);
  assert.equal(r.selected, '台湾 1'); assert.equal(r.excludedCurrentNode, 'Singapore');
  assert.ok(!f.calls.some(c => c.route.startsWith('/proxies/Singapore/delay')));
});
test('preflight has a hard candidate budget and preview never mutates the selector', async () => {
  const names = Array.from({length: 20}, (_, i) => 'extra'+i), delays = Object.fromEntries(names.map((n, i) => [n, 20+i]));
  const f = fixture({delays}); for (const n of names) {f.proxies.Auto.all.push(n); f.proxies[n] = {type: 'Shadowsocks'}}
  const r = await run(f.ctx, f.api, 'plan', {}, f.deps);
  assert.equal(r.preflight.length, 12); assert.equal(r.preflightLimit, 12);
  assert.equal(f.calls.filter(c => c.route.includes('expected=')).length, 12*3*2);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('cancellation after qualification starts prevents selection', async () => {
  const f = fixture(); let cancelled = false;
  f.deps.assess = async (api, c) => {cancelled = true; return {...c, qualified:true, scoreMs:1, meanServiceMs:1}};
  f.deps.cancelled = () => cancelled;
  const r = await run(f.ctx, f.api, 'recover', {}, f.deps);
  assert.equal(r.status, 'cancelled'); assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('nonzero API delay cannot hide a wrong HTTP status or stale/missing URL history', async () => {
  const variants = [() => ({alive:false,history:[{time:new Date().toISOString(),delay:0}]}),
    () => ({alive:true,history:[{time:'2000-01-01T00:00:00Z',delay:10}]}), () => ({alive:true,history:[]}), () => null];
  for (const onHistory of variants) {
    const f=fixture({onHistory}),r=await run(f.ctx,f.api,'recover',{},f.deps);
    assert.equal(r.status,'no-verified-candidate');assert.ok(f.calls.every(c=>c.method==='GET'));
  }
});
test('public probes correlate each service host and distinguish ranged 206 from HEAD or error responses', async () => {
  const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{publicProbe}=require('../skills/clash-smart-routing/scripts/node-recovery.cjs');
  const original=cp.spawn;let argsSeen,status=206;
  try{
    cp.spawn=(file,args)=>{argsSeen=args;const child=new EventEmitter();child.stdout=new EventEmitter();child.kill=()=>{};
      setTimeout(()=>{child.stdout.emit('data',JSON.stringify({http_code:status,time_appconnect:0.01,time_total:0.02}));child.emit('close',0)},20);return child;};
    const api=async(method,route)=>route==='/configs'?{'mixed-port':17897}:{connections:[{metadata:{sourcePort:Number(argsSeen[argsSeen.indexOf('--local-port')+1]),host:new URL(argsSeen.at(-1)).hostname},chains:['Node','Auto','Main'],rule:'RuleSet'}]};
    const opts={url:'https://github.com/robots.txt',expectedStatus:200,via:'Auto'};
    const ranged=await publicProbe({},api,'Main','Node',opts);assert.equal(ranged.publicEndpointReachable,true);assert.equal(ranged.routeVerified,true);assert.ok(argsSeen.includes('--range'));
    const head=await publicProbe({},api,'Main','Node',{...opts,head:true});assert.equal(head.publicEndpointReachable,false);assert.ok(argsSeen.includes('--head'));
    status=500;assert.equal((await publicProbe({},api,'Main','Node',opts)).publicEndpointReachable,false);
    status=204;const google=await publicProbe({},api,'Main','Node',{url:'https://www.google.com/generate_204',expectedStatus:204,via:'Auto',head:true});assert.equal(google.publicEndpointReachable,true);assert.equal(google.routeVerified,true);
  }finally{cp.spawn=original}
});
