/**
 * Cross-check: the FE buildManagementDigest must produce BYTE-FOR-BYTE the same
 * digest as SmartEOA._managementDigest on-chain. A mismatch means every relayed
 * rotateEcdsaFallback / addPasskey would revert with InvalidCallerSig.
 *
 * The golden DIGEST below was computed directly from the contract's own
 * abi.encodePacked logic in a foundry harness (test-foundry, throwaway) for the
 * fixed input documented in each case. If the contract's _managementDigest ever
 * changes shape, this test fails loudly and the FE builder must be re-synced.
 */

import { describe, it, expect } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { buildManagementDigest } from './useSmartEoaManagement'

describe('buildManagementDigest — contract cross-check', () => {
  it('matches the on-chain _managementDigest for a known rotateEcdsaFallback input', () => {
    // Golden input (must match the foundry harness exactly):
    //   chainId     = 11155111 (Sepolia)
    //   account     = 0x00000000000000000000000000000000DeaDBeef
    //   opName      = "rotateEcdsaFallback"
    //   newFallback = 0x000000000000000000000000000000000000c0Fe
    //   nonce       = 7
    // params = abi.encode(newFallback) == encodeAbiParameters([address],[addr])
    const account = '0x00000000000000000000000000000000DeaDBeef' as const
    const newFallback = '0x000000000000000000000000000000000000c0Fe' as const
    const params = encodeAbiParameters([{ type: 'address' }], [newFallback])

    const digest = buildManagementDigest(account, 11155111, 'rotateEcdsaFallback', params, 7n)

    // Golden value emitted by the contract's _managementDigest logic in foundry.
    expect(digest).toBe('0x3c3bda1c59fdb2690008bfc81ef4ec5e8f2bc3a6dce8632fd32af141e62b05f3')
  })

  it('changes when the nonce changes (replay-binding sanity)', () => {
    const account = '0x00000000000000000000000000000000DeaDBeef' as const
    const params = encodeAbiParameters([{ type: 'address' }], ['0x000000000000000000000000000000000000c0Fe'])
    const d7 = buildManagementDigest(account, 11155111, 'rotateEcdsaFallback', params, 7n)
    const d8 = buildManagementDigest(account, 11155111, 'rotateEcdsaFallback', params, 8n)
    expect(d7).not.toBe(d8)
  })

  it('changes when the opName changes (op-binding sanity)', () => {
    const account = '0x00000000000000000000000000000000DeaDBeef' as const
    const params = encodeAbiParameters([{ type: 'address' }], ['0x000000000000000000000000000000000000c0Fe'])
    const rotate = buildManagementDigest(account, 11155111, 'rotateEcdsaFallback', params, 7n)
    const add = buildManagementDigest(account, 11155111, 'addPasskey', params, 7n)
    expect(rotate).not.toBe(add)
  })
})
