const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), cp = require('node:child_process');
const YAML = require('../skills/clash-smart-routing/node_modules/yaml');
const router = require('../skills/clash-smart-routing/scripts/clash-router.cjs');
const monitor = require('../skills/clash-smart-routing/scripts/routing-monitor.cjs');
const core = process.env.MIHOMO_TEST_BIN || '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('real Mihomo hot-loads an exact AND rule, matches it on a new connection, and unloads it', {skip: !fs.existsSync(core)}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-core-'));
  const ctx = {root, stateDir: path.join(root, 'smart-routing-state'), config: {'external-controller': '', 'external-controller-unix': path.join(root, 'api.sock')}};
  fs.mkdirSync(ctx.stateDir); fs.writeFileSync(path.join(ctx.stateDir, 'learned.yaml'), 'payload: []\n');
  const target = http.createServer((req, res) => setTimeout(() => { res.writeHead(200); res.end(); }, 500));
  const reserve = http.createServer(); let child;
  try {
    await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const config = {...ctx.config, 'mixed-port': port, mode: 'rule', 'log-level': 'debug',
      hosts: {'probe.example.org': '127.0.0.1'},
      'rule-providers': {'smart-routing-learned': {type: 'file', behavior: 'classical', format: 'yaml', path: './smart-routing-state/learned.yaml'}},
      rules: ['RULE-SET,smart-routing-learned,DIRECT', 'MATCH,REJECT']};
    const file = path.join(root, 'test.yaml'); fs.writeFileSync(file, YAML.stringify(config));
    // Also validate the production-generated /32 + TCP/443 expression with the actual kernel.
    const state = monitor.emptyState(); state.entries.a = {host: 'probe.example.org', ip: '1.1.1.1', expires: Date.now() + 60000};
    fs.writeFileSync(path.join(ctx.stateDir, 'learned.yaml'), YAML.stringify({payload: monitor.payloadFor(state, Date.now(), () => false)}));
    const checked = cp.spawnSync(core, ['-t', '-d', root, '-f', file], {encoding: 'utf8', timeout: 15000});
    assert.equal(checked.status, 0, checked.stderr);
    fs.writeFileSync(path.join(ctx.stateDir, 'learned.yaml'), 'payload: []\n');
    child = cp.spawn(core, ['-d', root, '-f', file], {stdio: ['ignore', 'pipe', 'pipe']}); let log = '';
    child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
    for (let i = 0; i < 50 && !fs.existsSync(ctx.config['external-controller-unix']); i++) await sleep(50);
    const api = router.controller(ctx); await api('GET', '/version');
    // The loopback rule is only an isolated fixture; production learning rejects private IPs.
    const localRule = 'AND,((DOMAIN,probe.example.org),(IP-CIDR,127.0.0.1/32),(DST-PORT,' + target.address().port + '),(NETWORK,TCP))';
    await monitor.publish(ctx, api, [localRule]);
    const request = new Promise((resolve, reject) => {
      const req = http.request({hostname: '127.0.0.1', port, method: 'HEAD',
        path: 'http://probe.example.org:' + target.address().port + '/', headers: {Host: 'probe.example.org:' + target.address().port}}, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    let matched;
    for (let i = 0; i < 20 && !matched; i++) { const active = await api('GET', '/connections'); matched = (active.connections || []).find(c => c.rulePayload === 'smart-routing-learned'); if (!matched) await sleep(25); }
    assert.ok(matched, 'The new connection must actually match the learned rule\n' + log);
    assert.ok(matched.chains.includes('DIRECT')); assert.equal(await request, 200);
    await monitor.publish(ctx, api, []);
    assert.equal((await api('GET', '/providers/rules')).providers['smart-routing-learned'].ruleCount, 0);
  } finally {
    if (child && child.exitCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended; }
    await new Promise(resolve => target.close(resolve)); if (reserve.listening) await new Promise(resolve => reserve.close(resolve));
    fs.rmSync(root, {recursive: true, force: true});
  }
});
