import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVkey } from './check-vkey.mjs';

const key = '0x' + 'ab'.repeat(32);
const read = () => JSON.stringify({ vkey: key });
const success = { status: 0, signal: null, stdout: key + '\n' };

test('builds the actual vkey utility with the lockfile required', () => {
  assert.equal(checkVkey({ read, run(command, args, options) {
    assert.equal(command, 'cargo');
    assert.deepEqual(args, ['run', '--locked', '--release', '--bin', 'vkey']);
    assert.equal(options.shell, false);
    assert.match(options.cwd.replaceAll('\\', '/'), /\/solidity\/zk\/sig-recovery\/$/);
    return success;
  } }), key);
});

test('uses the committed fixture location independently of caller cwd', () => {
  checkVkey({ read(url) {
    assert.match(url.pathname, /\/solidity\/test\/zk-fixtures\/groth16-fixture.json$/);
    return read();
  }, run: () => success });
});

test('rejects a different derived key', () => {
  assert.throws(() => checkVkey({ read, run: () => ({ ...success, stdout: '0x' + 'cd'.repeat(32) }) }), /mismatch/);
});

test('does not accept echoed keys from a failed or killed build', () => {
  for (const result of [{ ...success, status: 1 }, { ...success, signal: 'SIGTERM' },
    { ...success, error: new Error('missing cargo') }, { ...success, status: null }]) {
    assert.throws(() => checkVkey({ read, run: () => result }), /build failed/);
  }
});

test('rejects empty, malformed, multi-key and log-contaminated stdout', () => {
  for (const stdout of ['', '0x12', key + '\n' + key, 'log\n' + key, undefined]) {
    assert.throws(() => checkVkey({ read, run: () => ({ ...success, stdout }) }), /exactly one/);
  }
});

test('bad fixture stops before any build', () => {
  for (const value of [{}, { vkey: 42 }, { vkey: '0x12' }]) {
    assert.throws(() => checkVkey({ read: () => JSON.stringify(value), run: () => assert.fail('must not build') }), /invalid fixture/);
  }
});

test('missing or corrupt fixture cannot pass', () => {
  for (const read of [() => { throw new Error('missing fixture'); }, () => '{']) {
    assert.throws(() => checkVkey({ read, run: () => assert.fail('must not build') }));
  }
});

test('hexadecimal case and surrounding whitespace do not change key bytes', () => {
  assert.equal(checkVkey({ read, run: () => ({ ...success, stdout: '  0x' + 'AB'.repeat(32) + '\n' }) }), '0x' + 'AB'.repeat(32));
});

test('direct and linked entry points enforce the fixture key', { skip: process.platform === 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'vkey-entry-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const checker = fileURLToPath(new URL('./check-vkey.mjs', import.meta.url));
  const link = join(dir, 'alias.mjs');
  symlinkSync(checker, link);
  writeFileSync(join(dir, 'cargo'), '#!/bin/sh\necho 0x' + '00'.repeat(32) + '\n', {mode: 0o700});
  for (const args of [[checker], [link], ['--preserve-symlinks-main', link]]) {
    const result = spawnSync(process.execPath, args, {cwd: dir, encoding: 'utf8',
      env: {...process.env, PATH: dir + delimiter + process.env.PATH}});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /vkey mismatch/);
  }
});
