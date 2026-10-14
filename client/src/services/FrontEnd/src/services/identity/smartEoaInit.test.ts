/**
 * smartEoaInit.test.ts
 *
 * Pins the FE's viem copy of SmartEOA's initialize digest to the same vectors
 * as the sponsor server (client/tests/services/SponsorService/SponsorService.test.ts,
 * smartEoaInitDigest) and the contract itself
 * (solidity/test-foundry/SmartEOAInitialize.t.sol, test_clientVectors_*).
 */
import { describe, it, expect } from 'vitest'
import { recoverAddress, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { smartEoaInitDigest, signSmartEoaInit, standaloneInitArgs } from './smartEoaInit'

const KEY = new Uint8Array(32).fill(0x22)
const KEY_HEX = `0x${'22'.repeat(32)}` as const
const ACCOUNT = privateKeyToAccount(KEY_HEX).address

const base = {
  account: ACCOUNT,
  pubkeyX: `0x${'aa'.repeat(32)}` as `0x${string}`,
  pubkeyY: `0x${'bb'.repeat(32)}` as `0x${string}`,
  ecdsaFallback: ACCOUNT,
}

describe('smartEoaInitDigest', () => {
  it('standalone L2 vector', () => {
    expect(ACCOUNT).toBe('0x1563915e194D8CfBA1943570603F7606A3115508')
    expect(smartEoaInitDigest(standaloneInitArgs({ ...base, chainId: 84532 })))
      .toBe('0x8080ee3c40d30fd736595d2e6ef66fcc83a055c72108abba5a7b11c904f60d47')
    expect(standaloneInitArgs({ ...base, chainId: 84532 }).minterContract).toBe(zeroAddress)
  })

  it('bootstrap vector (Minter + calldata bound)', () => {
    expect(smartEoaInitDigest({
      ...base,
      chainId: 11155111,
      minterContract: `0x${'00'.repeat(18)}aaaa`,
      mintCalldata: '0xa0712d680000000000000000000000000000000000000000000000000000000000000007',
    })).toBe('0xb45c2e9ab761a654bdfdc63c3c254091078b35f9a17cf69ec1c400a6eca37298')
  })
})

describe('signSmartEoaInit', () => {
  it('returns a 65-byte r || s || v sig (v = 27/28) that recovers to the EOA', async () => {
    const args = standaloneInitArgs({ ...base, chainId: 84532 })
    const sig = await signSmartEoaInit(KEY, args)
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    expect(['1b', '1c']).toContain(sig.slice(-2))
    expect(await recoverAddress({ hash: smartEoaInitDigest(args), signature: sig })).toBe(ACCOUNT)
  })

  it('rejects a key that is not 32 bytes', async () => {
    await expect(signSmartEoaInit(new Uint8Array(31), standaloneInitArgs({ ...base, chainId: 1 })))
      .rejects.toThrow('32 bytes')
  })
})
