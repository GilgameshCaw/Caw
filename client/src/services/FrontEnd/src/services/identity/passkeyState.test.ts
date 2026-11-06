import { describe, it, expect } from 'vitest'
import { readPasskeyState, type PasskeyStateClient } from './passkeyState'

const WALLET = '0x1111111111111111111111111111111111111111' as const
const RECOVERY = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

// Real SmartEOA storage, from vm.dumpState after running the contract under forge.
const SLOT_0 = '0x000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c801'
const HASH_0 = '0x405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace'
const HASH_1 = '0x405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5acf'
const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

/** initialize() only: one key, validFrom 0. */
const BOOTSTRAP: Record<string, string> = {
  [word(0)]: SLOT_0,
  [word(2)]: word(1),
  [HASH_0]: '0x6b485436b9b234417e59960d9ab1366322cfad1c365f281a05863557ce7f5ce4',
  '0x999d0f74746ff6b6e572cb50ae14decf9175a7ad441746e2b47e63e8e735f376': word(0x11),
  '0x999d0f74746ff6b6e572cb50ae14decf9175a7ad441746e2b47e63e8e735f377': word(0x12),
  '0x999d0f74746ff6b6e572cb50ae14decf9175a7ad441746e2b47e63e8e735f378': word(0xf4240),
}

/** First key removed; two added at t=1_000_000 and t=1_007_200. */
const ADDED_AT = 1_000_000
const FIRST_ACTIVE_AT = ADDED_AT + 24 * 3600
const SECOND_ACTIVE_AT = ADDED_AT + 26 * 3600
const HASH_A = '0x23f09b9b15701d8667bae6a586e97da1f8fea95e97c1522b22b64c4b0f00cf7e'
const HASH_B = '0x030f0efcc40fe9201fb831791546d7474e2156f5c292570e2c5f5402332193a9'
const TWO_ADDED: Record<string, string> = {
  [word(0)]: SLOT_0,
  [word(2)]: word(2),
  [word(4)]: word(3),
  [HASH_0]: HASH_A,
  [HASH_1]: HASH_B,
  '0xd37befca48f5844974937cbcfd20b324999b2755ac1e465a25158e135c54a56b': word(0x21),
  '0xd37befca48f5844974937cbcfd20b324999b2755ac1e465a25158e135c54a56c': word(0x22),
  '0xd37befca48f5844974937cbcfd20b324999b2755ac1e465a25158e135c54a56d':
    '0x0000000000000000000000000000000000000000001093c000000000000f4240',
  '0xc39eaf577937c4998b56f9793fb69e4e3ed295067e22436fcb47beadc267e52f': word(0x31),
  '0xc39eaf577937c4998b56f9793fb69e4e3ed295067e22436fcb47beadc267e530': word(0x32),
  '0xc39eaf577937c4998b56f9793fb69e4e3ed295067e22436fcb47beadc267e531':
    '0x00000000000000000000000000000000000000000010afe000000000000f5e60',
}

function client(storage: Record<string, string>, now: number): PasskeyStateClient {
  return {
    getStorageAt: async ({ address, slot }) => {
      expect(address).toBe(WALLET)
      return (storage[slot] ?? undefined) as `0x${string}` | undefined
    },
    getBlock: async () => ({ timestamp: BigInt(now) }),
  }
}

const hashes = (rows: { pubkeyHash: string }[]) => rows.map(r => r.pubkeyHash)

describe('readPasskeyState', () => {
  it('finds the first key and the recovery key, which no event reports', async () => {
    const state = await readPasskeyState(client(BOOTSTRAP, 1_000_000), WALLET)
    expect(hashes(state.enrolled)).toEqual([BOOTSTRAP[HASH_0]])
    expect(state.pending).toEqual([])
    expect(state.ecdsaFallbackAddress).toBe(RECOVERY)
  })

  it('reports a key as pending during its timelock, with the real add time', async () => {
    const state = await readPasskeyState(client(TWO_ADDED, FIRST_ACTIVE_AT - 1), WALLET)
    expect(state.enrolled).toEqual([])
    expect(state.pending).toEqual([
      { pubkeyHash: HASH_A, pubkeyX: word(0x21), pubkeyY: word(0x22), proposedAt: ADDED_AT },
      { pubkeyHash: HASH_B, pubkeyX: word(0x31), pubkeyY: word(0x32), proposedAt: ADDED_AT + 7200 },
    ])
  })

  it('moves a key to enrolled at validFrom, as the contract does, with no event', async () => {
    const atFirst = await readPasskeyState(client(TWO_ADDED, FIRST_ACTIVE_AT), WALLET)
    expect(hashes(atFirst.enrolled)).toEqual([HASH_A])
    expect(hashes(atFirst.pending)).toEqual([HASH_B])

    const atSecond = await readPasskeyState(client(TWO_ADDED, SECOND_ACTIVE_AT), WALLET)
    expect(hashes(atSecond.enrolled)).toEqual([HASH_A, HASH_B])
    expect(atSecond.pending).toEqual([])
  })

  it('returns nothing for an account with empty storage', async () => {
    expect(await readPasskeyState(client({}, 1), WALLET)).toEqual({
      enrolled: [],
      pending: [],
      ecdsaFallbackAddress: undefined,
    })
  })

  it('rejects when a read fails, instead of reporting no passkeys', async () => {
    const failing: PasskeyStateClient = {
      getStorageAt: async () => { throw new Error('rpc down') },
      getBlock: async () => ({ timestamp: 1n }),
    }
    await expect(readPasskeyState(failing, WALLET)).rejects.toThrow('rpc down')
  })
})
