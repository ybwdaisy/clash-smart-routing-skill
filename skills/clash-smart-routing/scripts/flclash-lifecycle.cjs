'use strict';
// Capture children before quitting the GUI: a setuid core can outlive/reparent it.
const cp = require('node:child_process');
const APP = '/Applications/FlClash.app/Contents/MacOS/FlClash';
const CORE = '/Applications/FlClash.app/Contents/MacOS/FlClashCore';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function processRows(text) {
  return text.split('\n').filter(line => line.trim()).map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!m) throw Error('Cannot authenticate FlClash process state');
    return {pid: +m[1], ppid: +m[2], ruid: +m[3], uid: +m[4], born: m[5], exe: m[6]};
  });
}
function rows() {
  const p = cp.spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,ruid=,uid=,lstart=,comm='], {encoding: 'utf8', timeout: 1000, env: {...process.env, LC_ALL: 'C'}});
  if (p.status !== 0) throw Error('Cannot read FlClash process state');
  return processRows(p.stdout);
}
function sameIdentity(a, b) {
  return !!a && !!b && ['pid', 'ruid', 'uid', 'born', 'exe'].every(k => a[k] === b[k]);
}
function capture(list, uid) {
  const guis = list.filter(p => p.exe === APP), cores = list.filter(p => p.exe === CORE);
  if (!guis.length && !cores.length) return [];
  if (guis.length !== 1 || guis[0].uid !== uid || guis[0].ruid !== uid)
    throw Error('FlClash GUI ownership is ambiguous; no processes were signalled');
  const gui = guis[0];
  if (cores.some(p => p.ppid !== gui.pid || p.ruid !== uid || ![0, uid].includes(p.uid)))
    throw Error('Unattributed FlClash core; no processes were signalled');
  return [gui, ...cores];
}
async function quit(options = {}, deps = {}) {
  const scan = deps.rows || rows, now = deps.now || Date.now, sleep = deps.pause || pause;
  const signal = deps.signal || ((pid, name) => process.kill(pid, name));
  const uid = deps.uid ?? process.getuid();
  const request = deps.request || (() => cp.spawnSync('/usr/bin/osascript',
    ['-e', 'tell application id "com.follow.clash" to quit'], {encoding: 'utf8', timeout: 1500}));
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1500 || timeoutMs > 20000) throw Error('Invalid FlClash quit deadline');
  const captured = capture(scan(), uid);
  if (!captured.length) return {exited: true, signalled: 0};
  const start = now(), deadline = start + timeoutMs, sent = new Set();
  request(); // An AppleEvent error is not proof that the native shutdown failed.
  while (true) {
    const current = scan(), remaining = current.filter(p => p.exe === APP || p.exe === CORE);
    if (!remaining.length) return {exited: true, signalled: sent.size};
    if (remaining.some(p => !captured.some(old => sameIdentity(old, p))))
      throw Error('FlClash process identity changed; client switch stopped');
    if (now() >= deadline) throw Error('FlClash GUI/core did not exit; client switch stopped');
    if (options.forceCaptured && now() - start >= Math.min(2000, timeoutMs / 2)) {
      for (const old of captured) {
        if (sent.has(old.pid)) continue;
        // Re-read immediately before signalling: never kill a reused PID or
        // an unrelated orphan just because it has a familiar executable name.
        const actual = scan().find(p => p.pid === old.pid);
        if (!actual) continue;
        if (!sameIdentity(old, actual)) throw Error('FlClash PID reused; no signal sent');
        try { signal(old.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        sent.add(old.pid);
      }
    }
    await sleep(Math.min(100, Math.max(1, deadline - now())));
  }
}
module.exports = {APP, CORE, processRows, rows, capture, sameIdentity, quit};
