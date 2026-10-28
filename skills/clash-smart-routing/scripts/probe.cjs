#!/usr/bin/env node
'use strict';
// Small routing probes: no login, paid APIs, or large downloads.
const http = require('node:http');
const os = require('node:os');
const cp = require('node:child_process');
const {discover, load, controller, verify, engine} = require('./clash-router.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function probe(ctx, api, item, port) {
  const before = (await api('GET', '/rules')).rules;
  const seen = new Set((await api('GET', '/connections')).connections.map(c => c.id));
  let done = false, status = '', observed;
  const child = cp.spawn('curl', ['--silent', '--show-error', '--noproxy', '', '--proxy', 'http://127.0.0.1:' + port,
    '--connect-timeout', '8', '--max-time', '15', '--max-filesize', '1048576', '--range', '0-1023',
    '--output', os.devNull, '--write-out', '%{http_code}', item.url], {stdio: ['ignore', 'pipe', 'ignore']});
  child.stdout.on('data', b => {status += b;});
  let exitCode;
  child.on('error', () => {done = true; exitCode = 'launch-error';});
  child.on('close', code => {done = true; exitCode = code;});
  while (!done) {
    const live = await api('GET', '/connections');
    const match = live.connections.find(c => !seen.has(c.id) && c.metadata.host === new URL(item.url).hostname);
    if (match) observed = {rule: match.rule, payload: match.rulePayload,
      direct: match.chains.includes('DIRECT'), managedProxy: match.chains.includes(engine.group)};
    await pause(50);
  }
  const after = (await api('GET', '/rules')).rules;
  const hits = after.filter((r, i) => r.payload === item.provider && (r.extra?.hitCount || 0) > (before[i]?.extra?.hitCount || 0));
  const hit = observed ? observed.payload === item.provider && (item.direct ? observed.direct : observed.managedProxy)
    : hits.some(r => r.proxy === (item.direct ? 'DIRECT' : engine.group));
  return {service: item.name, expected: item.direct ? 'DIRECT' : 'PROXY', passed: hit,
    evidence: observed ? 'connection-chain' : hits.length ? 'rule-hit-counter' : 'none',
    matchedProvider: observed?.payload || hits[0]?.payload || null, httpStatus: status.trim() || null, exitCode};
}
async function main(argv) {
  if (argv.length && (argv.length !== 2 || argv[0] !== '--config-dir')) throw Error('Usage: probe.cjs [--config-dir path]');
  const roots = argv.length ? [argv[1]] : discover();
  if (roots.length !== 1) throw Error('Identify one client using --config-dir');
  const ctx = load(roots[0]), api = controller(ctx);
  await verify(ctx, api);
  const port = (await api('GET', '/configs'))['mixed-port'] || ctx.config.port;
  if (!port) throw Error('An HTTP/mixed proxy listener is required for probes');
  const server = http.createServer((req, res) => setTimeout(() => {res.end('routing probe');}, 350));
  await new Promise((resolve, reject) => {server.on('error', reject); server.listen(0, '127.0.0.1', resolve);});
  try {
    const cases = [
      {name: 'OpenAI', url: 'https://chatgpt.com/robots.txt', provider: 'smart-routing-ai-guard'},
      {name: 'Claude', url: 'https://claude.ai/robots.txt', provider: 'smart-routing-ai-guard'},
      {name: 'GitHub', url: 'https://github.com/robots.txt', provider: 'smart-routing-github'},
      {name: 'Baidu cloud', url: 'https://pan.baidu.com/robots.txt', provider: 'smart-routing-baidu', direct: true},
      {name: 'iCloud', url: 'https://www.icloud.com/robots.txt', provider: 'smart-routing-icloud', direct: true},
      {name: 'Apple developer downloads', url: 'https://devimages-cdn.apple.com/robots.txt', provider: 'smart-routing-apple-dev', direct: true},
      {name: 'Private IP', url: 'http://127.0.0.1:' + server.address().port + '/', provider: 'smart-routing-lan-ip', direct: true}
    ];
    const results = [];
    for (const item of cases) results.push(await probe(ctx, api, item, port));
    return {passed: results.every(r => r.passed), results, note: 'Routing evidence only; HTTP errors do not establish an authenticated service session.'};
  } finally {server.closeAllConnections(); server.close();}
}
if (require.main === module) main(process.argv.slice(2)).then(r => {console.log(JSON.stringify(r, null, 2)); if (!r.passed) process.exitCode = 1;})
  .catch(e => {console.error(e.message); process.exitCode = 1;});
module.exports = {main};
