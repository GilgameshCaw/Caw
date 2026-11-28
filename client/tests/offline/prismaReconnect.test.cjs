const { it } = require('node:test')
const { loadSource } = require('./loadSource.cjs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const turn = () => new Promise(resolve => setImmediate(resolve))
const load = (_path, imports) => loadSource(join(__dirname, '../../src/prismaClient.ts'), imports)


it('keeps concurrent query retries waiting for one shared reconnect', async () => {
  const opened = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const attempts = []
  let connected = false
  let connects = 0
  let disconnects = 0
  const { prisma } = load('prismaClient.ts', { '@prisma/client': {
    PrismaClient: class {
      user = { findUnique: async id => {
        attempts.push(id)
        if (!connected) throw Error('Engine is not yet connected')
        return { id }
      } }
      async $disconnect() { disconnects++ }
      async $connect() {
        connects++
        opened.resolve()
        await resume.promise
        connected = true
      }
    },
  } })
  const first = prisma.user.findUnique(1)
  await opened.promise
  const second = prisma.user.findUnique(2)
  const settled = Promise.allSettled([first, second])
  try {
    await turn()
    assert.deepEqual(attempts, [1, 2])
  } finally {
    resume.resolve()
    await settled
  }
  assert.deepEqual(await settled, [
    { status: 'fulfilled', value: { id: 1 } },
    { status: 'fulfilled', value: { id: 2 } },
  ])
  assert.deepEqual(attempts, [1, 2, 1, 2])
  assert.deepEqual([connects, disconnects], [1, 1])
})
