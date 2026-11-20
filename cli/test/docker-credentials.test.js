import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import inquirer from 'inquirer'
import { parse, stringify } from 'yaml'
import { generateConfig } from '../src/steps/generate.js'
import { dockerDatabaseUrl, promptDockerDatabaseUrl } from '../src/steps/infrastructure.js'
import { dockerConfigPair, updatePair } from '../src/steps/dockerConfigPair.js'

function installDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-credentials-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'client'))
  return dir
}

test('invalid recovery data preserves both current files and the marker', t => {
  const dir = installDirectory(t)
  const env = path.join(dir, 'client/.env'), compose = path.join(dir, 'docker-compose.yml')
  const marker = path.join(dir, '.caw-db-pending')
  fs.writeFileSync(env, 'current env')
  fs.writeFileSync(compose, 'current compose')
  for (const pair of [[null, '!'], ['!', null], ['b2xk', 'Zh==']]) {
    const original = JSON.stringify(pair)
    fs.writeFileSync(marker, original)
    assert.throws(() => updatePair(dir), /Invalid database configuration recovery file/)
    assert.equal(fs.readFileSync(marker, 'utf8'), original)
    assert.equal(fs.readFileSync(env, 'utf8'), 'current env')
    assert.equal(fs.readFileSync(compose, 'utf8'), 'current compose')
  }
})

async function generate(dir, dbUrl) {
  await generateConfig('api-only', { useDocker: 'docker', networkId: 1, dbUrl }, dir)
  return parse(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8')).services
}

test('a pending installer cannot overwrite a newer credential pair', async t => {
  for (const existing of [false, true]) {
    const dir = installDirectory(t)
    if (existing) await generate(dir, 'postgresql://one:old@localhost/caw')
    const version = dockerConfigPair(dir)
    const dbUrl = existing ? await dockerDatabaseUrl('caw', dir) : 'postgresql://one:first@localhost/caw'
    await generate(dir, 'postgresql://two:current@localhost/selected_db')
    const files = ['client/.env', 'docker-compose.yml', 'client/config.json'].map(name => path.join(dir, name))
    const saved = files.map(file => fs.readFileSync(file))
    await assert.rejects(generateConfig('api-only', { useDocker: 'docker', networkId: 1, dbUrl, dockerConfigVersion: version }, dir))
    assert.deepEqual(files.map(file => fs.readFileSync(file)), saved)
    assert.equal(parse(saved[1].toString()).services.postgres.environment.POSTGRES_DB, 'selected_db')
  }
})

test('two installer processes starting from one snapshot commit exactly one complete pair', async t => {
  const dir = installDirectory(t)
  const version = dockerConfigPair(dir)
  const module = new URL('../src/steps/dockerConfigPair.js', import.meta.url).href
  const code = `import {dockerConfigPair} from ${JSON.stringify(module)};
    const [dir, version, name] = process.argv.slice(1);
    dockerConfigPair(dir, ['env-'+name, 'compose-'+name], version);`
  const names = ['first', 'second']
  const results = await Promise.allSettled(names.map(name => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', code, dir, version, name])))
  const winners = names.filter((_, i) => results[i].status === 'fulfilled')
  assert.equal(winners.length, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'client/.env'), 'utf8'), 'env-' + winners[0])
  assert.equal(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'), 'compose-' + winners[0])
  assert.equal(fs.existsSync(path.join(dir, '.caw-db-pending')), false)
})

test('a normal PostgreSQL URL supplies exactly its credentials to Docker', async t => {
  for (const query of ['', '?port=5432']) {
    const services = await generate(installDirectory(t), `postgresql://builder:sample@localhost:5432/caw${query}`)
    assert.equal(services.postgres.environment.POSTGRES_USER, 'builder')
    assert.equal(services.postgres.environment.POSTGRES_PASSWORD, 'sample')
  }
})

const punctuation = 'demo@:/?# %25 "é" $HOME ${CAW_SAMPLE} $$'
test('rejects local query credentials before writing configuration', async t => {
  for (const option of ['user=alternate', 'password=sample']) {
    const dir = installDirectory(t)
    await assert.rejects(generate(dir, 'postgresql://operator:sample@localhost/caw?' + option), /authority only/)
    assert.equal(fs.existsSync(path.join(dir, 'client/.env')), false)
  }
})
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
  for (const endpoint of [
    'db.example:5432/caw?sslmode=require',
    'localhost/caw?host=db.example',
    'localhost/caw?hostaddr=192.0.2.10',
    'localhost/caw?service=managed',
    '127.0.0.1:5432/caw?port=5432&port=6432',
  ]) {
    const dbUrl = `postgresql://reader:remote-sample@${endpoint}`
    const services = await generate(dir, dbUrl)
    assert.deepEqual(Object.keys(services), ['redis'])
    assert.ok(fs.readFileSync(path.join(dir, 'client/.env'), 'utf8').includes(dbUrl))
    assert.ok(!fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8').includes('remote-sample'))
  }
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
test('a failed second rename restores both files and keeps the saved password', async t => {
  const dir = installDirectory(t)
  const creds = 'postgresql://first:fixture@localhost/caw'
  await generate(dir, creds)
  const paths = ['client/.env', 'docker-compose.yml'].map(name => path.join(dir, name))
  const before = paths.map(p => fs.readFileSync(p, 'utf8'))
  const rename = fs.renameSync
  let fail = true
  t.mock.method(fs, 'renameSync', (src, dest) => {
    if (fail && dest === paths[1]) { fail = false; throw Error('interrupted write') }
    return rename(src, dest)
  })
  assert.throws(() => updatePair(dir, ['new env', 'new compose']), /interrupted write/)
  assert.deepEqual(paths.map(p => fs.readFileSync(p, 'utf8')), before)
  assert.ok((await dockerDatabaseUrl('caw', dir)).startsWith(creds))
  const worker = new URL('../src/steps/dockerConfigPair.js', import.meta.url).href
  const stopAfterFirstRename = `
    import fs from 'node:fs'
    import { updatePair } from ${JSON.stringify(worker)}
    const rename = fs.renameSync
    fs.renameSync = (src, dest) => {
      rename(src, dest)
      if (dest === process.argv[2]) process.exit(73)
    }
    updatePair(process.argv[1], ['DATABASE_URL=interrupted', 'interrupted compose'])
  `
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', stopAfterFirstRename, dir, paths[0]]), { status: 73 })
  assert.equal(fs.readFileSync(paths[0], 'utf8'), 'DATABASE_URL=interrupted')
  assert.ok((await dockerDatabaseUrl('caw', dir)).startsWith(creds))
  assert.deepEqual(paths.map(p => fs.readFileSync(p, 'utf8')), before)
})
