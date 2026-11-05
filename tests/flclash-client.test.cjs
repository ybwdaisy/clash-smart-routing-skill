'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const YAML = require('../skills/clash-smart-routing/node_modules/yaml');
const fl = require('../skills/clash-smart-routing/scripts/flclash-client.cjs');
const router = require('../skills/clash-smart-routing/scripts/clash-router.cjs');
const sqliteExists = fs.existsSync('/usr/bin/sqlite3');
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flclash-client-test-')), root = path.join(base, 'com.follow.clash');
  fs.mkdirSync(path.join(root, 'profiles'), {recursive: true}); fs.mkdirSync(path.join(root, 'scripts'));
  const profileId = '376217317576544257';
  const profile = {proxies: [{name: '日本A', type: 'ss', server: '127.0.0.1', port: 1234, cipher: 'aes-128-gcm', password: 'fixture-only'}],
    'proxy-groups': [{name: 'Vendor main', type: 'select', proxies: ['Auto', '日本A']}, {name: 'Auto', type: 'url-test', proxies: ['日本A'], url: 'https://latency.example/204', interval: 300}],
    rules: ['DOMAIN-SUFFIX,foreign.example,Vendor main', 'GEOIP,CN,DIRECT', 'MATCH,Vendor main'], dns: {enable: false}};
  fs.writeFileSync(path.join(root, 'profiles', profileId + '.yaml'), YAML.stringify(profile));
  fs.writeFileSync(path.join(root, 'config.yaml'), YAML.stringify({...profile, 'mixed-port': 7890, mode: 'rule', 'external-controller': '', secret: ''}));
  const runSQL = sql => {
    const r = cp.spawnSync('/usr/bin/sqlite3', [path.join(root, 'database.sqlite')], {input: sql, encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
  };
  runSQL('CREATE TABLE profiles(id INTEGER PRIMARY KEY,type TEXT,label TEXT,extend_type TEXT,script_id INTEGER,match_target TEXT,selected_map TEXT,overrides TEXT,url TEXT);' +
    'CREATE TABLE scripts(id INTEGER PRIMARY KEY,label TEXT,last_update_time INTEGER,url TEXT,"order" INTEGER);' +
    'INSERT INTO profiles VALUES(' + profileId + ",'url','Private vendor','standard',NULL,NULL,'{\"Vendor main\":\"日本A\"}','{}','https://subscription.example/private-token');");
  const prefs = fl.losslessParse('{"currentProfileId":' + profileId + ',"patchClashConfig":{"external-controller":"","secret":"","mode":"rule","mixed-port":7890},"appSettingProps":{"acceptedDisclaimerVersion":1,"autoRun":false},"networkProps":{"systemProxy":false},"unrelated":{"id":376217317576544259}}');
  const ctx = fl.load(root, {preferences: prefs});
  return {base, root, profileId, profile, prefs, ctx, runSQL, cleanup: () => fs.rmSync(base, {recursive: true, force: true})};
}
test('native JSON round-trip preserves 64-bit profile identifiers and all unrelated preference values exactly', () => {
  const text = '{"currentProfileId":376217317576544257,"nested":{"another":9223372036854775806},"port":7890,"active":false}';
  assert.equal(fl.losslessJSON(fl.losslessParse(text)), text);
  assert.throws(() => fl.id('123;DELETE'), /Invalid/);
});
test('FlClash loading uses the active native profile without exposing or rewriting its subscription', {skip: !sqliteExists}, () => {
  const f = fixture();
  try {
    assert.equal(f.ctx.native.profileId, f.profileId); assert.equal(f.ctx.client, 'flclash');
    assert.equal(path.basename(f.ctx.subscriptionFile), f.profileId + '.yaml');
    assert.ok(!JSON.stringify(f.ctx.native.profile).includes('private-token'));
    assert.deepEqual(f.ctx.subscription.rules, f.profile.rules);
  } finally { f.cleanup(); }
});
test('native override composition preserves source rules, DNS, group definitions and provider cache confinement', {skip: !sqliteExists}, () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.ctx.subscriptionFile), p = fl.plan(f.ctx);
    assert.deepEqual(Buffer.from(fs.readFileSync(f.ctx.subscriptionFile)), before);
    assert.deepEqual(p.candidate.rules.filter(x => !router.engine.managedRule(x)), f.profile.rules);
    assert.deepEqual(p.candidate['proxy-groups'].slice(0, -1), f.profile['proxy-groups']);
    assert.deepEqual(p.candidate.dns, f.profile.dns);
    for (const [name, provider] of Object.entries(p.candidate['rule-providers'])) {
      if (provider.type === 'inline') continue;
      assert.equal(provider.path, fl.confinedPath(f.ctx, name, provider));
      assert.ok(provider.path.startsWith(path.join(f.ctx.root, 'profiles/providers', f.profileId, 'rules') + path.sep));
    }
  } finally { f.cleanup(); }
});
test('native preferences enable only the loopback controller and explicitly requested activation', {skip: !sqliteExists}, () => {
  const f = fixture();
  try {
    const p = fl.nativePrefsFor(f.ctx, {}, 'fixture-random-secret');
    assert.equal(p.patchClashConfig['external-controller'], '127.0.0.1:9090');
    assert.equal(p.patchClashConfig.secret, 'fixture-random-secret');
    assert.equal(p.currentProfileId, BigInt(f.profileId)); assert.equal(p.unrelated.id, 376217317576544259n);
    assert.equal(p.networkProps.systemProxy, false); assert.equal(p.appSettingProps.autoRun, false);
    const active = fl.nativePrefsFor(f.ctx, {activate: true}, 'fixture-random-secret');
    assert.equal(active.networkProps.systemProxy, true); assert.equal(active.appSettingProps.autoRun, true);
    assert.equal(f.prefs.networkProps.systemProxy, false);
    const notAccepted = {...f.ctx, native: {...f.ctx.native, preferences: {...f.prefs, appSettingProps: {acceptedDisclaimerVersion: 0}}}};
    assert.throws(() => fl.nativePrefsFor(notAccepted, {}, 'x'), /consent/);
  } finally { f.cleanup(); }
});
test('native standard additions and substituted MATCH are refused rather than dropped when selecting script mode', {skip: !sqliteExists}, () => {
  const f = fixture();
  try {
    f.ctx.native.profile.match_target = 'Existing other selector';
    assert.throws(() => fl.plan(f.ctx), /MATCH override requires explicit migration/);
    f.ctx.native.profile.match_target = null;
    f.runSQL('CREATE TABLE rules(id INTEGER PRIMARY KEY,profile_id INTEGER); INSERT INTO rules VALUES(1,' + f.profileId + ');');
    assert.throws(() => fl.plan(f.ctx), /added rules require explicit migration/);
    assert.equal(fl.sqlite(f.root, 'SELECT extend_type FROM profiles;')[0].extend_type, 'standard');
  } finally { f.cleanup(); }
});
test('explicit hierarchy adoption preserves the currently chosen exit inside the existing automatic group', {skip: !sqliteExists}, () => {
  const f = fixture();
  try {
    assert.deepEqual(fl.hierarchy(f.ctx, {}).selected, {'Vendor main': '日本A'});
    const p = fl.hierarchy(f.ctx, {'adopt-hierarchy': true});
    assert.deepEqual(p.selected, {'Vendor main': 'Auto', Auto: '日本A'});
    assert.deepEqual(p.before, {'Vendor main': '日本A', Auto: null});
    assert.equal(f.ctx.native.profile.selected_map, '{"Vendor main":"日本A"}');
  } finally { f.cleanup(); }
});
test('script registration is transactional, changes only owned fields, and refuses stale profiles or script ID collisions', {skip: !sqliteExists}, () => {
  const f = fixture();
  try {
    const original = fl.sqlite(f.root, 'SELECT CAST(id AS TEXT) AS id,url,label,overrides FROM profiles;')[0];
    fs.writeFileSync(path.join(f.root, 'scripts/123.js'), 'const main = c => c;');
    fl.register(f.ctx, '123', {'Vendor main': 'Auto', Auto: '日本A'});
    const row = fl.sqlite(f.root, 'SELECT CAST(id AS TEXT) AS id,url,label,overrides,extend_type,CAST(script_id AS TEXT) AS script_id FROM profiles;')[0];
    assert.deepEqual(Object.fromEntries(Object.keys(original).map(k => [k, row[k]])), original);
    assert.equal(row.extend_type, 'script'); assert.equal(row.script_id, '123');
    fs.writeFileSync(path.join(f.root, 'scripts/124.js'), 'const main = c => c;');
    assert.throws(() => fl.register(f.ctx, '124', {}, f.ctx.native.profile), /database operation failed/);
    assert.equal(fl.sqlite(f.root, 'SELECT COUNT(*) AS n FROM scripts WHERE id=124;')[0].n, 0);
    assert.equal(fl.sqlite(f.root, 'SELECT CAST(script_id AS TEXT) AS id FROM profiles;')[0].id, '123');
  } finally { f.cleanup(); }
});
test('SQLite backup and offline restore recover original binding and leave the subscription file intact', {skip: !sqliteExists}, () => {
  const f = fixture();
  try {
    const snapshot = path.join(f.base, 'before.sqlite'), source = fs.readFileSync(f.ctx.subscriptionFile);
    fl.backupDatabase(f.ctx, snapshot);
    fs.writeFileSync(path.join(f.root, 'scripts/123.js'), 'const main = c => c;');
    fl.register(f.ctx, '123', {'Vendor main': 'Auto'});
    fl.restoreDatabase(f.ctx, snapshot, () => false);
    assert.equal(fl.sqlite(f.root, 'SELECT extend_type FROM profiles;')[0].extend_type, 'standard');
    assert.equal(fl.sqlite(f.root, 'SELECT COUNT(*) AS n FROM scripts;')[0].n, 0);
    assert.deepEqual(fs.readFileSync(f.ctx.subscriptionFile), source);
    assert.throws(() => fl.restoreDatabase(f.ctx, snapshot, () => true), /must be closed/);
  } finally { f.cleanup(); }
});
test('native FlClashCore accepts a valid candidate and rejects malformed YAML in an isolated process',
  {skip: process.platform !== 'darwin' || !fs.existsSync('/Applications/FlClash.app/Contents/MacOS/FlClashCore')}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-native-test-'));
    try {
      const file = path.join(root, 'test.yaml');
      fs.writeFileSync(file, 'mode: rule\nproxies: []\nproxy-groups: []\nrules: [MATCH,DIRECT]\n');
      assert.equal((await fl.validate({}, file)).parsed, true);
      fs.writeFileSync(file, 'rules: [ unclosed\n');
      await assert.rejects(fl.validate({}, file), /rejected/);
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  });
