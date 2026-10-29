/**
 * tokenDataStore.test.ts
 *
 * The persisted token list survives a reload with its types intact: the
 * BigInt balance fields come back as BigInt, and a digit-only username
 * (valid on-chain: [0-9a-z]) comes back as the same string.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const OWNER = '0x00000000000000000000000000000000000000aa'

async function loadStore() {
  vi.resetModules()
  return (await import('./tokenDataStore')).useTokenDataStore
}

describe('tokenDataStore persistence', () => {
  beforeEach(() => localStorage.clear())

  it('keeps digit-only usernames as strings across a reload', async () => {
    const before = await loadStore()
    before.getState().setTokensForAddress(OWNER, ['1234', '007', 'alice'].map((username, i) => ({
      tokenId: i + 1, username, withdrawable: 1n, ownerBalance: 2n, stakedAmount: 10n ** 24n,
      address: OWNER, owner: OWNER, cawonce: 3,
    })))

    const after = await loadStore()
    const tokens = after.getState().tokensByAddress[OWNER]
    expect(tokens.map(t => t.username)).toEqual(['1234', '007', 'alice'])
    for (const t of tokens) {
      expect(t.withdrawable).toBe(1n)
      expect(t.ownerBalance).toBe(2n)
      expect(t.stakedAmount).toBe(10n ** 24n)
      expect(t.cawonce).toBe(3)
    }
  })
})
