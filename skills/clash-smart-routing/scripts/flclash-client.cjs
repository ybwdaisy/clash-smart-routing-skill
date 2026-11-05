'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto'), net = require('node:net');
const vm = require('node:vm'), YAML = require('yaml');
const readiness = require('./client-readiness.cjs');
const DOMAIN = 'com.follow.clash', APP = '/Applications/FlClash.app';
const MARKER = '// clash-smart-routing managed v1';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const pause = ms => new Promise(yes => setTimeout(yes, ms));
function sqlString(value) { return value === null || value === undefined ? 'NULL' : "'" + String(value).replace(/'/g, "''") + "'"; }
function id(value) { const s = String(value); if (!/^\d{1,19}$/.test(s)) throw Error('Invalid FlClash record ID'); return s; }
function sqlite(root, sql, write = false) {
  const args = [...(write ? [] : ['-readonly']), '-json', '-cmd', '.timeout 3000', path.join(root, 'database.sqlite')];
  const r = cp.spawnSync(process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3', args,
    {input: '.bail on\n' + sql, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024});
  if (r.status !== 0) throw Error('FlClash database operation failed; original subscription is retained');
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}
function losslessParse(text) { return YAML.parse(text, {intAsBigInt: true}); }
function losslessJSON(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return '[' + v.map(losslessJSON).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ':' + losslessJSON(x)).join(',') + '}';
  return JSON.stringify(v);
}
function preferences(root, supplied) {
  if (supplied) return supplied;
  if (process.platform !== 'darwin') throw Error('FlClash native preference integration currently supports macOS only');
  if (path.basename(root) !== DOMAIN) throw Error('FlClash preference domain does not match this directory');
  const r = cp.spawnSync('/usr/bin/defaults', ['read', DOMAIN, 'flutter.config'], {encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024});
  if (r.status !== 0) throw Error('FlClash native preferences are unavailable');
  const result = losslessParse(r.stdout);
  if (!result || typeof result !== 'object' || !result.patchClashConfig || !result.appSettingProps || !result.networkProps)
    throw Error('Unsupported FlClash preference schema');
  return result;
}
function writePreferences(value) {
  const r = cp.spawnSync('/usr/bin/defaults', ['write', DOMAIN, 'flutter.config', '-string', losslessJSON(value)],
    {encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024});
  if (r.status !== 0) throw Error('Unable to save FlClash native preferences');
}
function isClient(root) { return fs.existsSync(path.join(root, 'database.sqlite')) && fs.existsSync(path.join(root, 'config.yaml')) && path.basename(root) === DOMAIN; }
function load(root, options = {}) {
  root = fs.realpathSync(root);
  const prefs = preferences(root, options.preferences), profileId = id(prefs.currentProfileId);
  const columns = sqlite(root, 'PRAGMA table_info(profiles);').map(x => x.name);
  if (!['id', 'type', 'extend_type', 'script_id', 'selected_map', 'overrides'].every(k => columns.includes(k)))
    throw Error('Unsupported FlClash profile schema');
  const rows = sqlite(root, 'SELECT CAST(id AS TEXT) AS id,type,label,extend_type,CAST(script_id AS TEXT) AS script_id,match_target,selected_map,overrides FROM profiles WHERE id=' + profileId + ';');
  if (rows.length !== 1 || !['url', 'file'].includes(rows[0].type)) throw Error('Select an existing file/subscription profile in FlClash first');
  const profile = rows[0];
  if (!['standard', 'script'].includes(profile.extend_type)) throw Error('Unsupported FlClash extension type');
  const subscriptionFile = path.join(root, 'profiles', profileId + '.yaml'), runtimeFile = path.join(root, 'config.yaml');
  const stateDir = path.join(root, 'smart-routing-state');
  const nativeScriptFile = profile.script_id ? path.join(root, 'scripts', id(profile.script_id) + '.js') : null;
  return {client: 'flclash', root, stateDir, runtimeFile, subscriptionFile,
    config: YAML.parse(fs.readFileSync(runtimeFile, 'utf8')), subscription: YAML.parse(fs.readFileSync(subscriptionFile, 'utf8')),
    scriptFile: nativeScriptFile, native: {preferences: prefs, profile, profileId},
    flclashStateFile: path.join(stateDir, 'flclash-' + profileId + '.json')};
}
function confinedPath(ctx, name, provider) {
  const key = provider.url ? name + '@' + provider.url : 'rule-providers/' + name;
  return path.join(ctx.root, 'profiles/providers', ctx.native.profileId, 'rules', crypto.createHash('md5').update(key).digest('hex'));
}
function running() {
  const r = cp.spawnSync('/bin/ps', ['-axo', 'comm='], {encoding: 'utf8', timeout: 3000});
  if (r.status !== 0) throw Error('Unable to check FlClash process state');
  return r.stdout.split('\n').some(x => x.trim() === APP + '/Contents/MacOS/FlClash');
}
async function quit() {
  if (!running()) return;
  // AppleEvent can report a disconnected target while native shutdown is still
  // finishing. Wait for the process to exit before deciding whether quit failed.
  cp.spawnSync('/usr/bin/osascript', ['-e', 'tell application id "com.follow.clash" to quit'], {encoding: 'utf8', timeout: 10000});
  for (let i = 0; i < 100 && running(); i++) await pause(100);
  if (running()) throw Error('FlClash is still running; database was not changed');
}
function open() {
  const r = cp.spawnSync('/usr/bin/open', ['-a', APP], {encoding: 'utf8', timeout: 5000});
  if (r.status !== 0) throw Error('FlClash could not be reopened');
}
// Use the installed client's own length-prefixed IPC protocol in an isolated process.
async function validate(ctx, candidateFile, binary = APP + '/Contents/MacOS/FlClashCore') {
  if (!fs.existsSync(binary)) throw Error('FlClashCore binary is missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-net-fl-validate-')); fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, 'ipc.sock'); let socket, child, timer;
  const server = net.createServer();
  try {
    const connected = new Promise((yes, no) => { server.once('connection', s => { socket = s; yes(s); }); server.once('error', no); });
    await new Promise((yes, no) => { server.listen(socketPath, yes); server.once('error', no); });
    child = cp.spawn(binary, [socketPath], {stdio: ['ignore', 'ignore', 'ignore']});
    const timeout = new Promise((_, no) => { timer = setTimeout(() => no(Error('FlClashCore validation timed out')), 10000); });
    child.on('error', () => {});
    await Promise.race([connected, timeout]);
    const response = new Promise((yes, no) => {
      let buffer = Buffer.alloc(0);
      socket.on('error', no);
      socket.on('data', b => {
        buffer = Buffer.concat([buffer, b]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE();
          if (size > 8 * 1024 * 1024) return no(Error('Unexpected FlClashCore frame size'));
          if (buffer.length < size + 4) return;
          let v; try { v = JSON.parse(buffer.subarray(4, size + 4).toString()); } catch { return no(Error('Invalid FlClashCore response')); }
          buffer = buffer.subarray(size + 4);
          if (v.id === 'clash-net-validate') { if (v.error) no(Error('FlClashCore rejected the candidate configuration')); else yes(v.result); }
        }
      });
    });
    const data = Buffer.from(JSON.stringify({id: 'clash-net-validate', method: 'validateConfig', arguments: candidateFile}));
    const size = Buffer.alloc(4); size.writeUInt32LE(data.length); socket.write(Buffer.concat([size, data]));
    const result = await Promise.race([response, timeout]);
    if (result !== '') throw Error('FlClashCore rejected the candidate configuration');
    return {validator: 'installed-FlClashCore', parsed: true};
  } finally {
    clearTimeout(timer); socket?.destroy(); if (child && child.exitCode === null) child.kill();
    await new Promise(yes => server.close(() => yes())); fs.rmSync(dir, {recursive: true, force: true});
  }
}
function state(ctx) { return fs.existsSync(ctx.flclashStateFile) ? JSON.parse(fs.readFileSync(ctx.flclashStateFile, 'utf8')) : null; }
function plan(ctx, args = {}) {
  const router = require('./clash-router.cjs');
  // Native standard-mode additions are not executed in script mode. Refuse
  // instead of silently dropping those user rules or a substituted MATCH.
  if (ctx.native.profile.extend_type === 'standard') {
    if (ctx.native.profile.match_target?.trim()) throw Error('FlClash standard MATCH override requires explicit migration before script integration');
    const hasRules = sqlite(ctx.root, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='rules';")[0].n;
    if (hasRules && sqlite(ctx.root, 'SELECT COUNT(*) AS n FROM rules WHERE profile_id=' + id(ctx.native.profileId) + ';')[0].n)
      throw Error('FlClash standard added rules require explicit migration before script integration');
  }
  const settingsPath = path.join(ctx.stateDir, 'settings.json');
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  if (args['settings-file']) Object.assign(settings, JSON.parse(fs.readFileSync(args['settings-file'], 'utf8')));
  delete settings.preferredNode;
  if (ctx.native.profile.match_target) settings.upstreamGroup = ctx.native.profile.match_target;
  const installed = state(ctx);
  let previous = '';
  if (installed) {
    if (ctx.native.profile.script_id !== installed.scriptId || ctx.native.profile.extend_type !== 'script') throw Error('FlClash script binding changed; review before applying');
    if (hash(fs.readFileSync(ctx.scriptFile)) !== installed.scriptHash) throw Error('FlClash script changed; review before applying');
    previous = fs.readFileSync(installed.originalScript, 'utf8');
  } else if (ctx.native.profile.extend_type === 'script' && ctx.scriptFile) {
    previous = fs.readFileSync(ctx.scriptFile, 'utf8');
    if (previous.startsWith(MARKER)) throw Error('Managed FlClash script has no matching backup');
  }
  const script = router.render(previous, settings);
  const candidate = vm.runInNewContext(script + '\nmain(__config, "clash-net")', {__config: JSON.parse(JSON.stringify(ctx.subscription))}, {timeout: 1000});
  router.preserved(ctx.subscription.rules || [], candidate.rules);
  const base = Object.fromEntries(Object.entries(ctx.config).filter(([k]) => !['proxies', 'proxy-groups', 'rules', 'rule-providers', 'proxy-providers'].includes(k)));
  const runtimeCandidate = {...base, ...JSON.parse(JSON.stringify(candidate)), mode: 'rule'};
  for (const [name, provider] of Object.entries(runtimeCandidate['rule-providers'] || {}))
    if (router.engine.managedRule('RULE-SET,' + name + ',DIRECT') && provider.type !== 'inline') provider.path = confinedPath(ctx, name, provider);
  return {settings, script, previous, candidate: runtimeCandidate, installed};
}
function nativePrefsFor(ctx, args, secret) {
  const next = losslessParse(losslessJSON(ctx.native.preferences));
  if (!(Number(next.appSettingProps.acceptedDisclaimerVersion) > 0)) throw Error('Complete the FlClash first-launch consent in its UI before configuring it');
  next.patchClashConfig['external-controller'] = '127.0.0.1:9090';
  next.patchClashConfig.secret = secret;
  next.patchClashConfig.mode = 'rule';
  if (args.activate) { next.networkProps.systemProxy = true; next.appSettingProps.autoRun = true; }
  return next;
}
function hierarchy(ctx, args) {
  const selected = JSON.parse(ctx.native.profile.selected_map || '{}');
  if (!args['adopt-hierarchy']) return {selected, before: {}, installed: {}};
  const router = require('./clash-router.cjs'), main = router.engine.upstreamTarget(ctx.config, {});
  const group = (ctx.config['proxy-groups'] || []).find(g => g.name === main && g.type === 'select');
  const autos = (group?.proxies || []).filter(n => (ctx.config['proxy-groups'] || []).some(g => g.name === n && g.type === 'url-test'));
  if (!group || autos.length !== 1) throw Error('Cannot safely identify one automatic group for the existing main selector');
  const autoName = autos[0], auto = ctx.config['proxy-groups'].find(g => g.name === autoName);
  const current = selected[main];
  if (!current) throw Error('No persisted main selection; choose one in FlClash before adopting the hierarchy');
  if (current !== autoName && !(auto.proxies || []).includes(current)) throw Error('Current main selection is not a leaf in the automatic group; no choice is guessed');
  const before = {[main]: selected[main] ?? null, [autoName]: selected[autoName] ?? null};
  if (current !== autoName) selected[autoName] = current;
  selected[main] = autoName;
  return {selected, before, installed: {[main]: selected[main], [autoName]: selected[autoName] ?? null}};
}
function backupDatabase(ctx, file) {
  const r = cp.spawnSync('/usr/bin/sqlite3', ['-readonly', path.join(ctx.root, 'database.sqlite')],
    {input: '.bail on\n.timeout 3000\n.backup ' + JSON.stringify(file) + '\n', encoding: 'utf8', timeout: 10000});
  if (r.status !== 0) throw Error('FlClash database backup failed'); fs.chmodSync(file, 0o600);
}
function restoreDatabase(ctx, file, isRunning = running) {
  if (isRunning()) throw Error('FlClash must be closed before restoring its database');
  const r = cp.spawnSync('/usr/bin/sqlite3', [path.join(ctx.root, 'database.sqlite')],
    {input: '.bail on\n.timeout 3000\n.restore ' + JSON.stringify(file) + '\n', encoding: 'utf8', timeout: 10000});
  if (r.status !== 0) throw Error('Database restore failed; retain the private backup for recovery');
}
function register(ctx, scriptId, selected, expected = ctx.native.profile) {
  const scriptPath = path.join(ctx.root, 'scripts', id(scriptId) + '.js');
  if (!fs.existsSync(scriptPath)) throw Error('Script file is not ready for registration');
  const now = Math.floor(Date.now() / 1000);
  const updatingManaged = expected.extend_type === 'script' && expected.script_id === String(scriptId);
  sqlite(ctx.root, 'BEGIN IMMEDIATE;\nCREATE TEMP TABLE clash_net_guard(ok INTEGER CHECK(ok=1));\n' +
    'INSERT INTO scripts(id,label,last_update_time,url,"order") VALUES(' + id(scriptId) + ',' + sqlString('clash-net · Smart Routing') + ',' + now + ',NULL,NULL) ' +
    (updatingManaged ? 'ON CONFLICT(id) DO UPDATE SET label=excluded.label,last_update_time=excluded.last_update_time' : '') + ';\n' +
    'UPDATE profiles SET extend_type=\'script\',script_id=' + id(scriptId) + ',selected_map=' + sqlString(JSON.stringify(selected)) +
    ' WHERE id=' + id(ctx.native.profileId) + ' AND extend_type=' + sqlString(expected.extend_type) +
    ' AND script_id IS ' + (expected.script_id ? id(expected.script_id) : 'NULL') + ' AND selected_map=' + sqlString(expected.selected_map) + ';\n' +
    'INSERT INTO clash_net_guard VALUES(changes());\nCOMMIT;\n', true);
}
function systemProxy() {
  const r = cp.spawnSync('/usr/sbin/scutil', ['--proxy'], {encoding: 'utf8', timeout: 3000});
  if (r.status !== 0 || !/HTTPEnable\s*:\s*1\b/.test(r.stdout)) return null;
  const host = r.stdout.match(/HTTPProxy\s*:\s*(\S+)/)?.[1], port = Number(r.stdout.match(/HTTPPort\s*:\s*(\d+)/)?.[1]);
  return ['127.0.0.1', 'localhost'].includes(host) && port > 0 && port <= 65535 ? 'http://127.0.0.1:' + port : null;
}
async function checkControllerPort(ctx) {
  const prefs = ctx.native.preferences.patchClashConfig;
  if (ctx.config['external-controller'] === '127.0.0.1:9090' && ctx.config.secret && prefs['external-controller'] === '127.0.0.1:9090') {
    const router = require('./clash-router.cjs'); await router.controller(ctx)('GET', '/version'); return;
  }
  const server = net.createServer();
  try { await new Promise((yes, no) => { server.once('error', no); server.listen(9090, '127.0.0.1', yes); }); }
  catch { throw Error('FlClash controller port 9090 is already occupied; no other service will be replaced'); }
  finally { if (server.listening) await new Promise(yes => server.close(yes)); }
}
async function waitVerified(root, settings) {
  const router = require('./clash-router.cjs'); let lastError = 'waiting for FlClash to load its override';
  for (let i = 0; i < 90; i++) {
    try {
      const ctx = load(root);
      if (!ctx.config['rule-providers']?.[router.engine.prefix + 'ai']) throw Error('Override is not loaded yet');
      const verification = await router.verify(ctx, router.controller(ctx), settings);
      return {ctx, verification};
    } catch (e) { lastError = e.message; await pause(500); }
  }
  throw Error('FlClash verification failed: ' + lastError);
}
async function apply(ctx, args = {}) {
  if (process.platform !== 'darwin') throw Error('FlClash installation currently supports macOS only');
  const router = require('./clash-router.cjs'), p = plan(ctx, args);
  const wasRunning = running();
  if (!wasRunning && !args.activate) throw Error('Start FlClash first, or explicitly use --activate');
  await checkControllerPort(ctx);
  const selected = hierarchy(ctx, args), sourceHash = hash(fs.readFileSync(ctx.subscriptionFile));
  const cacheConfigs = [];
  for (const root of router.discover().filter(r => r !== ctx.root)) {
    try { const source = router.load(root); cacheConfigs.push({root: source.root, config: source.config}); } catch { /* Unavailable client is not a cache source. */ }
  }
  const downloadedBytes = router.downloadRules(ctx, p.candidate, {proxy: systemProxy(), cacheConfigs});
  const learned = p.candidate['rule-providers']?.[router.engine.prefix + 'learned'];
  if (learned && !fs.existsSync(learned.path)) router.writePrivate(learned.path, 'payload: []\n');
  const candidateFile = path.join(ctx.stateDir, 'flclash-candidate.yaml');
  router.writePrivate(candidateFile, YAML.stringify(p.candidate));
  const validation = await validate(ctx, candidateFile);
  const backup = path.join(ctx.stateDir, 'flclash-backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, {recursive: true, mode: 0o700});
  const settingsFile = path.join(ctx.stateDir, 'settings.json');
  const scriptId = p.installed?.scriptId || String(Date.now());
  if (!p.installed && sqlite(ctx.root, 'SELECT id FROM scripts WHERE id=' + id(scriptId) + ';').length) throw Error('Generated script ID collision; retry the plan');
  const scriptFile = path.join(ctx.root, 'scripts', scriptId + '.js');
  const beforeState = p.installed;
  let mutated = false, oldPrefs, hadScript = fs.existsSync(scriptFile);
  try {
    await quit();
    oldPrefs = preferences(ctx.root);
    if (id(oldPrefs.currentProfileId) !== ctx.native.profileId) throw Error('Active profile changed during planning; stopped');
    const fresh = load(ctx.root);
    if (losslessJSON(fresh.native.profile) !== losslessJSON(ctx.native.profile)) throw Error('Profile changed during planning; stopped');
    backupDatabase(ctx, path.join(backup, 'database.sqlite'));
    router.writePrivate(path.join(backup, 'preferences.json'), losslessJSON(oldPrefs));
    router.writePrivate(path.join(backup, 'runtime.yaml'), fs.readFileSync(ctx.runtimeFile));
    router.writePrivate(path.join(backup, 'original-script.js'), p.previous);
    if (hadScript) router.writePrivate(path.join(backup, 'managed-script.js'), fs.readFileSync(scriptFile));
    if (fs.existsSync(settingsFile)) router.writePrivate(path.join(backup, 'settings.json'), fs.readFileSync(settingsFile));
    if (beforeState) router.writePrivate(path.join(backup, 'previous-state.json'), JSON.stringify(beforeState));
    const secret = String(oldPrefs.patchClashConfig.secret || crypto.randomBytes(24).toString('hex'));
    const newPrefs = nativePrefsFor({...ctx, native: {...ctx.native, preferences: oldPrefs}}, args, secret);
    mutated = true;
    router.writePrivate(scriptFile, p.script);
    register(ctx, scriptId, selected.selected);
    writePreferences(newPrefs);
    router.writePrivate(settingsFile, JSON.stringify(p.settings, null, 2));
    const installed = {version: 1, client: 'flclash', profileId: ctx.native.profileId, scriptId, scriptHash: hash(p.script),
      originalScript: beforeState?.originalScript || path.join(backup, 'original-script.js'),
      originalProfile: beforeState?.originalProfile || ctx.native.profile, backup, previousState: beforeState || null,
      nativePreferenceKeys: {
        before: beforeState?.nativePreferenceKeys?.before || {controller: oldPrefs.patchClashConfig['external-controller'], secret: oldPrefs.patchClashConfig.secret,
          mode: oldPrefs.patchClashConfig.mode, systemProxy: oldPrefs.networkProps.systemProxy, autoRun: oldPrefs.appSettingProps.autoRun},
        installed: {controller: newPrefs.patchClashConfig['external-controller'], secretHash: hash(secret),
          mode: newPrefs.patchClashConfig.mode, systemProxy: newPrefs.networkProps.systemProxy, autoRun: newPrefs.appSettingProps.autoRun}},
      hierarchy: Object.keys(beforeState?.hierarchy?.installed || {}).length ? beforeState.hierarchy : selected};
    delete installed.hierarchy.selected;
    router.writePrivate(ctx.flclashStateFile, JSON.stringify(installed, null, 2));
    open();
    const result = await waitVerified(ctx.root, p.settings);
    const proxyReadiness = args.activate ? await readiness.waitReady(Number(result.ctx.config['mixed-port'])) : null;
    if (hash(fs.readFileSync(ctx.subscriptionFile)) !== sourceHash) throw Error('Original subscription changed during installation');
    router.preserved(ctx.subscription.rules || [], result.ctx.config.rules || []);
    return {applied: true, client: 'flclash', profileId: ctx.native.profileId, backup, downloadedBytes, validation,
      subscriptionUnchanged: true, originalRulesPreserved: ctx.subscription.rules.length, activated: Boolean(args.activate),
      ...(proxyReadiness ? {systemProxyReady: true,systemProxyWaitMs: proxyReadiness.elapsedMs} : {}), ...result.verification};
  } catch (e) {
    if (mutated) {
      await quit(); restoreDatabase(ctx, path.join(backup, 'database.sqlite')); writePreferences(oldPrefs);
      router.writePrivate(ctx.runtimeFile, fs.readFileSync(path.join(backup, 'runtime.yaml')));
      if (hadScript) router.writePrivate(scriptFile, fs.readFileSync(path.join(backup, 'managed-script.js')));
      else fs.rmSync(scriptFile, {force: true});
      if (beforeState) router.writePrivate(ctx.flclashStateFile, JSON.stringify(beforeState));
      else fs.rmSync(ctx.flclashStateFile, {force: true});
      if (fs.existsSync(path.join(backup, 'settings.json'))) router.writePrivate(settingsFile, fs.readFileSync(path.join(backup, 'settings.json')));
      else fs.rmSync(settingsFile, {force: true});
    }
    if (wasRunning) open();
    throw Error(e.message + (mutated ? '; this installation was rolled back' : '; no profile binding was changed'));
  } finally { fs.rmSync(candidateFile, {force: true}); }
}
async function rollback(ctx) {
  const router = require('./clash-router.cjs'), installed = state(ctx);
  if (!installed || installed.profileId !== ctx.native.profileId) throw Error('No managed FlClash installation for the selected profile');
  if (ctx.native.profile.script_id !== installed.scriptId || hash(fs.readFileSync(ctx.scriptFile)) !== installed.scriptHash)
    throw Error('FlClash script or binding changed; no stale rollback');
  const wasRunning = running();
  await quit();
  const current = load(ctx.root), selected = JSON.parse(current.native.profile.selected_map || '{}');
  for (const [name, value] of Object.entries(installed.hierarchy?.installed || {})) {
    if ((selected[name] ?? null) !== value) continue;
    const before = installed.hierarchy.before[name];
    if (before === null) delete selected[name]; else selected[name] = before;
  }
  const original = installed.originalProfile;
  sqlite(ctx.root, 'BEGIN IMMEDIATE; UPDATE profiles SET extend_type=' + sqlString(original.extend_type) + ',script_id=' +
    (original.script_id ? id(original.script_id) : 'NULL') + ',selected_map=' + sqlString(JSON.stringify(selected)) +
    ' WHERE id=' + id(ctx.native.profileId) + ' AND script_id=' + id(installed.scriptId) + '; COMMIT;', true);
  const remaining = sqlite(ctx.root, 'SELECT COUNT(*) AS n FROM profiles WHERE script_id=' + id(installed.scriptId) + ';')[0].n;
  if (!remaining) { sqlite(ctx.root, 'DELETE FROM scripts WHERE id=' + id(installed.scriptId) + ';', true); fs.rmSync(ctx.scriptFile, {force: true}); }
  const other = fs.readdirSync(ctx.stateDir).some(n => /^flclash-\d+\.json$/.test(n) && path.join(ctx.stateDir, n) !== ctx.flclashStateFile);
  const prefs = current.native.preferences, own = installed.nativePreferenceKeys;
  if (!other && own) {
    const p = prefs.patchClashConfig;
    if (p['external-controller'] === own.installed.controller && hash(String(p.secret)) === own.installed.secretHash) {
      p['external-controller'] = own.before.controller; p.secret = own.before.secret;
    }
    if (p.mode === own.installed.mode) p.mode = own.before.mode;
    if (prefs.networkProps.systemProxy === own.installed.systemProxy) prefs.networkProps.systemProxy = own.before.systemProxy;
    if (prefs.appSettingProps.autoRun === own.installed.autoRun) prefs.appSettingProps.autoRun = own.before.autoRun;
    writePreferences(prefs);
  }
  fs.rmSync(ctx.flclashStateFile);
  if (wasRunning) open();
  return {restored: true, client: 'flclash', profileId: ctx.native.profileId, subscriptionUnchanged: true};
}
async function main(command, ctx, args = {}) {
  if (command === 'apply') return apply(ctx, args);
  if (command === 'rollback') return rollback(ctx);
  const p = plan(ctx, args);
  return {client: 'flclash', configDirectory: ctx.root, profileId: ctx.native.profileId,
    mainSelector: require('./clash-router.cjs').engine.upstreamTarget(p.candidate, p.settings),
    subscriptionRulesPreserved: ctx.subscription.rules.length,
    managedRules: p.candidate.rules.filter(require('./clash-router.cjs').engine.managedRule).length,
    nativeScriptIntegration: true, localControllerRequired: true, activate: Boolean(args.activate), adoptHierarchy: Boolean(args['adopt-hierarchy'])};
}
module.exports = {DOMAIN, APP, isClient, load, preferences, writePreferences, losslessParse, losslessJSON,
  sqlite, sqlString, id, confinedPath, running, quit, open, validate, plan, state, main, apply, rollback,
  nativePrefsFor, hierarchy, register, backupDatabase, restoreDatabase};
