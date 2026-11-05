'use strict';
const cp = require('node:child_process'), net = require('node:net');
function parseProxy(text) {
  const field = key => text.match(new RegExp('^\\s*' + key + '\\s*:\\s*(\\S+)', 'm'))?.[1];
  return Object.fromEntries([['http', 'HTTP'], ['https', 'HTTPS'], ['socks', 'SOCKS']].map(([name, prefix]) =>
    [name, {enabled: field(prefix + 'Enable') === '1', host: field(prefix + 'Proxy') || null, port: Number(field(prefix + 'Port') || 0)}]));
}
function matches(proxy, port) {
  return ['http', 'https', 'socks'].every(key => proxy[key]?.enabled && ['127.0.0.1', 'localhost', '::1'].includes(proxy[key].host) && proxy[key].port === port);
}
function systemProxy() {
  const r = cp.spawnSync('/usr/sbin/scutil', ['--proxy'], {encoding: 'utf8', timeout: 3000});
  if (r.status !== 0) throw Error('Cannot read macOS system proxy');
  return parseProxy(r.stdout);
}
function listener(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({host: '127.0.0.1', port}); let settled = false;
    const finish = ok => { if (!settled) { settled = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(300); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
async function waitReady(port, options = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid local proxy port');
  const now = options.now || Date.now, sleep = options.sleep || (ms => new Promise(yes => setTimeout(yes, ms)));
  const readProxy = options.readProxy || systemProxy, checkListener = options.checkListener || listener;
  const started = now(), timeout = options.timeoutMs ?? 15000; let last;
  while (true) {
    const proxy = await readProxy();
    const osReady = matches(proxy, port), listening = osReady ? await checkListener(port) : false;
    last = {elapsedMs: now() - started, proxy, listening}; options.onSample?.(last);
    if (osReady && listening) return {ready: true, ...last};
    if (now() - started >= timeout) { const error = Error('Local proxy did not become ready within ' + timeout + 'ms'); error.code = 'CLIENT_NOT_READY'; error.lastState = last; throw error; }
    await sleep(Math.min(250, timeout - (now() - started)));
  }
}
module.exports = {parseProxy, matches, systemProxy, listener, waitReady};
