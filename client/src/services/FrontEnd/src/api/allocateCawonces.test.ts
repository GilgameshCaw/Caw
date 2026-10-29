import { describe, it, expect, vi, beforeEach } from 'vitest'

// Chain state for one token: the cawonces already used on chain. getTokens
// answers nextCawonce as CawActions does (the first unset slot), and
// isCawonceUsed answers from the same set.
let used = new Set<number>()

vi.mock('@wagmi/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wagmi/core')>()),
  readContract: vi.fn(async (_config: unknown, req: { functionName: string; args: unknown[] }) => {
    if (req.functionName === 'getTokens') {
      let next = 0
      while (used.has(next)) next++
      return [{ nextCawonce: BigInt(next) }]
    }
    if (req.functionName === 'isCawonceUsed') return used.has(Number(req.args[1]))
    throw new Error(`unexpected readContract ${req.functionName}`)
  }),
}))
vi.mock('~/config/Web3Provider', () => ({ wagmiConfig: {} }))
vi.mock('~/config/wagmiConfig', () => ({ wagmiConfig: {}, sepolia: { id: 11155111 }, baseSepolia: { id: 84532 } }))

const usedUpTo = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('allocateCawonces', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('returns the next free range', async () => {
    used = new Set(usedUpTo(12))
    const { allocateCawonces } = await import('./actions')
    expect(await allocateCawonces(1, 3)).toEqual([12, 13, 14])
  })

  it('returns a contiguous range when a used slot follows a hole', async () => {
    // 12 never landed and 13 did: nextCawonce is 12, and a 3-action batch
    // signature needs three contiguous free slots.
    used = new Set([...usedUpTo(12), 13])
    const { allocateCawonces } = await import('./actions')
    expect(await allocateCawonces(1, 3)).toEqual([14, 15, 16])
  })

  it('still uses the hole when it is long enough', async () => {
    used = new Set([...usedUpTo(12), 15])
    const { allocateCawonces } = await import('./actions')
    expect(await allocateCawonces(1, 3)).toEqual([12, 13, 14])
  })
})
