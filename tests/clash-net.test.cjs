'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const source = path.resolve(__dirname, '../skills/clash-smart-routing/scripts/clash-net');
test('clash-net forwards recovery, inspection and auto controls literally from a checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-net-cli-'));
  try {
    fs.writeFileSync(path.join(root, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {mode: 0o755});
    const invoke = args => cp.spawnSync('/bin/sh', [source, ...args], {encoding: 'utf8', env: {...process.env, PATH: root + path.delimiter + process.env.PATH}});
    const base = path.dirname(source);
    for (const [args, script, command] of [[[], 'node-recovery.cjs', 'recover'], [['check'], 'node-recovery.cjs', 'check'],
      [['auto'], 'node-watchdog.cjs', 'status'], [['auto', 'on'], 'node-watchdog.cjs', 'install'], [['auto', 'off'], 'node-watchdog.cjs', 'uninstall'],
      [['config', 'discover'], 'clash-router.cjs', 'discover']]) {
      const r = invoke(args); assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.trimEnd().split('\n'), [path.join(base, script), command]);
    }
    const extra = invoke(['auto', 'status', '--config-dir', '/a path/with spaces']);
    assert.equal(extra.status, 0); assert.deepEqual(extra.stdout.trimEnd().split('\n').slice(-3), ['status', '--config-dir', '/a path/with spaces']);
    const config = invoke(['config', 'apply', '--config-dir', '/another client/path', '--activate']);
    assert.equal(config.status, 0); assert.deepEqual(config.stdout.trimEnd().split('\n'),
      [path.join(base, 'clash-router.cjs'), 'apply', '--config-dir', '/another client/path', '--activate']);
    const invalid = invoke(['auto', 'wrong']); assert.equal(invalid.status, 2); assert.match(invalid.stderr, /clash-net auto/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
test('copied clash-net launcher resolves the installed skill through CODEX_HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-net-install-'));
  try {
    const bin = path.join(root, 'bin'), codex = path.join(root, 'codex home'), scripts = path.join(codex, 'skills/clash-smart-routing/scripts');
    fs.mkdirSync(bin); fs.mkdirSync(scripts, {recursive: true});
    fs.copyFileSync(source, path.join(bin, 'clash-net'));
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {mode: 0o755});
    fs.writeFileSync(path.join(scripts, 'node-recovery.cjs'), '');
    const r = cp.spawnSync('/bin/sh', [path.join(bin, 'clash-net'), 'check'], {encoding: 'utf8', env: {...process.env, CODEX_HOME: codex, PATH: bin + path.delimiter + process.env.PATH}});
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.stdout.trimEnd().split('\n'), [path.join(scripts, 'node-recovery.cjs'), 'check']);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
