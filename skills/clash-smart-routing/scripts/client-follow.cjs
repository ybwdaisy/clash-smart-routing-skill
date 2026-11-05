'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const base = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'clash-net');
function reportFile(service) { return path.join(base(), 'follow-' + service + '.json'); }
function status(service) { try { return JSON.parse(fs.readFileSync(reportFile(service), 'utf8')); } catch { return null; } }
const alive = child => child.exitCode === null && child.signalCode === null;
async function stopChild(child) {
  if (!alive(child)) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let i = 0; i < 100 && alive(child); i++) await new Promise(yes => setTimeout(yes, 100));
  if (alive(child)) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  for (let i = 0; i < 20 && alive(child); i++) await new Promise(yes => setTimeout(yes, 50));
  if (alive(child)) throw Error('Previous background worker did not exit');
}
function cleanOwnedLocks(root, pid) {
  for (const name of ['node-watchdog.lock', 'node-recovery.lock', 'monitor.lock']) {
    const file = path.join(root, 'smart-routing-state', name);
    try {
      const text = fs.readFileSync(file, 'utf8'), owner = name === 'node-recovery.lock' ? JSON.parse(text).pid : Number(text);
      if (owner === pid) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH' && fs.readFileSync(file, 'utf8') === text) fs.unlinkSync(file); } }
    } catch { /* Other owners and malformed locks are never removed. */ }
  }
}
class Follower {
  constructor(deps) { this.deps = deps; this.current = null; this.lastStart = -Infinity; }
  async stop() {
    if (!this.current) return;
    const old = this.current;
    await this.deps.stop(old.child); this.current = null;
    await this.deps.cleanup(old.selection.root, old.child.pid);
  }
  async tick() {
    const selection = this.deps.select(), now = this.deps.now();
    if (this.current && (!alive(this.current.child) || selection.root !== this.current.selection.root || selection.status !== 'active')) await this.stop();
    if (selection.status !== 'active') return this.deps.report({...selection, mode: 'automatic'});
    if (!this.current) {
      if (now - this.lastStart < 5000) return this.deps.report({...selection, status: 'waiting-worker-restart', mode: 'automatic'});
      this.lastStart = now; this.current = {selection, child: this.deps.spawn(selection.root)};
    }
    return this.deps.report({...selection, status: 'following', mode: 'automatic', workerPid: this.current.child.pid});
  }
}
async function run({service, script, router, cleanup = async () => {}}) {
  const lock = path.join(base(), 'follow-' + service + '.lock');
  fs.mkdirSync(base(), {recursive: true, mode: 0o700});
  if (fs.existsSync(lock)) {
    const owner = Number(fs.readFileSync(lock, 'utf8')); if (!Number.isInteger(owner) || owner <= 0) throw Error('Invalid follower lock');
    try { process.kill(owner, 0); throw Error('Client follower already running'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), {flag: 'wx', mode: 0o600});
  let stopping = false, wake;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const follower = new Follower({select: () => router.activeSelection(), now: Date.now,
    spawn: root => {
      const child = cp.spawn(process.execPath, [script, 'watch', '--config-dir', root], {detached: true,
        env: {...process.env, CLASH_NET_FOLLOW_ACTIVE: '1'}, stdio: 'inherit'});
      child.on('error', () => {}); return child;
    }, stop: stopChild,
    cleanup: async (root, pid) => { cleanOwnedLocks(root, pid); await cleanup(root); },
    report: value => { const result = {...value, at: new Date().toISOString()}; router.writePrivate(reportFile(service), JSON.stringify(result, null, 2)); return result; }});
  try {
    while (!stopping) {
      try { await follower.tick(); }
      catch { router.writePrivate(reportFile(service), JSON.stringify({at: new Date().toISOString(), mode: 'automatic', status: 'paused-follower-error'})); }
      if (!stopping) await new Promise(yes => { const timer = setTimeout(yes, 2000); wake = () => { clearTimeout(timer); yes(); }; });
      wake = null;
    }
  } finally {
    try { await follower.stop(); } finally {
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
      if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
    }
  }
}
module.exports = {Follower, run, status, reportFile, stopChild, cleanOwnedLocks};
