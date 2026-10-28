const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const https = require('node:https'), YAML = require('../skills/clash-smart-routing/node_modules/yaml');
const router = require('../skills/clash-smart-routing/scripts/clash-router.cjs');
const audit = require('../skills/clash-smart-routing/scripts/traffic-audit.cjs');
const m = require('../skills/clash-smart-routing/scripts/routing-monitor.cjs');
const minute = 60000, hour = 60 * minute, start = 1800000000000;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-monitor-'));
  const ctx = {root, stateDir: path.join(root, 'smart-routing-state'), config: {},
    subscription: {rules: ['DOMAIN-SUFFIX,explicit.example.org,Proxy', 'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT-DROP', 'MATCH,Proxy']}};
  fs.mkdirSync(ctx.stateDir); fs.writeFileSync(path.join(ctx.stateDir, 'settings.json'), '{"monitorEnabled":true}');
  const applied = router.engine.apply({proxies: [{name: 'node', type: 'ss'}], rules: ctx.subscription.rules}, {monitorEnabled: true});
  const rules = applied.rules.filter(router.engine.managedRule).map(r => { const [, payload, proxy] = r.split(','); return {type: 'RuleSet', payload, proxy}; });
  const providers = Object.fromEntries(Object.keys(router.engine.sources).map(k => [router.engine.prefix + k, {ruleCount: 1}]));
  providers['smart-routing-learned'] = {ruleCount: 0};
  let connections = [], tun = false, failUpdate = false;
  const api = async (method, route) => {
    if (route === '/configs') return {mode: 'rule', tun: {enable: tun}};
    if (route === '/rules') return {rules};
    if (route === '/proxies/' + encodeURIComponent(router.engine.group)) return {all: ['node'], now: 'node'};
    if (route === '/providers/rules') return {providers};
    if (route === '/connections') return {connections};
    if (method === 'PUT' && route === '/providers/rules/smart-routing-learned') {
      if (failUpdate) { failUpdate = false; throw Error('injected update failure'); }
      providers['smart-routing-learned'].ruleCount = YAML.parse(fs.readFileSync(path.join(ctx.stateDir, 'learned.yaml'), 'utf8')).payload.length;
      return null;
    }
    throw Error('Unexpected API request ' + method + ' ' + route);
  };
  const classified = {chinaIPs: audit.ranges('223.5.0.0/16'), chinaHost: audit.domains('+.douyin.com'),
    protectedHost: host => host === 'github.com' || host.endsWith('.githubusercontent.com') || host === 'protected-ai.example.org'};
  return {ctx, api, classified, providers, rules, setConnections: x => { connections = x; }, setTun: x => { tun = x; },
    failUpdate: () => { failUpdate = true; }, clean: () => fs.rmSync(root, {recursive: true, force: true})};
}
const connection = (host, ip = '1.1.1.1', extra = {}) => ({metadata: {host, destinationIP: ip, network: 'tcp', destinationPort: '443'},
  rule: 'Match', rulePayload: '', chains: ['node'], download: 1024, ...extra});
