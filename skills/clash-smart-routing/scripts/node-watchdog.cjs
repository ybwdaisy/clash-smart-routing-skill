#!/usr/bin/env node
'use strict';
// Local offline-capable recovery worker. Does not call an AI model or read auth.json.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const router = require('./clash-router.cjs'), recovery = require('./node-recovery.cjs');
const follow = require('./client-follow.cjs');
const LABEL = 'io.github.clash-smart-routing.node-watchdog';
const MINUTE = 60000;
const DEFAULTS = Object.freeze({interval: MINUTE, failures: 2, logWindow: 90 * 1000,
  logSeparation: 5000, successCooldown: 10 * MINUTE, failureCooldown: 30 * MINUTE, attemptsPerHour: 3});
const stateFile = ctx => path.join(ctx.stateDir, 'node-watchdog-state.json');
const reportFile = ctx => path.join(ctx.stateDir, 'node-watchdog-report.json');
const undoFile = ctx => path.join(ctx.stateDir, 'node-watchdog-last-recovery.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => router.writePrivate(file, JSON.stringify(value, null, 2) + '\n');
const emptyState = () => ({version: 1, failures: 0, lastCheck: 0, attempts: [], cooldownUntil: 0,
  logCursor: null, handledLogId: 0, transportEvents: [], lastAttempt: null});
function readState(ctx) {
  const s = fs.existsSync(stateFile(ctx)) ? read(stateFile(ctx)) : emptyState();
  if (s.version !== 1 || !Array.isArray(s.attempts) || !Array.isArray(s.transportEvents)) throw Error('Unsupported watchdog state');
  return s;
}
function appRunning() {
  const result = cp.spawnSync('/bin/ps', ['-axo', 'comm='], {encoding: 'utf8', timeout: 3000});
  if (result.status !== 0) throw Error('Cannot determine whether the app is running');
  return result.stdout.split('\n').some(line => /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/.test(line.trim()));
}
function transportEvent(row) {
  if (row.target !== 'codex_core::responses_retry' || !['WARN', 'ERROR'].includes(row.level)) return null;
  const raw = String(row.feedback_log_body || ''), boundary = raw.lastIndexOf('}:');
  const message = boundary < 0 ? raw : raw.slice(boundary + 2);
  if (/\b(?:401|403|429|5\d\d)\b|unauthori[sz]ed|authenticat|quota|usage.limit|rate.limit|token.{0,20}expir|capacity|overload|service.unavailable|internal.server/i.test(message)) return null;
  const reason = /tls handshake eof|TLS close_notify|certificate|tls handshake/i.test(message) ? 'tls-transport'
    : /connection reset|connection refused|broken pipe|timed? out|timeout|dns error|name resolution/i.test(message) ? 'network-transport'
    : /(?:stream connection failed|stream disconnected before completion).*(?:error sending request|Connection failed|connection closed|unexpected eof)/i.test(message) ? 'request-transport' : null;
  return reason ? {id: Number(row.id), at: Number(row.ts) * 1000, reason} : null;
}
function logSignals(state, now, logPath = path.join(os.homedir(), '.codex/logs_2.sqlite')) {
  if (!fs.existsSync(logPath)) return {available: false, cursor: state.logCursor, events: []};
  try {
    const maxResult = cp.spawnSync('/usr/bin/sqlite3', ['-readonly', '-json', '-cmd', '.timeout 1000', logPath,
      'SELECT COALESCE(MAX(id),0) AS latest FROM logs;'], {encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024});
    if (maxResult.status !== 0) throw Error('Log database unavailable');
    const latest = JSON.parse(maxResult.stdout)[0].latest;
    if (state.logCursor === null) return {available: true, cursor: latest, events: []}; // Ignore pre-install history.
    const cursor = Math.max(0, Number(state.logCursor));
    if (!Number.isSafeInteger(cursor)) throw Error('Invalid log cursor');
    const sql = "SELECT id,ts,level,target,feedback_log_body FROM logs WHERE id>" + cursor +
      " AND ts>=" + Math.floor((now - DEFAULTS.logWindow) / 1000) +
      " AND target='codex_core::responses_retry' AND level IN ('WARN','ERROR') ORDER BY id DESC LIMIT 128;";
    const result = cp.spawnSync('/usr/bin/sqlite3', ['-readonly', '-json', '-cmd', '.timeout 1000', logPath, sql],
      {encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024});
    if (result.status !== 0) throw Error('Log read failed');
    return {available: true, cursor: latest, events: (JSON.parse(result.stdout || '[]')).map(transportEvent).filter(Boolean)};
  } catch { return {available: false, cursor: state.logCursor, events: []}; }
}
function notify(kind) {
  const message = kind === 'recovered' ? '已更新「自动选择」的固定节点，ChatGPT / Google / GitHub 实测通过。' : '自动恢复未通过，已停止本轮并冷却 30 分钟。可用 proxy auto status 查看。';
  cp.spawnSync('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 1 of argv) with title "Codex 网络自救"\nend run', message],
    {encoding: 'utf8', timeout: 3000});
}
function probeKind(p) {
  if (p?.serviceChecks) {
    const kinds = p.serviceChecks.map(probeKind);
    return ['local-probe-unavailable', 'route-unverified', 'transport-failure', 'service-response'].find(kind => kinds.includes(kind)) || 'healthy';
  }
  if (p?.localFailure) return 'local-probe-unavailable';
  if (p?.publicEndpointReachable) return p.routeVerified ? 'healthy' : 'route-unverified';
  if (p?.httpStatus) return 'service-response'; // HTTP rejection/server errors are not transport failures.
  return 'transport-failure';
}
async function cycle(ctx, api, state, deps = {}, options = DEFAULTS) {
  const now = deps.now ? deps.now() : Date.now();
  const persist = deps.persist || (() => {}), emit = deps.notify || (() => {});
  const running = deps.appRunning || appRunning, logs = deps.logSignals || logSignals;
  const probe = deps.probe || ((ctx, api, main, node, options) => recovery.probeServices(ctx, api, main, node, {...options, head: true}));
  const attempt = deps.recover || (() => recovery.main(['recover', '--config-dir', ctx.root], {excludeCurrent: true}));
  const s = JSON.parse(JSON.stringify(state));
  s.attempts = s.attempts.filter(t => t > now - 60 * MINUTE && t <= now);
  s.transportEvents = s.transportEvents.filter(e => e.at >= now - options.logWindow && e.at <= now);
  const report = {at: new Date(now).toISOString(), intervalSeconds: options.interval / 1000,
    status: 'checking', authenticatedCodexSessionVerified: false};
  function finish(status, extra = {}) {
    s.lastCheck = now; Object.assign(report, extra, {status, consecutiveFailures: s.failures,
      cooldownUntil: s.cooldownUntil ? new Date(s.cooldownUntil).toISOString() : null, attemptsPastHour: s.attempts.length});
    persist(s, report); return {state: s, report};
  }
  if (!running()) { s.failures = 0; s.transportEvents = []; return finish('idle-app-closed'); }
  const signals = logs(s, now);
  s.logCursor = signals.cursor;
  s.transportEvents = [...s.transportEvents, ...signals.events].filter(e => e.at >= now - options.logWindow && e.at <= now).slice(-64);
  report.codexLogSignalAvailable = signals.available;
  const events = s.transportEvents.filter(e => e.id > s.handledLogId);
  const latestEvent = events.reduce((m, e) => Math.max(m, e.at), 0), firstEvent = events.reduce((m, e) => Math.min(m, e.at), Infinity);
  let sustainedLogFailure = events.length >= 2 && latestEvent - firstEvent >= options.logSeparation;
  report.recentCodexTransportErrors = events.length;
  if (fs.existsSync(path.join(ctx.stateDir, 'node-recovery.lock'))) { s.failures = 0; return finish('paused-node-workflow-busy'); }
  let proxies, plan, current;
  try {
    const config = await api('GET', '/configs');
    if (config.mode !== 'rule') { s.failures = 0; return finish('paused-non-rule-mode'); }
    proxies = (await api('GET', '/proxies')).proxies;
    plan = recovery.inspect(ctx, proxies);
    if (!plan.mainUsesAutomaticGroup) { s.failures = 0; return finish('paused-main-not-automatic'); }
    current = recovery.resolve(proxies, plan.main);
  } catch { s.failures = 0; return finish('paused-client-or-selection-unavailable'); }
  report.mainGroup = plan.main; report.automaticGroup = plan.latencyGroup;
  report.fixedNode = plan.originalFixed; report.selectedNode = current.node;
  const observedSelection = JSON.stringify([plan.main, proxies[plan.main].now, plan.originalFixed, current.node]);
  if (s.observedSelection && s.observedSelection !== observedSelection) {
    s.failures = 0; s.transportEvents = []; sustainedLogFailure = false;
    report.recentCodexTransportErrors = 0;
  }
  s.observedSelection = observedSelection;
  let p;
  try { p = await probe(ctx, api, plan.main, current.node, {via: plan.latencyGroup}); }
  catch { s.failures = 0; return finish('paused-probe-unavailable'); }
  if (!p || typeof p.publicEndpointReachable !== 'boolean') { s.failures = 0; return finish('paused-probe-unavailable'); }
  report.probe = p;
  const kind = probeKind(p);
  if (kind === 'transport-failure') s.failures = now - s.lastCheck <= options.interval * 3 ? s.failures + 1 : 1;
  else s.failures = 0;
  const trigger = sustainedLogFailure ? 'codex-transport-errors' : s.failures >= options.failures ? 'repeated-public-transport-failure' : null;
  if (!trigger) return finish(kind === 'healthy' ? 'healthy' : kind === 'transport-failure' ? 'confirming-failure' : 'needs-attention-' + kind);
  // A local curl/listener failure or an unverified route must not be "fixed" by changing nodes.
  if (['local-probe-unavailable', 'route-unverified'].includes(kind)) return finish('needs-attention-' + kind);
  const fresh = (await api('GET', '/proxies')).proxies;
  if (fresh[plan.main]?.now !== plan.latencyGroup || (fresh[plan.latencyGroup]?.fixed || null) !== plan.originalFixed) {
    s.failures = 0; return finish('paused-selection-changed');
  }
  if (now < s.cooldownUntil) return finish('cooldown', {trigger});
  if (s.attempts.length >= options.attemptsPerHour) return finish('hourly-limit', {trigger});
  s.attempts.push(now); s.cooldownUntil = now + options.failureCooldown;
  s.handledLogId = Math.max(s.handledLogId, ...events.map(e => e.id));
  s.failures = 0;
  persist(s, {...report, status: 'recovering', trigger, attemptsPastHour: s.attempts.length}); // Reserve budget before any mutation.
  let result;
  try { result = await attempt(); }
  catch { result = {status: 'recovery-error'}; }
  const finished = deps.now ? deps.now() : Date.now();
  s.lastAttempt = {at: now, status: result.status};
  s.cooldownUntil = finished + (result.status === 'recovered' ? options.successCooldown : options.failureCooldown);
  report.recovery = result;
  if (deps.saveRecovery) deps.saveRecovery(result);
  const out = finish(result.status === 'recovered' ? 'recovered' : 'recovery-failed', {trigger});
  if (result.status !== 'recovered' || result.changes?.length) emit(result.status === 'recovered' ? 'recovered' : 'failed');
  return out;
}
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function launchPlist(node, script, root) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict><key>Label</key><string>' + LABEL + '</string><key>ProgramArguments</key><array>' +
    [node, script, 'watch', ...(root ? ['--config-dir', root] : [])].map(s => '<string>' + xml(s) + '</string>').join('') +
    '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>' +
    '<key>ExitTimeOut</key><integer>45</integer><key>ProcessType</key><string>Background</string>' +
    '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict></dict></plist>\n';
}
const plistPath = () => path.join(os.homedir(), 'Library/LaunchAgents', LABEL + '.plist');
const serviceTarget = () => 'gui/' + process.getuid() + '/' + LABEL;
function serviceStatus() {
  const r = cp.spawnSync('/bin/launchctl', ['print', serviceTarget()], {encoding: 'utf8', timeout: 3000});
  return {loaded: r.status === 0, running: r.status === 0 && /state = running/.test(r.stdout),
    pid: r.status === 0 ? Number(r.stdout.match(/\bpid = (\d+)/)?.[1]) || null : null};
}
function lock(ctx) {
  const file = path.join(ctx.stateDir, 'node-watchdog.lock');
  fs.mkdirSync(ctx.stateDir, {recursive: true, mode: 0o700});
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid watchdog lock');
    try { process.kill(pid, 0); throw Error('Watchdog already running'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, String(process.pid), {flag: 'wx', mode: 0o600});
  return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
}
async function once(root, extraDeps = {}) {
  const ctx = router.load(root), api = router.controller(ctx);
  return cycle(ctx, api, readState(ctx), {notify, persist: (s, r) => { save(stateFile(ctx), s); save(reportFile(ctx), r); },
    saveRecovery: r => save(undoFile(ctx), r), ...extraDeps});
}
async function watch(root) {
  const ctx = router.load(root), release = lock(ctx); let stopping = false, wake;
  const stop = () => { stopping = true; if (wake) wake(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    while (!stopping) {
      try { await once(root, {recover: async () => stopping ? {status: 'cancelled'} : recovery.main(['recover', '--config-dir', root], {excludeCurrent: true})}); }
      catch { save(reportFile(ctx), {at: new Date().toISOString(), status: 'paused-watchdog-error', authenticatedCodexSessionVerified: false}); }
      if (!stopping) await new Promise(yes => { const timer = setTimeout(yes, DEFAULTS.interval); wake = () => { clearTimeout(timer); yes(); }; });
      wake = null;
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); release(); }
}
async function main(argv) {
  const command = argv[0] || 'status';
  if (!['install', 'uninstall', 'status', 'watch', 'once'].includes(command)) throw Error('Commands: install, uninstall, status, watch, once');
  if (argv.length !== 1 && argv.length !== 0 && (argv.length !== 3 || argv[1] !== '--config-dir')) throw Error('Use --config-dir with an explicit path');
  const explicit = argv[1] ? argv[2] : undefined, automatic = !explicit, file = plistPath();
  if (command === 'watch' && automatic) return follow.run({service: 'node-watchdog', script: fs.realpathSync(__filename), router});
  if (command === 'status' && automatic) {
    const active = router.activeSelection(), follower = follow.status('node-watchdog');
    if (active.status !== 'active') return {...serviceStatus(), mode: 'automatic', followingApp: null, active, follower, report: null};
    const ctx = router.load(active.root);
    return {...serviceStatus(), mode: 'automatic', followingApp: active.appName, active, follower, reportFile: reportFile(ctx),
      report: fs.existsSync(reportFile(ctx)) ? read(reportFile(ctx)) : null, lastAttempt: readState(ctx).lastAttempt};
  }
  if (process.platform === 'darwin' && command === 'uninstall') {
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('node-watchdog.cjs')) throw Error('LaunchAgent name collision');
    await stopService(); if (fs.existsSync(file)) fs.unlinkSync(file);
    return {uninstalled: true, ...serviceStatus(), currentNodePreserved: true};
  }
  const root = router.resolveConfigDir(explicit), ctx = router.load(root);
  if (command === 'status') return {...serviceStatus(), mode: 'fixed', reportFile: reportFile(ctx),
    report: fs.existsSync(reportFile(ctx)) ? read(reportFile(ctx)) : null, lastAttempt: readState(ctx).lastAttempt};
  if (command === 'watch') return watch(root);
  if (command === 'once') { const release = lock(ctx); try { return (await once(root)).report; } finally { release(); } }
  if (process.platform !== 'darwin') throw Error('Automatic service installation supports macOS only');
  if (fs.existsSync(file) && (!fs.readFileSync(file, 'utf8').includes(LABEL) || !fs.readFileSync(file, 'utf8').includes('node-watchdog.cjs')))
    throw Error('LaunchAgent name collision');
  if (command === 'install') {
    await router.verify(ctx, router.controller(ctx));
    const stableNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(p => fs.existsSync(p) && fs.realpathSync(p) === fs.realpathSync(process.execPath)) || process.execPath;
    const expected = launchPlist(stableNode, fs.realpathSync(__filename), automatic ? null : ctx.root);
    const service = serviceStatus();
    if (service.loaded) {
      const previous = fs.readFileSync(file, 'utf8');
      if (previous === expected) return {...service, mode: automatic ? 'automatic' : 'fixed', alreadyInstalled: true, reportFile: reportFile(ctx)};
      await stopService();
    }
    router.writePrivate(file, expected);
    const started = cp.spawnSync('/bin/launchctl', ['bootstrap', 'gui/' + process.getuid(), file], {encoding: 'utf8', timeout: 10000});
    if (started.status !== 0) throw Error('LaunchAgent bootstrap failed; inspect the saved plist');
    return {installed: true, mode: automatic ? 'automatic' : 'fixed', ...serviceStatus(), intervalSeconds: DEFAULTS.interval / 1000, reportFile: reportFile(ctx)};
  }
}
async function stopService() {
  if (serviceStatus().loaded) {
    const stopped = cp.spawnSync('/bin/launchctl', ['bootout', serviceTarget()], {encoding: 'utf8', timeout: 50000});
    if (stopped.status !== 0) throw Error('Watchdog could not be stopped; plist retained');
    for (let i = 0; i < 90 && serviceStatus().loaded; i++) await new Promise(yes => setTimeout(yes, 500));
    if (serviceStatus().loaded) throw Error('Watchdog is still stopping; plist retained until exit is confirmed');
  }
}
if (require.main === module) main(process.argv.slice(2)).then(r => { if (r) console.log(JSON.stringify(r, null, 2)); })
  .catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = {DEFAULTS, emptyState, probeKind, transportEvent, logSignals, cycle, launchPlist, main, LABEL};
