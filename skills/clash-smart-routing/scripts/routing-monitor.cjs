#!/usr/bin/env node
'use strict';
// Local, bounded learning. No subscription writes, authenticated requests or connection closes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const https = require('node:https'), dns = require('node:dns'), net = require('node:net'), cp = require('node:child_process');
const YAML = require('yaml');
const router = require('./clash-router.cjs');
const audit = require('./traffic-audit.cjs');
const {APNS_RANGES} = require('./shadowrocket.cjs');
const NAME = router.engine.prefix + 'learned', LABEL = 'io.github.clash-smart-routing.monitor';
const MINUTE = 60000, HOUR = 60 * MINUTE;
const DEFAULTS = Object.freeze({interval: MINUTE, confirmAfter: MINUTE, lease: HOUR, recheck: 10 * MINUTE,
  failureBackoff: HOUR, maxProbes: 3, dailyProbes: 200, maxEntries: 256});
const RESERVED = audit.ranges(['0.0.0.0/8', ...router.engine.privateRanges, '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3',
  '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].join('\n'));
const APNS = audit.ranges(APNS_RANGES.join('\n'));
function publicIP(ip) {
  const parsed = audit.address(ip);
  if (!parsed || audit.contains(RESERVED, ip)) return false;
  // Deliberately exclude mapped/transition/link-local IPv6 from learning.
  return parsed.family === 4 || (parsed.value >> 125n) === 1n;
}
function hostname(value) {
  const s = String(value || '').toLowerCase().replace(/\.$/, '');
  if (s.length > 253 || !s.includes('.') || net.isIP(s) ||
      !s.split('.').every(p => p.length > 0 && p.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p)) ||
      /\.(local|lan|internal|localhost|onion|test|invalid|example)$/.test(s)) return null;
  return s;
}
function proxied(c) { return (c.chains || []).length > 0 && !(c.chains || []).some(x => /^(DIRECT|COMPATIBLE|REJECT.*)$/i.test(x)); }
function protectedTarget(host, ip, protectedHost, c = {}) {
  return protectedHost(host) || router.engine.guards.some(d => host === d || host.endsWith('.' + d)) ||
    ['push.apple.com', 'push-apple.com.akadns.net', 'courier-push-apple.com.akadns.net'].some(d => host === d || host.endsWith('.' + d)) ||
    audit.contains(APNS, ip) || ['ai-guard', 'ai', 'apple-ai', 'github'].some(k => c.rulePayload === router.engine.prefix + k);
}
// Split rule syntax without treating commas inside a logical expression as separators.
function fields(text) {
  let depth = 0, start = 0; const result = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (depth < 0) return [];
    if (text[i] === ',' && depth === 0) { result.push(text.slice(start, i)); start = i + 1; }
  }
  if (depth) return [];
  return result.concat(text.slice(start));
}
function matches(text, host, ip) {
  const [raw, value] = fields(text), type = String(raw).toUpperCase();
  if (['AND', 'OR', 'NOT'].includes(type)) {
    if (!value?.startsWith('(') || !value.endsWith(')')) return null;
    const parts = fields(value.slice(1, -1));
    if (!parts.length || parts.some(p => !p.startsWith('(') || !p.endsWith(')'))) return null;
    const values = parts.map(p => matches(p.slice(1, -1), host, ip));
    if (type === 'AND') return values.includes(false) ? false : values.includes(null) ? null : true;
    if (type === 'OR') return values.includes(true) ? true : values.includes(null) ? null : false;
    return values.length !== 1 || values[0] === null ? null : !values[0];
  }
  if (type === 'DOMAIN') return host === String(value).toLowerCase();
  if (type === 'DOMAIN-SUFFIX') return host === String(value).toLowerCase() || host.endsWith('.' + String(value).toLowerCase());
  if (type === 'DOMAIN-KEYWORD') return host.includes(String(value).toLowerCase());
  if (type === 'NETWORK') return String(value).toLowerCase() === 'tcp';
  if (type === 'DST-PORT') return String(value).split('/').some(p => {
    const [a, b = a] = p.split('-').map(Number); return 443 >= a && 443 <= b;
  });
  if (type === 'MATCH') return true;
  if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
    try { return audit.contains(audit.ranges(value), ip); } catch { return null; }
  }
  return null;
}
function rejectRisk(rules, host, ip) {
  return rules.some(r => {
    const f = fields(r);
    if (!f.some(x => /^REJECT(?:-DROP)?$/i.test(x))) return false;
    return matches(r, host, ip) !== false; // Unknown rejection predicates never become a bypass.
  });
}
function keyOf(host, ip) { return host + '|' + ip; }
function emptyState() { return {version: 1, entries: {}, budget: {day: '', used: 0}, totals: {probes: 0, learned: 0, revoked: 0}}; }
function resultFor(previous, host, ip, ok, now, options = DEFAULTS) {
  const entry = {...previous, host, ip, lastProbe: now, lastSeen: previous?.lastSeen || now};
  if (!ok) { entry.successes = 0; entry.expires = 0; entry.nextProbe = now + options.failureBackoff; return entry; }
  const consecutive = previous?.successes > 0 && now - previous.lastProbe <= options.lease;
  const separated = !previous || now - previous.lastProbe >= options.confirmAfter;
  entry.successes = consecutive ? previous.successes + (separated ? 1 : 0) : 1;
  if (entry.successes >= 2) entry.expires = now + options.lease;
  entry.nextProbe = now + (entry.expires > now ? options.recheck : options.confirmAfter);
  return entry;
}
function payloadFor(state, now, protectedHost, originalRules = []) {
  return Object.values(state.entries).filter(e => e.expires > now && hostname(e.host) && publicIP(e.ip) &&
    !protectedTarget(e.host, e.ip, protectedHost) && !rejectRisk(originalRules, e.host, e.ip)).map(e =>
    'AND,((DOMAIN,' + e.host + '),(IP-CIDR' + (net.isIP(e.ip) === 6 ? '6' : '') + ',' + e.ip + '/' +
    (net.isIP(e.ip) === 6 ? '128' : '32') + '),(DST-PORT,443),(NETWORK,TCP))').sort();
}
function directProbe(host, ip, options = {}) {
  if (!hostname(host) || !publicIP(ip)) return Promise.resolve(false);
  return new Promise(resolve => {
    let done = false, timer;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); req.destroy(); resolve(ok); };
    // IP is pinned, TLS verifies the hostname, HEAD carries no path/query/cookies/tokens.
    const req = (options.request || https.request)({hostname: ip, port: 443, servername: host, method: 'HEAD', path: '/', agent: false,
      rejectUnauthorized: true, maxHeaderSize: 16384, headers: {Host: host, 'User-Agent': 'clash-smart-routing-probe/1', Connection: 'close'},
      ...(options.ca ? {ca: options.ca} : {})}, res => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      res.destroy(); finish(ok);
    });
    timer = setTimeout(() => finish(false), options.timeout || 4000);
    req.on('error', () => finish(false)); req.end();
  });
}
async function resolveIP(host, observed) {
  if (publicIP(observed)) return observed;
  let timer;
  try {
    const answers = await Promise.race([dns.promises.lookup(host, {all: true}), new Promise(resolve => { timer = setTimeout(() => resolve([]), 3000); })]);
    return answers.map(x => x.address).find(publicIP) || null;
  } catch { return null; } finally { clearTimeout(timer); }
}
function classifiers(ctx) {
  const port = ctx.config['mixed-port'] || ctx.config.port, proxy = port ? 'http://127.0.0.1:' + port : null;
  const chinaIPs = audit.ranges(audit.cached(ctx, 'geoip/cn', 'cn-ip.list', proxy));
  const chinaHost = audit.domains(audit.cached(ctx, 'geosite/cn', 'cn-domain.list', proxy));
  const guards = ['category-ai-!cn', 'apple-intelligence', 'github'].map(k => audit.domains(audit.cached(ctx, 'geosite/' + k, 'guard-' + k + '.list', proxy)));
  return {chinaIPs, chinaHost, protectedHost: host => guards.some(fn => fn(host))};
}
function stateFile(ctx) { return path.join(ctx.stateDir, 'monitor-state.json'); }
function readState(ctx) {
  const state = fs.existsSync(stateFile(ctx)) ? JSON.parse(fs.readFileSync(stateFile(ctx), 'utf8')) : emptyState();
  if (state.version !== 1 || !state.entries || !state.budget || !state.totals) throw Error('Unsupported monitor state; inspect before reset');
  return state;
}
async function publish(ctx, api, payload) {
  const file = path.join(ctx.stateDir, 'learned.yaml'), text = YAML.stringify({payload});
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'payload: []\n';
  const current = YAML.parse(before)?.payload;
  if (JSON.stringify(current) === JSON.stringify(payload)) {
    const live = (await api('GET', '/providers/rules')).providers?.[NAME];
    if (live?.ruleCount === payload.length) return false;
  }
  router.writePrivate(file, text);
  try {
    await api('PUT', '/providers/rules/' + encodeURIComponent(NAME));
    const live = (await api('GET', '/providers/rules')).providers?.[NAME];
    if (live?.ruleCount !== payload.length) throw Error('Learning provider verification failed');
  } catch (e) {
    router.writePrivate(file, before);
    try { await api('PUT', '/providers/rules/' + encodeURIComponent(NAME)); }
    catch { throw Error('Learning update and rollback failed; stop the monitor and reload Clash'); }
    throw e;
  }
  return true;
}
async function clearLearned(ctx, api) {
  const live = (await api('GET', '/providers/rules')).providers?.[NAME];
  if (live) return publish(ctx, api, []);
  // A subscription refresh may have removed the provider entirely. Neutralize its
  // backing file before repairing the base overlay, without PUTting a missing provider.
  router.writePrivate(path.join(ctx.stateDir, 'learned.yaml'), 'payload: []\n');
  return false;
}
function record(ctx, report) {
  router.writePrivate(path.join(ctx.stateDir, 'monitor-report.json'), JSON.stringify(report, null, 2));
  const file = path.join(ctx.stateDir, 'monitor.log');
  if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + '.1');
  fs.appendFileSync(file, JSON.stringify(report) + '\n', {mode: 0o600}); fs.chmodSync(file, 0o600);
  return report;
}
async function cycle(ctx, deps = {}) {
  const api = deps.api || router.controller(ctx), now = deps.now ?? Date.now(), options = {...DEFAULTS, ...deps.options};
  const state = readState(ctx), live = await api('GET', '/configs');
  if (live.mode !== 'rule' || live.tun?.enable || ctx.config.tun?.enable) {
    await clearLearned(ctx, api);
    return record(ctx, {at: new Date(now).toISOString(), status: 'paused', reason: live.mode !== 'rule' ? 'rule-mode-required' : 'tun-probe-path-unverified', learnedRules: 0});
  }
  let repaired = false;
  try { await router.verify(ctx, api); state.repairAttempted = false; }
  catch {
    // One repair per incident; user script edits cause the existing installer to refuse safely.
    await clearLearned(ctx, api);
    if (state.repairAttempted) return record(ctx, {at: new Date(now).toISOString(), status: 'paused', reason: 'overlay-repair-needs-review', learnedRules: 0});
    state.repairAttempted = true; router.writePrivate(stateFile(ctx), JSON.stringify(state));
    if (deps.repair) ctx = await deps.repair(ctx);
    else { await router.main(['apply', '--config-dir', ctx.root]); ctx = router.load(ctx.root); }
    repaired = true; await router.verify(ctx, api);
  }
  let classified;
  try { classified = deps.classified || classifiers(ctx); }
  catch {
    await clearLearned(ctx, api);
    return record(ctx, {at: new Date(now).toISOString(), status: 'paused', reason: 'classification-refresh-failed', learnedRules: 0});
  }
  const {chinaIPs, chinaHost, protectedHost} = classified;
  const connections = (await api('GET', '/connections')).connections || [];
  const summary = audit.summarize(connections, chinaIPs, chinaHost, ctx.subscription.rules || []);
  const candidates = new Map(), consideredHosts = new Set(); let unresolved = 0, protectedCount = 0;
  // Only learn original fallback traffic, or revalidate a previously learned exact endpoint.
  for (const c of [...connections].sort((a, b) => (b.download || 0) - (a.download || 0))) {
    const m = c.metadata || {}, host = hostname(m.host);
    if (!host || String(m.network).toLowerCase() !== 'tcp' || Number(m.destinationPort) !== 443) continue;
    if (protectedTarget(host, m.destinationIP, protectedHost, c)) { protectedCount++; continue; }
    const learned = c.rulePayload === NAME;
    if (!(proxied(c) && /^(match|final)$/i.test(c.rule)) && !learned) continue;
    // Avoid unbounded DNS work: only the largest few new endpoints each cycle.
    if (consideredHosts.size >= options.maxProbes * 2) break;
    if (consideredHosts.has(host)) continue;
    consideredHosts.add(host);
    const ip = await (deps.resolveIP || resolveIP)(host, m.destinationIP);
    if (!ip || !publicIP(ip)) { unresolved++; continue; }
    if (protectedTarget(host, ip, protectedHost, c) || rejectRisk(ctx.subscription.rules || [], host, ip)) continue;
    const key = keyOf(host, ip), old = state.entries[key];
    if (old) old.lastSeen = now;
    if (old && old.nextProbe > now) continue;
    candidates.set(key, {host, ip, domestic: chinaHost(host) || audit.contains(chinaIPs, ip)});
  }
  const day = new Date(now).toISOString().slice(0, 10);
  if (state.budget.day !== day) state.budget = {day, used: 0};
  let probes = 0, passed = 0;
  for (const [key, candidate] of candidates) {
    if (probes >= options.maxProbes || state.budget.used >= options.dailyProbes) break;
    // Persist budget before network activity, so restarting cannot bypass its daily cap.
    state.budget.used++; state.totals.probes++; probes++;
    router.writePrivate(stateFile(ctx), JSON.stringify(state));
    const previous = state.entries[key];
    const ok = await (deps.probe || directProbe)(candidate.host, candidate.ip); if (ok) passed++;
    const updated = resultFor(previous, candidate.host, candidate.ip, ok, now, options);
    updated.lastSeen = now;
    if (updated.expires > now && !(previous?.expires > now)) state.totals.learned++;
    if (!(updated.expires > now) && previous?.expires > now) state.totals.revoked++;
    state.entries[key] = updated;
  }
  // Recheck active learned endpoints; idle endpoints expire without extra requests.
  state.entries = Object.fromEntries(Object.entries(state.entries).filter(([, e]) => now - e.lastSeen < 24 * HOUR)
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, options.maxEntries));
  const payload = payloadFor(state, now, protectedHost, ctx.subscription.rules || []);
  const changed = await publish(ctx, api, payload);
  state.repairAttempted = false; router.writePrivate(stateFile(ctx), JSON.stringify(state));
  return record(ctx, {at: new Date(now).toISOString(), status: 'running', repaired, tun: false,
    activeConnections: summary.activeConnections, proxiedConnections: summary.proxiedConnections,
    unknownDestinationIPs: summary.unknownDestinationIPs, domesticProxyCandidates: summary.domesticProxyCandidates,
    topProxied: summary.topProxied.slice(0, 5), protectedConnections: protectedCount, unresolvedCandidates: unresolved,
    probes, passed, dailyProbes: state.budget.used, dailyLimit: options.dailyProbes, learnedRules: payload.length, changed,
    totals: state.totals, note: 'Existing connections are not interrupted. HEAD success is endpoint reachability, not application/login proof. Lease removal requires a running monitor.'});
}
function lock(ctx) {
  const file = path.join(ctx.stateDir, 'monitor.lock'); fs.mkdirSync(ctx.stateDir, {recursive: true, mode: 0o700});
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid monitor lock; inspect it before removing');
    try { process.kill(pid, 0); throw Error('Monitor already running; use status instead'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    fs.rmSync(file);
  }
  fs.writeFileSync(file, String(process.pid), {flag: 'wx', mode: 0o600});
  return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file); };
}
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function launchPlist(node, script, root) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict><key>Label</key><string>' + LABEL + '</string><key>ProgramArguments</key><array>' +
    [node, script, 'watch', '--config-dir', root].map(s => '<string>' + xml(s) + '</string>').join('') +
    '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>' +
    '<key>ProcessType</key><string>Background</string><key>EnvironmentVariables</key><dict><key>PATH</key>' +
    '<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict></dict></plist>\n';
}
function plistPath() { return path.join(os.homedir(), 'Library/LaunchAgents', LABEL + '.plist'); }
function serviceRunning() {
  return process.platform === 'darwin' && cp.spawnSync('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + LABEL], {encoding: 'utf8'}).status === 0;
}
async function install(ctx) {
  if (process.platform !== 'darwin') throw Error('Automatic background installation currently supports macOS; use watch in your service manager elsewhere');
  const file = plistPath();
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    if (!old.includes('routing-monitor.cjs') || !old.includes(LABEL)) throw Error('LaunchAgent name collision');
  }
  // Verify prerequisites before applying or scheduling anything.
  await router.verify(ctx, router.controller(ctx));
  if (serviceRunning()) {
    const stopped = cp.spawnSync('/bin/launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], {encoding: 'utf8'});
    if (stopped.status !== 0) throw Error('Cannot stop the existing monitor');
  }
  await waitStopped(ctx);
  const settings = path.join(ctx.stateDir, 'enable-monitor.json'); router.writePrivate(settings, '{"monitorEnabled":true}\n');
  await router.main(['apply', '--config-dir', ctx.root, '--settings-file', settings]);
  const stableNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(p => fs.existsSync(p) && fs.realpathSync(p) === fs.realpathSync(process.execPath)) || process.execPath;
  router.writePrivate(file, launchPlist(stableNode, fs.realpathSync(__filename), ctx.root));
  const result = cp.spawnSync('/bin/launchctl', ['bootstrap', 'gui/' + process.getuid(), file], {encoding: 'utf8'});
  if (result.status !== 0) throw Error('LaunchAgent failed to start; base overlay is installed. Run watch manually or inspect launchctl');
  return {installed: true, running: serviceRunning(), intervalSeconds: DEFAULTS.interval / 1000, dailyProbeLimit: DEFAULTS.dailyProbes,
    leaseMinutes: DEFAULTS.lease / MINUTE, report: path.join(ctx.stateDir, 'monitor-report.json')};
}
async function waitStopped(ctx) {
  const file = path.join(ctx.stateDir, 'monitor.lock');
  for (let i = 0; i < 50 && fs.existsSync(file); i++) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid monitor lock');
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (fs.existsSync(file)) throw Error('Monitor still running; stop its foreground process before changing the service');
}
async function uninstall(ctx) {
  if (serviceRunning()) {
    const result = cp.spawnSync('/bin/launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], {encoding: 'utf8'});
    if (result.status !== 0) throw Error('Cannot stop monitor; learning rules have not been reset');
  }
  await waitStopped(ctx);
  await clearLearned(ctx, router.controller(ctx));
  router.writePrivate(stateFile(ctx), JSON.stringify(emptyState()));
  const file = plistPath();
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('routing-monitor.cjs')) fs.rmSync(file);
  return {uninstalled: true, learnedRules: 0, baseRoutingPreserved: true};
}
async function watch(root) {
  const initial = router.load(root), release = lock(initial); let stopping = false, wake;
  const stop = () => { stopping = true; if (wake) wake(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    // Remove leases from a previous process before accepting new observations.
    const prior = readState(initial); prior.entries = {}; router.writePrivate(stateFile(initial), JSON.stringify(prior));
    await clearLearned(initial, router.controller(initial));
    while (!stopping) {
      try { await cycle(router.load(root)); }
      catch {
        let cleared = false;
        try { const ctx = router.load(root); await clearLearned(ctx, router.controller(ctx)); cleared = true; } catch { /* Controller may be offline. */ }
        record(initial, {at: new Date().toISOString(), status: 'error', reason: 'cycle-failed-no-subscription-change', learnedRulesCleared: cleared});
      }
      if (!stopping) await new Promise(resolve => { const t = setTimeout(resolve, DEFAULTS.interval); wake = () => { clearTimeout(t); resolve(); }; });
      wake = null;
    }
  } finally {
    try { const ctx = router.load(root); await clearLearned(ctx, router.controller(ctx)); } catch { /* Report limitation in status; no broad config rewrites. */ }
    release(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
async function main(argv) {
  const command = argv.shift() || 'status'; let root;
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--config-dir') throw Error('Usage: routing-monitor.cjs install|status|once|watch|uninstall [--config-dir path]');
    root = argv[1];
  } else { const roots = router.discover(); if (roots.length !== 1) throw Error('Choose one client with --config-dir'); root = roots[0]; }
  const ctx = router.load(root);
  if (command === 'status') {
    const file = path.join(ctx.stateDir, 'monitor-report.json'), report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return {backgroundServiceLoaded: serviceRunning(), report, reportAgeSeconds: report ? Math.round((Date.now() - Date.parse(report.at)) / 1000) : null};
  }
  if (command === 'install') return install(ctx);
  if (command === 'uninstall') return uninstall(ctx);
  const settings = path.join(ctx.stateDir, 'settings.json');
  if (!fs.existsSync(settings) || !JSON.parse(fs.readFileSync(settings, 'utf8')).monitorEnabled)
    throw Error('Install the monitor first so its separate learning provider exists');
  if (command === 'watch') return watch(root);
  if (command === 'once') { const release = lock(ctx); try { return await cycle(ctx); } finally { release(); } }
  throw Error('Commands: install, status, once, watch, uninstall');
}
if (require.main === module) main(process.argv.slice(2)).then(r => { if (r) console.log(JSON.stringify(r, null, 2)); }).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = {DEFAULTS, publicIP, hostname, protectedTarget, matches, rejectRisk, resultFor, payloadFor, directProbe, resolveIP,
  emptyState, publish, cycle, lock, launchPlist, main};
