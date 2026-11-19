import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { generateConfig } from '../src/steps/generate.js'

function installDirectory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'caw-infra-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, 'client'))
  return dir
}

test('Docker mode publishes the database and cache on the host loopback', async t => {
  const dir = installDirectory(t)
  const { envPath } = await generateConfig('api-only', { networkId: 1, useDocker: 'docker' }, dir)
  const { services } = parse(readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'))
  const env = readFileSync(envPath, 'utf8')

  assert.deepEqual(services.postgres.ports, ['127.0.0.1:5432:5432'])
  assert.deepEqual(services.redis.ports, ['127.0.0.1:6379:6379'])
  assert.match(env, /^DATABASE_URL=postgresql:\/\/.*@127\.0\.0\.1:5432\//m)
  assert.match(env, /^REDIS_URL=redis:\/\/127\.0\.0\.1:6379$/m)
})

test('existing-services mode uses the configured endpoints without publishing any ports', async t => {
  const dir = installDirectory(t)
  const dbUrl = 'postgresql://operator@db.example:5433/caw'
  const redisUrl = 'rediss://cache.example:6380'
  const { envPath } = await generateConfig('api-only', { networkId: 1, useDocker: 'existing', dbUrl, redisUrl }, dir)
  const env = readFileSync(envPath, 'utf8')

  assert.equal(existsSync(path.join(dir, 'docker-compose.yml')), false)
  assert.equal(new URL(env.match(/^DATABASE_URL=(.+)$/m)[1]).host, 'db.example:5433')
  assert.ok(env.split('\n').includes(`REDIS_URL=${redisUrl}`))
})
