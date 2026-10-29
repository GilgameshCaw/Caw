import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildServiceList } from '../src/steps/generate.js'

// docs/SCALING.md: each install gets its own logical Redis DB (?db=N) so
// installs on one box do not collide. install.sh exports it as CAW_REDIS_URL,
// the CLI writes it to REDIS_URL, and these services have to be told about it
// too: NftTransferWatcher and DepositWatcher keep their block checkpoint in
// Redis, and without a redisUrl they use db 0, the first install's.

const WITH_CHECKPOINT_IN_REDIS = ['ActionProcessor', 'NftTransferWatcher', 'DepositWatcher']
const baseConfig = {
  network: 'testnet', networkId: 1, domain: 'node.example', apiPort: 4000,
  validatorId: 1, checkInterval: 30000,
}
const NODE_TYPES = ['full', 'frontend-api', 'api-only', 'validator']

function redisUrlOf(list, service) {
  return list.find(s => s.service === service)?.config?.redisUrl
}

test('every service that keeps state in Redis gets the install\'s Redis URL', () => {
  const redisUrl = 'redis://127.0.0.1:6379?db=3'
  for (const nodeType of NODE_TYPES) {
    const list = buildServiceList(nodeType, { ...baseConfig, redisUrl })
    for (const name of WITH_CHECKPOINT_IN_REDIS) {
      if (!list.some(s => s.service === name)) continue
      assert.equal(redisUrlOf(list, name), redisUrl, `${name} on a ${nodeType} node`)
    }
  }
})

test('the full node runs all three services, so the check above covers them', () => {
  const names = buildServiceList('full', { ...baseConfig, redisUrl: 'redis://127.0.0.1:6379' }).map(s => s.service)
  for (const name of WITH_CHECKPOINT_IN_REDIS) assert.ok(names.includes(name), name)
})

test('without a redisUrl the default Redis (db 0) is written explicitly', () => {
  const list = buildServiceList('full', baseConfig)
  for (const name of WITH_CHECKPOINT_IN_REDIS) {
    assert.equal(redisUrlOf(list, name), 'redis://127.0.0.1:6379', name)
  }
})

test('the three services agree with each other', () => {
  const redisUrl = 'redis://10.0.0.5:6380?db=7'
  const list = buildServiceList('full', { ...baseConfig, redisUrl })
  const urls = new Set(WITH_CHECKPOINT_IN_REDIS.map(n => redisUrlOf(list, n)))
  assert.deepEqual([...urls], [redisUrl])
})

test('client/config.template.json (the manual-install template) has it on all three too', () => {
  const template = JSON.parse(fs.readFileSync(new URL('../../client/config.template.json', import.meta.url), 'utf8'))
  const urls = WITH_CHECKPOINT_IN_REDIS.map(name => template.find(s => s.service === name)?.config?.redisUrl)
  assert.deepEqual(urls, Array(WITH_CHECKPOINT_IN_REDIS.length).fill('redis://127.0.0.1:6379'))
})
