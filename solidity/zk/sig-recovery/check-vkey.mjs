import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const project = fileURLToPath(new URL('.', import.meta.url));
const keyPattern = /^0x[0-9a-fA-F]{64}$/;

// A matching key is one build check, not proof generation or chain verification.
export function checkVkey({ read = readFileSync, run = spawnSync } = {}) {
  const fixture = JSON.parse(read(new URL('../../test/zk-fixtures/groth16-fixture.json', import.meta.url), 'utf8'));
  if (typeof fixture.vkey !== 'string' || !keyPattern.test(fixture.vkey)) {
    throw new Error('invalid fixture vkey; build not started');
  }
  const result = run('cargo', ['run', '--locked', '--release', '--bin', 'vkey'], {
    cwd: project, encoding: 'utf8', shell: false, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('vkey build failed; no match established');
  }
  const actual = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!keyPattern.test(actual)) throw new Error('vkey output must contain exactly one bytes32 key');
  if (actual.toLowerCase() !== fixture.vkey.toLowerCase()) {
    throw new Error(`vkey mismatch: expected ${fixture.vkey}, derived ${actual}`);
  }
  return actual;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`fixture key matches derived key: ${checkVkey()}`);
    console.log('proof generation, deployment binding and independent reproduction remain separate checks');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
