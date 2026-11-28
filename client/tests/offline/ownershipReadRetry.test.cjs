const { it } = require('node:test')
const { loadSource } = require('./loadSource.cjs')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const load = (_file, imports) => loadSource(join(__dirname, '../../src/services/StakeLedger/dailyReconciler.ts'), imports)

it('retries a transient ownership read and checks later tokens after a repeated failure', async () => {
  const reads = []
  const { runDailyReconciliation } = load('dailyReconciler.ts', {
    '../../prismaClient': { prisma: {
      cawOwnershipSnapshot: { findMany: async () => [1, 2, 3].map(tokenId => ({ tokenId })) },
      cawOwnershipCurrent: { findUnique: async ({ where: { tokenId } }) => {
        reads.push(tokenId)
        if (reads.length === 1 || tokenId === 2) throw Error('ownership read unavailable')
        return { ownership: '10' }
      } },
    } },
    './cawProfileLedger': { getCawProfileLedger: () => ({ cawOwnership: async () => 10n }) },
  })
  const result = await runDailyReconciliation()
  assert.deepEqual(reads, [1, 1, 2, 2, 3])
  assert.equal(result.checked, 3)
  assert.equal(result.matched, 2)
})
