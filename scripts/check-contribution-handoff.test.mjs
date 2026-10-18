import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateContributionHandoff } from './check-contribution-handoff.mjs'

const exampleUrl = new URL('../docs/contribution-handoff.example.json', import.meta.url)
const checkerUrl = new URL('./check-contribution-handoff.mjs', import.meta.url)
const example = JSON.parse(readFileSync(exampleUrl, 'utf8'))
const check = value => validateContributionHandoff(value)

test('an actionable, identity-free handoff is valid', () => {
  assert.deepEqual(check(example), [])
  assert.equal(Object.hasOwn(example, 'maintainer'), false)
  assert.equal(Object.hasOwn(example, 'successor'), false)
})

test('an individual can step back without naming a replacement', () => {
  const note = { ...example, status: 'paused' }
  assert.deepEqual(check(note), [])
})

test('a completed change may have no further actions', () => {
  assert.deepEqual(check({ ...example, status: 'complete', nextSteps: [] }), [])
})

test('unfinished work must include a next step', () => {
  assert.match(check({ ...example, status: 'paused', nextSteps: [] }).join('\n'), /nextSteps/)
})

test('reproducible checks and evidence must be present', () => {
  const errors = check({ ...example, evidence: [], checks: [] })
  assert(errors.some(e => e.includes('evidence')))
  assert(errors.some(e => e.includes('checks')))
})

test('unknowns are explicit even when there are none', () => {
  assert.deepEqual(check({ ...example, unknowns: [] }), [])
  assert(check({ ...example, unknowns: undefined }).some(e => e.includes('unknowns')))
})

test('decisions need their reasons, not just a conclusion', () => {
  const errors = check({ ...example, decisions: [{ choice: 'Seal immediately', reason: '' }] })
  assert(errors.some(e => e.includes('decisions[0].reason')))
})

test('malformed input is rejected without throwing', () => {
  assert(check(null).length > 0)
  assert(check([]).length > 0)
  assert(check({ ...example, version: 9 }).some(e => e.includes('version')))
  assert(check({ ...example, status: 'permanent-owner' }).some(e => e.includes('status')))
})

test('the local CLI accepts the example without any network or database', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(checkerUrl), fileURLToPath(exampleUrl),
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS/)
})

test('the local CLI reports missing input and exits nonzero', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(checkerUrl)], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage:/)
})

test('the CLI rejects invalid input when invoked through a symlinked script or directory', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'caw-handoff-test-'))
  try {
    const invalidFile = join(tempDir, 'invalid.json')
    writeFileSync(invalidFile, '')

    const linkedScript = join(tempDir, 'linked-checker.mjs')
    symlinkSync(fileURLToPath(checkerUrl), linkedScript)

    const linkedRoot = join(tempDir, 'linked-root')
    symlinkSync(fileURLToPath(new URL('../', import.meta.url)), linkedRoot, 'dir')
    const linkedDirScript = join(linkedRoot, 'scripts', 'check-contribution-handoff.mjs')

    for (const script of [linkedScript, linkedDirScript]) {
      const invalid = spawnSync(process.execPath, [script, invalidFile], { encoding: 'utf8' })
      assert.equal(invalid.status, 1, script + ': ' + invalid.stderr)
      assert.match(invalid.stderr, /FAIL/)

      const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' })
      assert.equal(missing.status, 2, script + ': ' + missing.stderr)
      assert.match(missing.stderr, /Usage:/)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('importing the checker with node -e does not execute the CLI', () => {
  const result = spawnSync(process.execPath, [
    '-e', "import('./scripts/check-contribution-handoff.mjs')", 'foo',
  ], { encoding: 'utf8', cwd: fileURLToPath(new URL('../', import.meta.url)) })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
