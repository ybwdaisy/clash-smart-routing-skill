#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const cp = require('node:child_process');
const vm = require('node:vm');
const YAML = require('yaml');
const asset = fs.readFileSync(path.join(__dirname, '../assets/router.js'), 'utf8');
const engine = vm.runInNewContext(asset + '\nSmartRouting;', Object.create(null), {timeout: 1000});
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => YAML.parse(fs.readFileSync(p, 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v));
const MARKER = '// clash-smart-routing managed v1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(temp, data, {mode: 0o600});
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}
function discover() {
  const h = os.homedir();
  const bases = [path.join(h, 'Library/Application Support'), process.env.APPDATA,
    process.env.LOCALAPPDATA, process.env.XDG_DATA_HOME || path.join(h, '.local/share'),
    process.env.XDG_CONFIG_HOME || path.join(h, '.config')].filter(Boolean);
  const found = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const item of fs.readdirSync(base, {withFileTypes: true})) {
      if (!item.isDirectory() || !/clash|verge/i.test(item.name)) continue;
      const root = path.join(base, item.name);
      if (fs.existsSync(path.join(root, 'profiles/Script.js')) && fs.existsSync(path.join(root, 'clash-verge.yaml'))) found.push(root);
    }
  }
  return [...new Set(found)];
}
function load(root) {
  root = fs.realpathSync(root);
  const scriptFile = path.join(root, 'profiles/Script.js');
  const runtimeFile = path.join(root, 'clash-verge.yaml');
  const registry = read(path.join(root, 'profiles.yaml'));
  if (!(registry.items || []).some(p => p.uid === 'Script' && p.type === 'script' && p.file === 'Script.js'))
    throw Error('Unsupported global-script registry; inspect the client instead of guessing a file');
  const selected = registry.items.find(p => p.uid === registry.current);
  if (!selected || !selected.file) throw Error('No active subscription');
  const subscriptionFile = path.resolve(root, 'profiles', selected.file);
  if (!subscriptionFile.startsWith(path.join(root, 'profiles') + path.sep)) throw Error('Unsafe profile path');
  return {root, scriptFile, runtimeFile, subscriptionFile, config: read(runtimeFile), subscription: read(subscriptionFile),
    stateDir: path.join(root, 'smart-routing-state')};
}
function controller(ctx) {
  const base = fs.existsSync(path.join(ctx.root, 'config.yaml')) ? read(path.join(ctx.root, 'config.yaml')) : {};
  const socket = ctx.config['external-controller-unix'] ?? base['external-controller-unix'];
  const useSocket = socket && path.isAbsolute(socket) && fs.existsSync(socket) && fs.statSync(socket).isSocket();
  const address = ctx.config['external-controller'] ?? base['external-controller'];
  if (!useSocket && (!address || !/^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\[::\]):\d+$/.test(address)))
    throw Error('A local HTTP controller or Unix socket is required; remote controllers are not auto-accessed');
  const normalized = useSocket ? null : address.replace(/^0\.0\.0\.0:/, '127.0.0.1:').replace(/^\[::\]:/, '[::1]:');
  const secret = ctx.config.secret ?? base.secret ?? '';
  return (method, route, data) => new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const target = useSocket ? {socketPath: socket, path: route} : {hostname: new URL('http://' + normalized).hostname.replace(/^\[|\]$/g, ''), port: new URL('http://' + normalized).port, path: route};
    const req = http.request({...target,
      method, timeout: 15000, headers: {...(secret ? {Authorization: 'Bearer ' + secret} : {}),
        ...(body ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)} : {})}
    }, res => {
      let result = ''; res.on('data', b => {result += b;});
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(Error('Controller ' + method + ' ' + route + ': HTTP ' + res.statusCode));
        try {resolve(result ? JSON.parse(result) : null);} catch {reject(Error('Controller returned invalid JSON'));}
      });
    });
    req.on('timeout', () => req.destroy(Error('Controller timeout'))); req.on('error', reject);
    if (body) req.write(body); req.end();
  });
}
function coreBinary(explicit) {
  if (explicit) { if (!fs.existsSync(explicit)) throw Error('Core binary not found'); return explicit; }
  const candidates = ['/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo', '/Applications/Clash Verge Rev.app/Contents/MacOS/verge-mihomo',
    process.env.MIHOMO_BIN,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Clash Verge/verge-mihomo.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Clash Verge/verge-mihomo.exe')].filter(Boolean);
  if (process.platform !== 'win32') {
    const p = cp.spawnSync('ps', ['-ax', '-o', 'comm='], {encoding: 'utf8'});
    for (const line of (p.stdout || '').split('\n')) if (/\/(?:verge-)?mihomo(?:-alpha)?$/.test(line.trim())) candidates.push(line.trim());
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const p = cp.spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['mihomo'], {encoding: 'utf8'});
  if (p.status === 0) return p.stdout.trim().split(/\r?\n/)[0];
  throw Error('Cannot locate Mihomo; provide --core with the client binary path');
}
function preserved(before, after) {
  let cursor = 0;
  for (const r of before) { const i = after.indexOf(r, cursor); if (i < 0) throw Error('An existing rule was deleted or reordered'); cursor = i + 1; }
  const matches = before.filter(r => /^MATCH\s*,/i.test(r));
  if (matches.length && after.at(-1) !== before.at(-1)) throw Error('Existing fallback changed');
}
async function settingsFor(ctx, api, args) {
  const file = path.join(ctx.stateDir, 'settings.json');
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (args['settings-file']) Object.assign(settings, JSON.parse(fs.readFileSync(args['settings-file'], 'utf8')));
  try {
    const catalog = (await api('GET', '/proxies')).proxies;
    let name = String((ctx.subscription.rules || []).find(r => /^MATCH,/.test(r)) || '').split(',')[1];
    const seen = new Set();
    while (catalog[name] && catalog[name].now && !seen.has(name)) {seen.add(name); name = catalog[name].now;}
    if ((ctx.config.proxies || []).some(p => p.name === name && !/^(direct|reject|pass|compatible)$/i.test(p.type))) settings.preferredNode = name;
  } catch { /* Static nodes/provider fallback still has no DIRECT member. */ }
  return settings;
}
function render(existing, settings) {
  return MARKER + '\n' + asset + '\nvar __previousMain = (function () {\n' + existing +
    '\nreturn typeof main === "function" ? main : null;\n})();\nfunction main(config, profileName) {\n' +
    '  var previous = __previousMain ? __previousMain(config, profileName) : config;\n' +
    '  return SmartRouting.apply(previous, ' + JSON.stringify(settings) + ');\n}\n';
}
function downloadRules(ctx, candidate) {
  const port = ctx.config['mixed-port'] || ctx.config.port;
  const proxy = port ? 'http://127.0.0.1:' + port : undefined;
  let bytes = 0;
  for (const [name, provider] of Object.entries(candidate['rule-providers'])) {
    if (!name.startsWith(engine.prefix) || provider.type !== 'http') continue;
    const file = path.resolve(ctx.root, provider.path);
    if (!file.startsWith(ctx.root + path.sep)) throw Error('Unsafe provider path');
    if (fs.existsSync(file) && fs.statSync(file).size > 0 && Date.now() - fs.statSync(file).mtimeMs < 86400000) continue;
    const previous = Object.values(ctx.config['rule-providers'] || {}).find(p => p.url === provider.url && p.path);
    if (previous) {
      const cache = path.resolve(ctx.root, previous.path);
      if (cache.startsWith(ctx.root + path.sep) && fs.existsSync(cache) && fs.statSync(cache).size > 0) {
        writePrivate(file, fs.readFileSync(cache)); continue;
      }
    }
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const temp = file + '.download';
    const result = cp.spawnSync('curl', ['-fsSL', '--connect-timeout', '10', '--max-time', '90', '--retry', '2',
      ...(proxy ? ['--proxy', proxy] : []), '--output', temp, provider.url], {encoding: 'utf8', timeout: 200000});
    if (result.status !== 0 || !fs.existsSync(temp) || fs.statSync(temp).size === 0) {
      fs.rmSync(temp, {force: true}); throw Error('Rule download failed: ' + name + '; active configuration unchanged');
    }
    bytes += fs.statSync(temp).size; fs.renameSync(temp, file); fs.chmodSync(file, 0o600);
  }
  return bytes;
}
async function verify(ctx, api) {
  const [rules, proxy, providers, live] = await Promise.all([
    api('GET', '/rules'), api('GET', '/proxies/' + encodeURIComponent(engine.group)),
    api('GET', '/providers/rules'), api('GET', '/configs')]);
  if (live.mode !== 'rule') throw Error('Runtime is not in rule mode');
  if ((proxy.all || []).some(x => /^(DIRECT|COMPATIBLE)$/i.test(x)) || /^(DIRECT|COMPATIBLE)$/i.test(proxy.now || ''))
    throw Error('AI proxy group can fall through to DIRECT');
  const managed = (rules.rules || []).filter(r => r.type === 'RuleSet' && String(r.payload).startsWith(engine.prefix));
  const first = (rules.rules || [])[0];
  const expected = engine.apply({proxies:[{name:'validation-node',type:'ss'}],rules:[]},{}).rules;
  if (managed.length !== expected.length || !first || first.type !== 'RuleSet' || first.payload !== engine.prefix + 'ai-guard' || first.proxy !== engine.group)
    throw Error('Managed rules missing or shadowed');
  if (!expected.every((text,i) => {
    const parts=text.split(','), actual=rules.rules[i];
    return actual && actual.type==='RuleSet' && actual.payload===parts[1] && actual.proxy===parts[2] && !actual.extra?.disabled;
  })) throw Error('Domestic DIRECT priority must precede subscription rules; reapply the current skill');
  const counts = {};
  for (const key of Object.keys(engine.sources)) {
    const name = engine.prefix + key; const item = providers.providers[name];
    if (!item || !(item.ruleCount > 0)) throw Error('Rule provider not loaded: ' + name);
    counts[name] = item.ruleCount;
  }
  return {mode: live.mode, managedRules: managed.length, domesticDirectBeforeSubscription: true, aiGroupHasDirect: false, aiGroupHasSelectedProxy: Boolean(proxy.now && proxy.now !== 'REJECT'), ruleProviders: counts};
}
async function apply(ctx, api, args) {
  await api('GET', '/version'); // Prove the actual controller is reachable before any writes.
  const subscriptionHash = hash(fs.readFileSync(ctx.subscriptionFile));
  const settings = await settingsFor(ctx, api, args);
  const stateFile = path.join(ctx.stateDir, 'state.json');
  const oldState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const currentScript = fs.readFileSync(ctx.scriptFile, 'utf8');
  if (oldState && hash(currentScript) !== oldState.scriptHash) throw Error('Global script changed since installation; review it before updating');
  if (!oldState && currentScript.startsWith(MARKER)) throw Error('Managed script found without its backup; recover state before overwriting');
  const previous = oldState ? fs.readFileSync(oldState.originalScript, 'utf8') : currentScript;
  const candidate = engine.apply(clone(ctx.config), settings);
  preserved((ctx.config.rules || []).filter(r => !engine.managedRule(r)), candidate.rules);
  preserved(ctx.subscription.rules || [], candidate.rules);
  const downloadedBytes = downloadRules(ctx, candidate);
  const candidatePath = path.join(ctx.stateDir, 'candidate.json');
  writePrivate(candidatePath, JSON.stringify(candidate));
  const core = coreBinary(args.core);
  const checked = cp.spawnSync(core, ['-t', '-d', ctx.root, '-f', candidatePath], {encoding: 'utf8', timeout: 120000});
  writePrivate(path.join(ctx.stateDir, 'core-check.log'), (checked.stdout || '') + (checked.stderr || ''));
  if (checked.status !== 0) throw Error('Mihomo rejected candidate; see private smart-routing-state/core-check.log');
  const backup = path.join(ctx.stateDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  writePrivate(path.join(backup, 'Script.js'), currentScript);
  writePrivate(path.join(backup, 'runtime.yaml'), fs.readFileSync(ctx.runtimeFile));
  writePrivate(path.join(backup, 'runtime.json'), JSON.stringify(ctx.config));
  const originalScript = oldState ? oldState.originalScript : path.join(backup, 'Script.js');
  const generated = render(previous, settings);
  const state = {version: 1, originalScript, scriptHash: hash(generated), backup, subscriptionFile: ctx.subscriptionFile, subscriptionHash, previousState: oldState};
  try {
    writePrivate(ctx.scriptFile, generated);
    writePrivate(ctx.runtimeFile, YAML.stringify(candidate));
    await api('PUT', '/configs?force=true', {path: candidatePath});
    let report;
    for (let i = 0; i < 5; i++) {
      try {report = await verify(ctx, api); break;} catch (error) {if (i === 4) throw error; await sleep(400);}
    }
    if (hash(fs.readFileSync(ctx.subscriptionFile)) !== subscriptionHash) throw Error('Subscription file changed during installation');
    writePrivate(stateFile, JSON.stringify(state, null, 2));
    writePrivate(path.join(ctx.stateDir, 'settings.json'), JSON.stringify(settings, null, 2));
    writePrivate(path.join(ctx.stateDir, 'verification.json'), JSON.stringify(report, null, 2));
    return {...report, subscriptionUnchanged: true, existingRulesPreserved: true, downloadedBytes, backup};
  } catch (error) {
    writePrivate(ctx.scriptFile, currentScript);
    writePrivate(ctx.runtimeFile, fs.readFileSync(path.join(backup, 'runtime.yaml')));
    try {await api('PUT', '/configs?force=true', {path: path.join(backup, 'runtime.json')});}
    catch {throw Error(error.message + '; automatic rollback reload failed, reload the saved original runtime manually');}
    throw Error(error.message + '; original script and runtime restored');
  }
}
async function rollback(ctx, api) {
  const stateFile = path.join(ctx.stateDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (hash(fs.readFileSync(ctx.scriptFile)) !== state.scriptHash) throw Error('Global script has subsequent edits; refusing to overwrite');
  if (hash(fs.readFileSync(ctx.subscriptionFile)) !== state.subscriptionHash) throw Error('Subscription has updated; rebuild current subscription with the original script instead of restoring a stale runtime');
  writePrivate(ctx.scriptFile, fs.readFileSync(path.join(state.backup, 'Script.js')));
  writePrivate(ctx.runtimeFile, fs.readFileSync(path.join(state.backup, 'runtime.yaml')));
  await api('PUT', '/configs?force=true', {path: path.join(state.backup, 'runtime.json')});
  if (state.previousState) writePrivate(stateFile, JSON.stringify(state.previousState, null, 2));
  else fs.rmSync(stateFile);
  return {restored: true, backup: state.backup};
}
function argumentsOf(argv) {
  const command = argv.shift() || 'discover'; const args = {};
  while (argv.length) {
    const key = argv.shift();
    if (!/^--(config-dir|core|settings-file)$/.test(key) || !argv.length) throw Error('Unknown or missing argument: ' + key);
    args[key.slice(2)] = argv.shift();
  }
  return {command, args};
}
async function main(argv) {
  const {command, args} = argumentsOf(argv);
  const roots = args['config-dir'] ? [args['config-dir']] : discover();
  if (command === 'discover') return {configDirectories: roots};
  if (roots.length !== 1) throw Error('Expected one client configuration; use --config-dir. Found: ' + roots.join(', '));
  const ctx = load(roots[0]);
  const api = controller(ctx);
  if (command === 'verify') return verify(ctx, api);
  if (command === 'apply') return apply(ctx, api, args);
  if (command === 'rollback') return rollback(ctx, api);
  if (command !== 'plan') throw Error('Commands: discover, plan, apply, verify, rollback');
  const settings = await settingsFor(ctx, api, args);
  const candidate = engine.apply(clone(ctx.config), settings);
  preserved(ctx.subscription.rules || [], candidate.rules);
  return {configDirectory: ctx.root, subscriptionRulesPreserved: (ctx.subscription.rules || []).length,
    mode: candidate.mode, managedRules: candidate.rules.filter(engine.managedRule).length,
    automaticProxySelection: true, domesticDirectBeforeSubscription: true, aiHasDirectFallback: false, sources: engine.sources};
}
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {console.error(e.message); process.exitCode = 1;});
module.exports = {engine, discover, load, render, preserved, argumentsOf, main, controller, verify};
