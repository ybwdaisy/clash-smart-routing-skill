#!/usr/bin/env node
'use strict';
// Preserve UI main -> automatic group; recover by pinning a node inside that group.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const net = require('node:net'), cp = require('node:child_process'), os = require('node:os');
const router = require('./clash-router.cjs');
const PUBLIC_URL = 'https://chatgpt.com/robots.txt';
const LIMIT_MS = 200, TIMEOUT_MS = 5000, CONCURRENCY = 6;
const NON_PROXY = /^(Direct|Reject|RejectDrop|Pass|Dns|Compatible)$/i;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const routeFor = name => '/proxies/' + encodeURIComponent(name);

function isHongKong(name) {
  return /香港|🇭🇰|(^|[^A-Za-z])(?:HKG?|Hong[ _-]*Kong)([^A-Za-z]|$)/i.test(String(name).normalize('NFKC'));
}
function region(name) {
  const s = String(name).normalize('NFKC');
  if (isHongKong(s)) return null;
  if (/日本|🇯🇵|\bJapan\b|\b(?:JP|JPN)(?=[\d\W_]|$)/i.test(s)) return 'JP';
  if (/台湾|台灣|臺灣|🇹🇼|\bTaiwan\b|\b(?:TW|TWN)(?=[\d\W_]|$)/i.test(s)) return 'TW';
  if (/美国|美國|🇺🇸|\bUnited[\s_-]*States\b|\b(?:US|USA)(?=[\d\W_]|$)/i.test(s)) return 'US';
  return null;
}
function resolve(proxies, name) {
  const chain = [], seen = new Set();
  while (true) {
    if (seen.has(name)) throw Error('Proxy selection cycle');
    seen.add(name); chain.push(name);
    const p = proxies[name];
    if (!p) throw Error('Selected proxy is missing');
    if (p.now) { name = p.now; continue; }
    if (p.all || NON_PROXY.test(p.type)) throw Error('Selection does not resolve to a real proxy');
    return {chain, node: name};
  }
}
function inspect(ctx, proxies, explicitGroup) {
  const settingsFile = path.join(ctx.stateDir, 'settings.json');
  const settings = fs.existsSync(settingsFile) ? readJSON(settingsFile) : {};
  const main = router.engine.upstreamTarget(ctx.config, settings), group = proxies[main];
  if (!group || group.type !== 'Selector' || !Array.isArray(group.all) || !group.now)
    throw Error('The existing main group must be a manual Selector; no group will be created');
  let latencyGroup = explicitGroup;
  if (!latencyGroup && proxies[group.now]?.type === 'URLTest') latencyGroup = group.now;
  if (!latencyGroup) {
    const matches = group.all.filter(n => proxies[n]?.type === 'URLTest');
    if (matches.length === 1) latencyGroup = matches[0];
  }
  const auto = proxies[latencyGroup];
  if (!latencyGroup || !group.all.includes(latencyGroup) || auto?.type !== 'URLTest' || !auto.testUrl)
    throw Error('Identify the existing automatic selection group using --latency-group; no URL/group is guessed');
  const url = new URL(auto.testUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Unsupported latency URL');
  const candidates = [...new Set(auto.all || [])].filter(n => {
    const p = proxies[n];
    return !isHongKong(n) && p && !p.all && !NON_PROXY.test(p.type);
  }).map(name => ({name, region: region(name)}));
  if (!candidates.length) throw Error('No non-Hong-Kong leaf nodes selectable in the automatic group');
  if (candidates.length > 256) throw Error('More than 256 eligible nodes; narrow the existing group before running');
  const alias = proxies[router.engine.group];
  if (alias && (alias.type !== 'Selector' || alias.now !== main || alias.all?.length !== 1 || alias.all[0] !== main))
    throw Error('AI alias no longer follows the UI main selector; diagnose without changing it');
  return {main, originalSelection: group.now, latencyGroup, originalFixed: auto.fixed || null,
    mainUsesAutomaticGroup: group.now === latencyGroup, testURL: auto.testUrl, candidates,
    aiAliasFollowsMain: alias ? true : null};
}
async function measure(api, name, url) {
  try {
    const result = await api('GET', routeFor(name) + '/delay?url=' + encodeURIComponent(url) + '&timeout=' + TIMEOUT_MS);
    if (!Number.isFinite(result?.delay) || result.delay <= 0) throw Error('Invalid/zero delay');
    return {name, region: region(name), delayMs: result.delay, reachable: true};
  } catch { return {name, region: region(name), delayMs: null, reachable: false}; }
}
async function pool(items, count, fn) {
  const results = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({length: Math.min(items.length, count)}, async () => {
    while (cursor < items.length) { const i = cursor++; results[i] = await fn(items[i], i); }
  }));
  return results;
}
async function freePort() {
  const s = net.createServer();
  await new Promise((yes, no) => { s.on('error', no); s.listen(0, '127.0.0.1', yes); });
  const port = s.address().port;
  await new Promise((yes, no) => s.close(e => e ? no(e) : yes())); return port;
}
async function publicProbe(ctx, api, main, selected, options = {}) {
  const config = await api('GET', '/configs'), port = config['mixed-port'] || config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('An active local HTTP/mixed port is required');
  const sourcePort = await freePort();
  let output = '', done = false, exitCode = null, observed = null, launchFailed = false;
  const child = cp.spawn('curl', ['--silent', '--show-error', '--noproxy', '', '--proxy', 'http://127.0.0.1:' + port,
    '--local-port', String(sourcePort), '--connect-timeout', '6', '--max-time', '12', '--max-filesize', '65536',
    ...(options.head ? ['--head'] : ['--range', '0-1023']), '--output', os.devNull, '--write-out', '%{json}', PUBLIC_URL], {stdio: ['ignore', 'pipe', 'ignore']});
  child.stdout.on('data', b => { if (output.length < 32768) output += b; });
  const closed = new Promise(yes => {
    child.on('error', () => { launchFailed = true; done = true; yes(); });
    child.on('close', code => { exitCode = code; done = true; yes(); });
  });
  try {
    while (!done) {
      const connections = (await api('GET', '/connections')).connections || [];
      const c = connections.find(c => Number(c.metadata?.sourcePort) === sourcePort && c.metadata?.host === 'chatgpt.com');
      if (c) observed = {rule: c.rule, rulePayload: c.rulePayload, chains: c.chains || []};
      if (!done) await new Promise(yes => setTimeout(yes, 60));
    }
  } finally { if (!done) child.kill(); await closed; }
  let timing = {}; try { timing = JSON.parse(output); } catch {}
  const publicEndpointReachable = !launchFailed && exitCode === 0 && timing.http_code === 200;
  const routeVerified = Boolean(observed && observed.chains.includes(main) && observed.chains.includes(selected) &&
    (!options.via || observed.chains.includes(options.via)) && !observed.chains.includes('DIRECT'));
  return {url: PUBLIC_URL, publicEndpointReachable, routeVerified, httpStatus: timing.http_code || null,
    exitCode, localFailure: launchFailed || exitCode === 7,
    tlsMs: Number.isFinite(timing.time_appconnect) ? Math.round(timing.time_appconnect * 1000) : null,
    totalMs: Number.isFinite(timing.time_total) ? Math.round(timing.time_total * 1000) : null,
    ...(observed ? {connection: observed} : {}), authenticatedCodexSessionVerified: false};
}
async function restore(api, undo) {
  if (undo?.version !== 2) throw Error('Legacy direct-main rollback is disabled; no main group will be changed');
  const {main, group, selected, previousFixed} = undo;
  const proxies = (await api('GET', '/proxies')).proxies;
  if (proxies[main]?.now !== group) return {restored: false, reason: 'main-selection-changed-externally'};
  const auto = proxies[group];
  if (auto?.type !== 'URLTest') return {restored: false, reason: 'automatic-group-unavailable'};
  if ((auto.fixed || null) === previousFixed) return {restored: true, reason: 'already-original-selection'};
  if (auto.fixed !== selected) return {restored: false, reason: 'selection-changed-externally'};
  if (previousFixed && !auto.all.includes(previousFixed)) return {restored: false, reason: 'previous-selection-unavailable'};
  if (previousFixed) await api('PUT', routeFor(group), {name: previousFixed});
  else await api('DELETE', routeFor(group));
  const after = (await api('GET', '/proxies')).proxies;
  return {restored: after[main]?.now === group && (after[group]?.fixed || null) === previousFixed,
    reason: previousFixed ? 'original-fixed-node' : 'original-automatic-mode'};
}
async function run(ctx, api, command, options = {}, deps = {}) {
  const probe = deps.probe || publicProbe, hash = deps.hash || (() => digest(ctx.subscriptionFile));
  const saveUndo = deps.saveUndo || (() => {}), cancelled = deps.cancelled || (() => false);
  const initialHash = hash(), proxies = (await api('GET', '/proxies')).proxies;
  const plan = inspect(ctx, proxies, options.latencyGroup);
  const report = {version: 1, command, startedAt: new Date().toISOString(), ...plan, greenThresholdMs: LIMIT_MS,
    changes: [], authenticatedCodexSessionVerified: false};
  delete report.candidates;
  if (command === 'check') {
    const current = resolve(proxies, plan.main);
    report.current = current;
    report.probe = await probe(ctx, api, plan.main, current.node, {via: plan.mainUsesAutomaticGroup ? plan.latencyGroup : undefined});
    report.status = report.probe.publicEndpointReachable && report.probe.routeVerified ? 'public-endpoint-ok' : 'needs-attention';
    return report;
  }
  if (!plan.mainUsesAutomaticGroup) { report.status = 'paused-main-not-automatic'; return report; }
  const onProgress = options.onProgress || (() => {});
  onProgress({stage: 'testing', total: plan.candidates.length});
  const measured = await pool(plan.candidates, CONCURRENCY, async c => {
    if (cancelled()) return {...c, reachable: false, delayMs: null};
    return measure(api, c.name, plan.testURL);
  });
  const ranked = measured.filter(x => x.reachable).sort((a, b) => a.delayMs - b.delayMs || a.name.localeCompare(b.name));
  report.measurements = measured; report.tested = measured.length; report.reachable = ranked.length;
  report.fastest = ranked[0] || null;
  if (cancelled()) { report.status = 'cancelled'; return report; }
  if (!ranked.length || ranked[0].delayMs >= LIMIT_MS) { report.status = 'no-green-candidate'; return report; }
  if (command === 'plan') { report.status = 'planned'; return report; }
  const selected = ranked[0].name;
  const fresh = (await api('GET', '/proxies')).proxies;
  const currentPlan = inspect(ctx, fresh, options.latencyGroup);
  if (fresh[plan.main]?.now !== plan.latencyGroup || currentPlan.main !== plan.main || currentPlan.testURL !== plan.testURL ||
      currentPlan.originalFixed !== plan.originalFixed ||
      !currentPlan.candidates.some(c => c.name === selected) || hash() !== initialHash)
    throw Error('Main selection, subscription or candidate membership changed during measurement; stopped without switching');
  if (cancelled()) { report.status = 'cancelled'; return report; }
  const changed = selected !== plan.originalFixed;
  const undo = {version: 2, main: plan.main, group: plan.latencyGroup, previousFixed: plan.originalFixed,
    selected, subscriptionHash: initialHash, createdAt: new Date().toISOString()};
  let attempted = false;
  try {
    if (changed) {
      saveUndo(undo); attempted = true;
      await api('PUT', routeFor(plan.latencyGroup), {name: selected});
      report.changes.push({group: plan.latencyGroup, beforeFixed: plan.originalFixed, afterFixed: selected});
    }
    onProgress({stage: 'verifying', selected});
    const after = (await api('GET', '/proxies')).proxies;
    if (after[plan.main]?.now !== plan.latencyGroup || after[plan.latencyGroup]?.fixed !== selected ||
        after[plan.latencyGroup]?.now !== selected) throw Error('Main -> automatic -> fixed node hierarchy was not retained');
    inspect(ctx, after, options.latencyGroup);
    report.finalLatency = await measure(api, plan.main, plan.testURL);
    report.probe = await probe(ctx, api, plan.main, selected, {via: plan.latencyGroup});
    const final = (await api('GET', '/proxies')).proxies;
    if (cancelled() || final[plan.main]?.now !== plan.latencyGroup || final[plan.latencyGroup]?.fixed !== selected ||
        final[plan.latencyGroup]?.now !== selected || hash() !== initialHash)
      throw Error('Cancelled or configuration/selection changed during verification');
    inspect(ctx, final, options.latencyGroup);
    if (!report.finalLatency.reachable || report.finalLatency.delayMs >= LIMIT_MS ||
        !report.probe.publicEndpointReachable || !report.probe.routeVerified)
      throw Error('Latency or public endpoint/connection-chain verification failed');
    report.selected = selected; report.status = 'recovered'; report.subscriptionUnchanged = true; report.hierarchyPreserved = true;
  } catch (e) {
    report.status = 'verification-failed'; report.failure = e.message;
    if (attempted) {
      try { report.rollback = await restore(api, undo); }
      catch (error) { report.rollback = {restored: false, reason: error.message}; }
    }
  }
  return report;
}
function argsOf(argv) {
  const command = argv[0] || 'check', opts = {};
  if (!['check', 'plan', 'recover', 'status', 'rollback'].includes(command)) throw Error('Commands: check, plan, recover, status, rollback');
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] === '--json') { if (opts['--json']) throw Error('Duplicate option'); opts['--json'] = true; i--; continue; }
    if (!['--config-dir', '--latency-group'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Unknown/missing option');
    if (opts[argv[i]]) throw Error('Duplicate option'); opts[argv[i]] = argv[i + 1];
  }
  return {command, opts};
}
async function main(argv, options = {}) {
  const {command, opts} = argsOf(argv);
  const following = (process.platform === 'darwin' && !opts['--config-dir']) || process.env.CLASH_NET_FOLLOW_ACTIVE === '1';
  const ctx = router.load(router.resolveConfigDir(opts['--config-dir'])), api = router.controller(ctx,
    {followActive: following}), latest = path.join(ctx.stateDir, 'node-recovery-latest.json');
  const info = {client: ctx.client, clientName: ctx.client === 'flclash' ? 'FlClash' : 'Clash Verge',
    selectionMode: following ? 'automatic' : opts['--config-dir'] ? 'fixed' : 'saved', configDirectory: ctx.root};
  options.onClient?.(info);
  if (command === 'status') return {...readJSON(latest), ...info};
  fs.mkdirSync(ctx.stateDir, {recursive: true, mode: 0o700});
  const lock = path.join(ctx.stateDir, 'node-recovery.lock'), undoFile = path.join(ctx.stateDir, 'node-recovery-undo.json');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()})); }
  catch (e) { if (e.code === 'EEXIST') throw Error('Another node workflow holds the lock; do not run concurrent recovery'); throw e; }
  let cancelled = false;
  const cancel = () => { cancelled = true; }; process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    let result;
    if (command === 'rollback') {
      const undo = readJSON(undoFile), proxies = (await api('GET', '/proxies')).proxies;
      const plan = inspect(ctx, proxies, opts['--latency-group']);
      if (plan.main !== undo.main || plan.latencyGroup !== undo.group) throw Error('Main/automatic group changed or legacy rollback; stopped');
      result = {command, ...(await restore(api, undo))};
      result.status = result.restored ? 'rolled-back' : 'rollback-skipped';
    } else result = await run(ctx, api, command, {latencyGroup: opts['--latency-group'],
      onProgress: p => process.stderr.write(p.stage === 'testing' ? 'Testing ' + p.total + ' non-Hong-Kong nodes…\n' : 'Verifying the selected main node…\n')},
    {cancelled: () => cancelled, saveUndo: undo => router.writePrivate(undoFile, JSON.stringify(undo, null, 2) + '\n')});
    result.finishedAt = new Date().toISOString();
    Object.assign(result, info);
    router.writePrivate(latest, JSON.stringify(result, null, 2) + '\n');
    return {...result, reportFile: latest};
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
}
function clientLine(r) {
  const mode = {automatic: '自动跟随', fixed: '指定目录', saved: '已保存目录'}[r.selectionMode] || r.selectionMode;
  return '当前客户端：' + r.clientName + (mode ? '（' + mode + '）' : '');
}
function summary(r, {includeClient = true} = {}) {
  const labels = {recovered: '自动选择的固定节点已更新，并通过公开连通性验证', planned: '测速预览完成，未切换节点',
    'paused-main-not-automatic': '主组当前未指向自动选择，已暂停，保留你的选择',
    'public-endpoint-ok': '当前 ChatGPT 公开端点和连接链路正常', 'needs-attention': '当前公开连通性检查未通过',
    'no-green-candidate': '没有低于 200ms 的可用候选，未切换节点', 'verification-failed': '验证失败，已停止',
    cancelled: '已取消', 'rolled-back': '已恢复自动组原固定节点或自动模式', 'rollback-skipped': '当前选择已变化，未覆盖'};
  const lines = [...(includeClient && r.clientName ? [clientLine(r)] : []), labels[r.status] || r.status];
  if (r.tested !== undefined) lines.push('测速：' + r.tested + ' 个非香港节点，' + r.reachable + ' 个有响应');
  if (r.fastest) lines.push('最快：' + r.fastest.name + ' · ' + r.fastest.delayMs + 'ms');
  if (r.selected) lines.push('当前主节点：' + r.selected);
  if (r.current) lines.push('当前链路：' + r.current.chain.join(' → '));
  if (r.finalLatency) lines.push('主选择复测：' + (r.finalLatency.delayMs ?? 'timeout') + 'ms');
  if (r.probe) lines.push('ChatGPT：HTTP ' + (r.probe.httpStatus ?? '无响应') + '，TLS ' + (r.probe.tlsMs ?? '?') + 'ms，总计 ' + (r.probe.totalMs ?? '?') + 'ms，实际链路' + (r.probe.routeVerified ? '已核对' : '未确认'));
  if (r.failure) lines.push(r.failure);
  if (r.rollback) lines.push('回退：' + (r.rollback.restored ? '已恢复原选择' : '未覆盖当前选择；' + r.rollback.reason));
  if (r.reportFile) lines.push('报告：' + r.reportFile);
  lines.push('公开探测不验证 Codex 登录后的请求，请回到 Codex 发送一条消息确认。');
  return lines.join('\n');
}
if (require.main === module) main(process.argv.slice(2), {onClient: r => {if (!process.argv.includes('--json')) console.log(clientLine(r));}}).then(r => {
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : summary(r, {includeClient: false}));
  if (!['planned', 'recovered', 'public-endpoint-ok', 'rolled-back'].includes(r.status)) process.exitCode = 1;
}).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = {isHongKong, region, resolve, inspect, measure, pool, publicProbe, restore, run, argsOf, main, summary};
