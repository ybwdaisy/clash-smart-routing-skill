'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const metadata = new Map();
function runningApps(text) {
  const apps = new Map();
  for (const line of text.split('\n')) {
    const native=line.trim().match(/^(?:(\d+)\s+)?(.*\/Clash\.app)\/Contents\/(?:MacOS\/Clash|PlugIns\/ClashmacOSExtension\.appex\/Contents\/MacOS\/ClashmacOSExtension)$/);
    if(native){const prior=apps.get(native[2]),main=line.endsWith('/MacOS/Clash');if(!prior||main)apps.set(native[2],{app:native[2],pid:Number(native[1])||null,client:'clash-app'});continue;}
    const match = line.trim().match(/^(?:(\d+)\s+)?(.*\/(FlClash|Clash Verge(?: Rev)?)\.app)\/Contents\/MacOS\/(FlClash|clash-verge)$/);
    if (match && ((match[3] === 'FlClash') === (match[4] === 'FlClash')))
      apps.set(match[2], {app: match[2], pid:Number(match[1])||null, client: match[3] === 'FlClash' ? 'flclash' : 'verge'});
  }
  return [...apps.values()];
}
function select(roots, apps, bundleId) {
  if (!apps.length) return {status: 'paused-no-client'};
  if (apps.length !== 1) return {status: 'paused-multiple-clients'};
  const app = apps[0], identifier = bundleId(app.app);
  if(app.client==='clash-app'&&identifier!=='com.hako.network')return {status:'paused-unconfigured-client',client:app.client};
  const matches = roots.filter(root => path.basename(root) === identifier);
  if (matches.length !== 1) return {status: 'paused-unconfigured-client', client: app.client};
  return {status: 'active', client: app.client, appName: path.basename(app.app, '.app'), pid:app.pid, root: matches[0], app: app.app};
}
function detect(roots, deps = {}) {
  try {
    const processes = deps.processes ?? (() => {
      const r = cp.spawnSync('/bin/ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 3000});
      if (r.status !== 0) throw Error('Cannot inspect running clients');
      return r.stdout;
    })();
    const bundleId = deps.bundleId || (app => {
      const file = path.join(app, 'Contents/Info.plist');
      if (!fs.existsSync(file)) throw Error('Application metadata is unavailable');
      const stamp=fs.statSync(file).mtimeMs, cached=metadata.get(file);
      if(cached?.stamp===stamp)return cached.id;
      const r = cp.spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', file], {encoding: 'utf8', timeout: 2000});
      if (r.status !== 0) throw Error('Application identifier is unavailable');
      const id=r.stdout.trim();metadata.set(file,{stamp,id});return id;
    });
    return select(roots, runningApps(processes), bundleId);
  } catch { return {status: 'paused-detection-error'}; }
}
function requireRoot(selection) {
  if (selection.status === 'active') return selection.root;
  const messages = {'paused-no-client': 'No supported proxy client is running; open one client',
    'paused-multiple-clients': 'Multiple proxy clients are running; close the other client',
    'paused-unconfigured-client': 'Running client has no uniquely matching configuration',
    'paused-detection-error': 'Cannot safely identify the running proxy client'};
  const error = Error(messages[selection.status] || 'Active client is unavailable'); error.code = selection.status; throw error;
}
module.exports = {runningApps, select, detect, requireRoot};
