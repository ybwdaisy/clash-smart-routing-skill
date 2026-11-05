'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const router = require('../skills/clash-smart-routing/scripts/clash-router.cjs');
test('saved client selection resolves multiple clients and refuses a missing target instead of switching', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-client-selection-'));
  const old = {data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME};
  try {
    process.env.XDG_DATA_HOME = base; process.env.XDG_CONFIG_HOME = path.join(base, 'preferences');
    const roots = ['clash-verge-first', 'clash-verge-second'].map(name => {
      const root = path.join(base, name); fs.mkdirSync(path.join(root, 'profiles'), {recursive: true});
      fs.writeFileSync(path.join(root, 'profiles/Script.js'), 'function main(c) { return c; }');
      fs.writeFileSync(path.join(root, 'profiles/test.yaml'), 'rules: [MATCH,Proxy]');
      fs.writeFileSync(path.join(root, 'clash-verge.yaml'), 'mode: rule');
      fs.writeFileSync(path.join(root, 'profiles.yaml'), 'current: test\nitems:\n  - {uid: Script, type: script, file: Script.js}\n  - {uid: test, file: test.yaml}\n');
      return fs.realpathSync(root);
    });
    assert.ok(router.discover().includes(roots[0])); assert.ok(router.discover().includes(roots[1]));
    router.selectClient(roots[1]); assert.equal(router.resolveConfigDir(undefined, {platform: 'linux'}), roots[1]);
    const live = {platform: 'darwin', processes:'7 /Applications/Clash Verge.app/Contents/MacOS/clash-verge', bundleId:()=>path.basename(roots[0])};
    assert.equal(router.resolveConfigDir(undefined, live), roots[0]);
    assert.throws(()=>router.resolveConfigDir(undefined,{...live,processes:''}),/No supported proxy client/);
    assert.throws(()=>router.resolveConfigDir(undefined,{...live,processes:live.processes+'\n8 /Applications/FlClash.app/Contents/MacOS/FlClash'}),/Multiple proxy clients/);
    assert.equal(router.resolveConfigDir(roots[0]), roots[0]);
    assert.equal(fs.statSync(router.bindingPath()).mode & 0o777, 0o600);
    fs.rmSync(roots[1], {recursive: true});
    assert.throws(() => router.resolveConfigDir(undefined, {platform: 'linux'}), /Selected client is unavailable/);
  } finally {
    for (const [name, value] of [['XDG_DATA_HOME', old.data], ['XDG_CONFIG_HOME', old.config]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(base, {recursive: true, force: true});
  }
});
