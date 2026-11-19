import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import inquirer from 'inquirer'
import { parse, stringify } from 'yaml'
import { generateConfig } from '../src/steps/generate.js'
import { promptDockerDatabaseUrl } from '../src/steps/infrastructure.js'

function installDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-credentials-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'client'))
  return dir
}

async function generate(dir, dbUrl) {
  await generateConfig('api-only', { useDocker: 'docker', networkId: 1, dbUrl }, dir)
  return parse(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8')).services
}

test('a normal PostgreSQL URL supplies exactly its credentials to Docker', async t => {
  const services = await generate(installDirectory(t), 'postgresql://builder:sample@localhost:5432/caw')
  assert.equal(services.postgres.environment.POSTGRES_USER, 'builder')
  assert.equal(services.postgres.environment.POSTGRES_PASSWORD, 'sample')
})

const punctuation = 'demo@:/?# %25 "é" $HOME ${CAW_SAMPLE} $$'
test('a password entered at the prompt survives URL, YAML and Compose escaping', async t => {
  t.mock.method(inquirer, 'prompt', async ([question]) => {
    assert.match(question.default, /^caw_[a-f0-9]{48}$/)
    return { dbPassword: punctuation }
  })
  const dbUrl = await promptDockerDatabaseUrl('caw')
  assert.equal(decodeURIComponent(new URL(dbUrl).password), punctuation)
  const { postgres } = await generate(installDirectory(t), dbUrl)
  assert.equal(postgres.environment.POSTGRES_PASSWORD, punctuation.split('$').join('$$'))
})

test('Docker Compose resolves the synthetic password literally', { skip: !process.env.CAW_TEST_COMPOSE }, async t => {
  const dir = installDirectory(t)
  await generate(dir, `postgresql://postgres:${encodeURIComponent(punctuation)}@127.0.0.1/caw`)
  const generated = path.join(dir, 'docker-compose.yml')
  const reference = path.join(dir, 'reference.yml')
  const model = parse(fs.readFileSync(generated, 'utf8'))
  model.services.postgres.environment.POSTGRES_PASSWORD = '${CAW_EXPECTED_PASSWORD}'
  fs.writeFileSync(reference, stringify(model))
  // Compose re-escapes literal dollars when printing its canonical model.
  // Compare against a reference that receives the exact password via an env var.
  function resolvedPassword(file, expected) {
    const output = execFileSync(process.env.CAW_TEST_COMPOSE, ['-f', file, 'config', '--format', 'json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, CAW_SAMPLE: 'unused', CAW_EXPECTED_PASSWORD: expected }
    })
    return JSON.parse(output).services.postgres.environment.POSTGRES_PASSWORD
  }
  const actual = resolvedPassword(generated, 'unused')
  assert.equal(actual, resolvedPassword(reference, punctuation))
  assert.notEqual(actual, resolvedPassword(reference, 'control'))
})

test('a managed database URL stays in the backend configuration when Docker runs Redis', async t => {
  const dir = installDirectory(t)
  const dbUrl = 'postgresql://reader:remote-sample@db.example:5432/caw?sslmode=require'
  const services = await generate(dir, dbUrl)
  assert.deepEqual(Object.keys(services), ['redis'])
  assert.ok(fs.readFileSync(path.join(dir, 'client/.env'), 'utf8').includes(dbUrl))
  assert.ok(!fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8').includes('remote-sample'))
})

test('fresh and rewritten Compose files are private on POSIX', { skip: process.platform === 'win32' }, async t => {
  const dir = installDirectory(t)
  const file = path.join(dir, 'docker-compose.yml')
  const first = await generate(dir)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.match(first.postgres.environment.POSTGRES_PASSWORD, /^[a-f0-9]{48}$/)
  fs.chmodSync(file, 0o644)
  const second = await generate(dir)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(second.postgres.environment.POSTGRES_PASSWORD, first.postgres.environment.POSTGRES_PASSWORD)
})

test('invalid local credentials stop generation without overwriting the previous configuration', async t => {
  const dir = installDirectory(t)
  await generate(dir, 'postgresql://postgres:previous@127.0.0.1/caw')
  const file = path.join(dir, 'docker-compose.yml')
  const saved = fs.readFileSync(file)
  for (const dbUrl of ['not-a-url', 'postgresql://postgres@127.0.0.1/caw', 'postgresql://postgres:bad%GG@127.0.0.1/caw']) {
    await assert.rejects(generate(dir, dbUrl), { name: 'Error', message: /^(Invalid|A password)/ })
    assert.deepEqual(fs.readFileSync(file), saved)
  }
})