test('learning excludes private, reserved, fake-IP and transition addresses, plus malformed/local hostnames', () => {
  for (const ip of ['1.1.1.1', '223.5.5.5', '2606:4700:4700::1111']) assert.ok(m.publicIP(ip));
  for (const ip of ['127.0.0.1', '10.0.0.1', '198.18.1.2', '192.0.2.3', '::ffff:1.1.1.1', '::1', 'fe80::1', '2001:db8::1', '2002:0101:0101::1', 'garbage']) assert.ok(!m.publicIP(ip), ip);
  for (const host of ['localhost', 'secret.internal', 'host.onion', 'a.test', '1.1.1.1', 'a.com,DIRECT', '-a.com', 'a..com']) assert.equal(m.hostname(host), null);
  assert.equal(m.hostname('WWW.Example.COM.'), 'www.example.com');
});
test('AI/GitHub/APNs are protected regardless of China IP or fallback match', () => {
  for (const host of ['chatgpt.com', 'x.claude.ai', 'push.apple.com', 'courier-push-apple.com.akadns.net', 'github.com', 'protected-ai.example.org'])
    assert.ok(m.protectedTarget(host, '223.5.5.5', h => ['github.com', 'protected-ai.example.org'].includes(h)));
  assert.ok(m.protectedTarget('unlisted.example.org', '17.249.0.1', () => false));
  assert.ok(m.protectedTarget('unlisted.example.org', '', () => false, {rulePayload: 'smart-routing-apple-ai'}));
});
test('learning cannot bypass matching or unknown REJECT predicates; an unrelated UDP rejection is retained', () => {
  assert.equal(m.rejectRisk(['AND,((NETWORK,UDP),(DST-PORT,443)),REJECT-DROP'], 'cdn.example.org', '1.1.1.1'), false);
  for (const rule of ['DOMAIN-SUFFIX,example.org,REJECT', 'AND,((NETWORK,TCP),(DST-PORT,443)),REJECT', 'RULE-SET,ads,REJECT', 'PROCESS-NAME,other,REJECT'])
    assert.ok(m.rejectRisk([rule], 'cdn.example.org', '1.1.1.1'));
  assert.equal(m.rejectRisk(['AND,((NETWORK,UDP),(PROCESS-NAME,other)),REJECT'], 'cdn.example.org', '1.1.1.1'), false);
});
test('two separated successes grant an exact expiring lease; failure revokes it without a wildcard', () => {
  const first = m.resultFor(null, 'cdn.example.org', '1.1.1.1', true, start);
  assert.ok(!first.expires); assert.equal(first.successes, 1);
  assert.ok(!m.resultFor(first, first.host, first.ip, true, start + 1000).expires);
  const second = m.resultFor(first, first.host, first.ip, true, start + minute);
  const state = {...m.emptyState(), entries: {a: second}};
  assert.deepEqual(m.payloadFor(state, start + minute, () => false), [
    'AND,((DOMAIN,cdn.example.org),(IP-CIDR,1.1.1.1/32),(DST-PORT,443),(NETWORK,TCP))']);
  assert.equal(m.payloadFor(state, start + minute + hour, () => false).length, 0);
  assert.equal(m.payloadFor(state, start + minute, () => true).length, 0);
  assert.equal(m.resultFor(second, second.host, second.ip, false, start + 11 * minute).expires, 0);
});
test('monitor learns only fallback HTTPS; protected/explicit proxy/UDP routes remain intact, and expired rules unload', async () => {
  const f = fixture(); let probes = 0;
  try {
    f.setConnections([connection('cdn.example.org'), connection('github.com'), connection('explicit.example.org', '1.1.1.1', {rule: 'DomainSuffix'}),
      connection('protected-ai.example.org'), connection('video.example.org', '1.1.1.1', {metadata: {host: 'video.example.org', destinationIP: '1.1.1.1', network: 'udp', destinationPort: 443}})]);
    const deps = {api: f.api, classified: f.classified, probe: async () => { probes++; return true; }};
    assert.equal((await m.cycle(f.ctx, {...deps, now: start})).learnedRules, 0);
    assert.equal((await m.cycle(f.ctx, {...deps, now: start + minute})).learnedRules, 1);
    assert.equal(probes, 2); assert.equal(f.providers['smart-routing-learned'].ruleCount, 1);
    f.setConnections([]);
    assert.equal((await m.cycle(f.ctx, {...deps, now: start + minute + hour})).learnedRules, 0);
    assert.equal(f.providers['smart-routing-learned'].ruleCount, 0);
  } finally { f.clean(); }
});
test('failed active revalidation removes the learning rule, and the daily cap survives a new invocation', async () => {
  const f = fixture();
  try {
    f.setConnections([connection('cdn.example.org')]);
    const deps = {api: f.api, classified: f.classified, probe: async () => true};
    await m.cycle(f.ctx, {...deps, now: start}); await m.cycle(f.ctx, {...deps, now: start + minute});
    f.setConnections([connection('cdn.example.org', '1.1.1.1', {chains: ['DIRECT'], rule: 'RuleSet', rulePayload: 'smart-routing-learned'})]);
    assert.equal((await m.cycle(f.ctx, {...deps, probe: async () => false, now: start + 12 * minute})).learnedRules, 0);
    f.setConnections([connection('other.example.org')]);
    assert.equal((await m.cycle(f.ctx, {...deps, now: start + 13 * minute, options: {dailyProbes: 3}})).probes, 0);
  } finally { f.clean(); }
});
test('TUN pauses learning and clears active rules; provider update failure restores the previous file', async () => {
  const f = fixture();
  try {
    await m.publish(f.ctx, f.api, ['DOMAIN,fixture.example.org']);
    const before = fs.readFileSync(path.join(f.ctx.stateDir, 'learned.yaml'), 'utf8'); f.failUpdate();
    await assert.rejects(() => m.publish(f.ctx, f.api, []), /injected update/);
    assert.equal(fs.readFileSync(path.join(f.ctx.stateDir, 'learned.yaml'), 'utf8'), before);
    assert.equal(f.providers['smart-routing-learned'].ruleCount, 1);
    f.setTun(true);
    const report = await m.cycle(f.ctx, {api: f.api, now: start, classified: f.classified, probe: () => { throw Error('must not probe'); }});
    assert.equal(report.status, 'paused'); assert.equal(report.reason, 'tun-probe-path-unverified');
    assert.equal(f.providers['smart-routing-learned'].ruleCount, 0);
  } finally { f.clean(); }
});
test('DNS resolution work and probes remain bounded even when all destination addresses are missing', async () => {
  const f = fixture(); let resolutions = 0;
  try {
    f.setConnections(Array.from({length: 100}, (_, i) => connection('host' + i + '.example.org', '')));
    const r = await m.cycle(f.ctx, {api: f.api, classified: f.classified, now: start, resolveIP: async () => { resolutions++; return null; }});
    assert.equal(resolutions, 6); assert.equal(r.probes, 0);
  } finally { f.clean(); }
});
test('a missing learning provider can be repaired once, while failed repairs do not loop', async () => {
  const f = fixture(); let repaired = 0;
  try {
    delete f.providers['smart-routing-learned'];
    const deps = {api: f.api, classified: f.classified, now: start, repair: async ctx => {
      repaired++; f.providers['smart-routing-learned'] = {ruleCount: 0}; return ctx;
    }};
    assert.equal((await m.cycle(f.ctx, deps)).repaired, true); assert.equal(repaired, 1);
    delete f.providers['smart-routing-learned'];
    await assert.rejects(() => m.cycle(f.ctx, {...deps, now: start + minute, repair: async () => { throw Error('user-script-edited'); }}), /user-script-edited/);
    const report = await m.cycle(f.ctx, {...deps, now: start + 2 * minute});
    assert.equal(report.status, 'paused'); assert.equal(repaired, 1);
  } finally { f.clean(); }
});
test('direct probe verifies SNI and TLS, sends only HEAD / and refuses redirects or certificate failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-tls-'));
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem');
  const made = cp.spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=probe.example.org', '-addext', 'subjectAltName=DNS:probe.example.org'], {encoding: 'utf8'});
  assert.equal(made.status, 0);
  let status = 200, seen = 0;
  const server = https.createServer({key: fs.readFileSync(key), cert: fs.readFileSync(cert)}, (req, res) => {
    seen++; assert.equal(req.method, 'HEAD'); assert.equal(req.url, '/'); assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined); res.writeHead(status); res.end();
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (options, callback) => { assert.equal(options.hostname, '1.1.1.1'); assert.equal(options.rejectUnauthorized, true);
      return https.request({...options, hostname: '127.0.0.1', port: server.address().port}, callback); };
    const options = {request, ca: fs.readFileSync(cert)};
    assert.equal(await m.directProbe('probe.example.org', '1.1.1.1', options), true);
    status = 302; assert.equal(await m.directProbe('probe.example.org', '1.1.1.1', options), false);
    assert.equal(await m.directProbe('wrong.example.org', '1.1.1.1', options), false);
    assert.equal(await m.directProbe('probe.example.org', '1.1.1.1', {request}), false);
    assert.equal(seen, 2);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, {recursive: true, force: true}); }
});
test('macOS service arguments preserve spaces and XML metacharacters without shell interpolation', () => {
  const xml = m.launchPlist('/opt/homebrew/bin/node', '/a b/routing-monitor.cjs', '/profile/a&b');
  assert.ok(xml.includes('<string>/a b/routing-monitor.cjs</string>'));
  assert.ok(xml.includes('<string>/profile/a&amp;b</string>')); assert.ok(!xml.includes('/bin/sh'));
});
test('base rollback restores monitor settings, including compatibility with older snapshots', async () => {
  const crypto = require('node:crypto');
  for (const legacy of [false, true]) {
    const f = fixture();
    try {
      const backup = path.join(f.ctx.stateDir, 'backup'); fs.mkdirSync(backup);
      const script = path.join(f.ctx.root, 'Script.js'), runtime = path.join(f.ctx.root, 'runtime.yaml'), subscription = path.join(f.ctx.root, 'sub.yaml');
      fs.writeFileSync(script, 'managed-script'); fs.writeFileSync(subscription, 'original-source');
      fs.writeFileSync(path.join(backup, 'Script.js'), 'previous-script'); fs.writeFileSync(path.join(backup, 'runtime.yaml'), 'rules: []\n');
      fs.writeFileSync(path.join(backup, 'runtime.json'), '{"rules":[]}');
      const hash = text => crypto.createHash('sha256').update(text).digest('hex');
      const state = {backup, scriptHash: hash('managed-script'), subscriptionHash: hash('original-source'),
        ...(legacy ? {} : {settingsBefore: '{"preferredNode":"previous"}'})};
      fs.writeFileSync(path.join(f.ctx.stateDir, 'state.json'), JSON.stringify(state));
      await router.rollback({...f.ctx, scriptFile: script, runtimeFile: runtime, subscriptionFile: subscription}, async () => null);
      const settings = JSON.parse(fs.readFileSync(path.join(f.ctx.stateDir, 'settings.json'), 'utf8'));
      assert.ok(!settings.monitorEnabled); assert.equal(fs.readFileSync(script, 'utf8'), 'previous-script');
      assert.equal(fs.readFileSync(subscription, 'utf8'), 'original-source');
      if (!legacy) assert.equal(settings.preferredNode, 'previous');
    } finally { f.clean(); }
  }
});
