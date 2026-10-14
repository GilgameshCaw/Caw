/**
 * bootstrap.initSig.test.ts
 *
 * bootstrapNewUser must hand the sponsor server an initSig that SmartEOA will
 * accept: the user's EOA key over SmartEOA's initialize digest, with the exact
 * mintCalldata the server rebuilds from the same params (and, for L2, the
 * standalone enroll-only call).
 */
import { describe, it, expect, vi } from 'vitest'
import { encodeFunctionData, recoverAddress } from 'viem'
import { bootstrapNewUser, type BootstrapParams } from './bootstrap'
import { smartEoaInitDigest, standaloneInitArgs } from './smartEoaInit'
import { cawProfileMinterAbi } from '~/../../../abi/generated'

const MINTER = '0x00000000000000000000000000000000000000aa' as const
const SMART_EOA = '0x1234567890123456789012345678901234567890' as const
const L1_CHAIN_ID = 11155111
const L2_CHAIN_ID = 84532
const PK_X = `0x${'01'.repeat(32)}` as const
const PK_Y = `0x${'02'.repeat(32)}` as const

describe('bootstrapNewUser initSig', () => {
  it('L1 initSig recovers to the delegated EOA over the server-shaped mintCalldata; L2 initSig over the standalone call', async () => {
    let submitted: BootstrapParams | undefined
    const sponsorApi = {
      sponsorBootstrap: vi.fn().mockImplementation(async (p: BootstrapParams) => {
        submitted = p
        return { txHash: '0xdeadbeef' }
      }),
    }
    const passkeySigner = vi.fn().mockResolvedValue({
      permitSig: `0x${'aa'.repeat(112)}` as `0x${string}`,
      clientDataJSON: '{}',
      authenticatorData: `0x${'bb'.repeat(37)}` as `0x${string}`,
    })
    const rpcProvider = {
      getChainId: vi.fn().mockResolvedValue(L1_CHAIN_ID),
      getTransactionCount: vi.fn().mockResolvedValue(0),
    }

    const depositAmountCAW = 2_000_000n * 10n ** 18n
    const result = await bootstrapNewUser({
      vaultPassword: 'test-vault-password-strong!',
      username: 'alice',
      depositAmountCAW,
      networkId: 1,
      lzDestId: 40245,
      passkeyPubkeyX: PK_X,
      passkeyPubkeyY: PK_Y,
      smartEoaAddress: SMART_EOA,
      rpcProvider,
      passkeySigner,
      sponsorApi,
      minterAddress: MINTER,
      permitNonce: 0n,
      lzTokenAmount: 0n,
      l2ChainId: L2_CHAIN_ID,
      kycLevel: 0,
      sponsorTokenId: 3,
      repayAmount: 5n,
    })

    expect(submitted).toBeDefined()
    const eoa = result.ecdsaAddress
    const p = submitted!

    // What SponsorService.sponsorBootstrap encodes (recipient = recovered EOA).
    const mintCalldata = encodeFunctionData({
      abi: cawProfileMinterAbi,
      functionName: 'mintAndDepositSponsored',
      args: [1, eoa, 'alice', depositAmountCAW, 40245, 0n, 0n, p.permitSig, 0, 3, 5n],
    })
    const l1Digest = smartEoaInitDigest({
      chainId: L1_CHAIN_ID,
      account: eoa,
      pubkeyX: PK_X,
      pubkeyY: PK_Y,
      ecdsaFallback: p.ecdsaFallbackAddr,
      minterContract: MINTER,
      mintCalldata,
    })
    expect(p.initSig).toMatch(/^0x[0-9a-f]{130}$/)
    expect(await recoverAddress({ hash: l1Digest, signature: p.initSig })).toBe(eoa)

    const l2 = result.l2Delegation!
    expect(l2).toBeDefined()
    const l2Digest = smartEoaInitDigest(standaloneInitArgs({
      chainId: L2_CHAIN_ID,
      account: eoa,
      pubkeyX: PK_X,
      pubkeyY: PK_Y,
      ecdsaFallback: l2.ecdsaFallbackAddr,
    }))
    expect(await recoverAddress({ hash: l2Digest, signature: l2.initSig })).toBe(eoa)

    // A different chain or a different passkey does not recover to the EOA.
    const otherChain = smartEoaInitDigest(standaloneInitArgs({
      chainId: L1_CHAIN_ID, account: eoa, pubkeyX: PK_X, pubkeyY: PK_Y, ecdsaFallback: l2.ecdsaFallbackAddr,
    }))
    expect(await recoverAddress({ hash: otherChain, signature: l2.initSig })).not.toBe(eoa)
  })
})
