/**
 * sponsorBootstrap's sentTxHash: whether a failed bootstrap may still have
 * minted.
 *
 * The route frees what the mint consumes (the X-signup reservation) when the
 * bootstrap fails. That is only safe when the mint did not happen: a failure
 * before the broadcast, or a mined revert. After the broadcast, a broadcast
 * call or a receipt wait that throws leaves the outcome unknown, and the
 * result must carry the tx hash so the route keeps the reservation.
 *
 * The provider mock answers every read sponsorBootstrap makes on the way to
 * the broadcast (the shared mock in SponsorService.test.ts stops at lzQuote),
 * and lets each test choose how the broadcast and the receipt wait end.
 */

import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { Wallet, Interface, Transaction, hashAuthorization, toBeHex } from 'ethers'
import { SponsorService, isSponsorError, type BootstrapParams } from '../../../src/services/SponsorService'
import { cawProfileMinterAbi, cawProfileAbi, cawNetworkManagerAbi } from '../../../src/abi/generated'

const SPONSOR_PRIVATE_KEY = '0x' + '1'.repeat(64)
const userWallet = new Wallet('0x' + '2'.repeat(64))
const MINTER = '0x' + 'a'.repeat(40)
const PROFILE = '0x' + 'b'.repeat(40)
const SMART_EOA = '0x' + 'c'.repeat(40)
const NETWORK_MANAGER = '0x' + 'd'.repeat(40)
const CHAIN_ID = 11155111

const minterIface = new Interface(cawProfileMinterAbi as any)
const profileIface = new Interface(cawProfileAbi as any)
const nmIface = new Interface(cawNetworkManagerAbi as any)

type Ending =
  | { kind: 'ok' }
  | { kind: 'broadcastThrows' }
  | { kind: 'waitThrows' }
  | { kind: 'waitReverts' }
  | { kind: 'lzQuoteThrows' }

function answerCall(data: string, ending: Ending): string {
  const selector = data.slice(0, 10)
  const isFn = (iface: Interface, name: string) => iface.getFunction(name)!.selector === selector
  if (isFn(minterIface, 'idByUsername')) return minterIface.encodeFunctionResult('idByUsername', [0])
  if (isFn(profileIface, 'lzQuote')) {
    if (ending.kind === 'lzQuoteThrows') throw new Error('lzQuote failed')
    return profileIface.encodeFunctionResult('lzQuote', [[1_000_000_000_000n, 0n]])
  }
  if (isFn(profileIface, 'networkManager')) return profileIface.encodeFunctionResult('networkManager', [NETWORK_MANAGER])
  for (const name of ['getMintFeeAndAddress', 'getDepositFeeAndAddress', 'getAuthFeeAndAddress']) {
    if (isFn(nmIface, name)) return nmIface.encodeFunctionResult(name, [1n, NETWORK_MANAGER])
  }
  throw new Error(`unexpected eth_call ${selector}`)
}

function buildService(ending: Ending): { svc: SponsorService; broadcast: string[] } {
  const broadcast: string[] = []
  const provider: any = {
    async getNetwork() { return { chainId: BigInt(CHAIN_ID), name: 'test' } },
    async getBalance() { return 10n ** 18n },
    async getTransactionCount() { return 0 },
    async getFeeData() {
      return { gasPrice: 10_000_000_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_500_000_000n }
    },
    async call(tx: any) { return answerCall(tx.data, ending) },
    async estimateGas() { return 200_000n },
    async send(method: string) { return method === 'eth_chainId' ? toBeHex(CHAIN_ID) : '0x' },
    async broadcastTransaction(signedTx: string) {
      broadcast.push(signedTx)
      if (ending.kind === 'broadcastThrows') throw new Error('socket hang up')
      const hash = Transaction.from(signedTx).hash!
      return {
        hash,
        async wait() {
          if (ending.kind === 'waitThrows') {
            const err: any = new Error('could not coalesce error')
            err.code = 'UNKNOWN_ERROR'
            throw err
          }
          if (ending.kind === 'waitReverts') {
            // What ethers' TransactionResponse.wait() throws for a status-0 receipt.
            const err: any = new Error('transaction execution reverted')
            err.code = 'CALL_EXCEPTION'
            err.receipt = { status: 0, hash, logs: [] }
            throw err
          }
          return { status: 1, hash, logs: [] }
        },
      }
    },
    on: () => {},
    off: () => {},
    removeAllListeners: () => {},
    destroy: () => {},
  }
  const svc = new SponsorService({
    l1ProviderUrl: 'http://localhost:8545',
    l1ChainId: CHAIN_ID,
    sponsorPrivateKey: SPONSOR_PRIVATE_KEY,
    minterAddress: MINTER,
    cawProfileAddress: PROFILE,
    smartEoaAddress: SMART_EOA,
    minDepositCAW: 1n,
  })
  ;(svc as any).provider = provider
  ;(svc as any).wallet = new Wallet(SPONSOR_PRIVATE_KEY, provider)
  ;(svc as any).resolvedChainId = CHAIN_ID
  return { svc, broadcast }
}

describe('sponsorBootstrap sentTxHash', () => {
  let params: BootstrapParams

  before(() => {
    const sig = userWallet.signingKey.sign(hashAuthorization({ address: SMART_EOA, nonce: 0n, chainId: BigInt(CHAIN_ID) }))
    params = {
      passkeyPubkeyX: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
      passkeyPubkeyY: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
      ecdsaFallbackAddr: userWallet.address as `0x${string}`,
      username: 'testuser',
      depositAmountCAW: 10n ** 18n,
      networkId: 1,
      lzDestId: 40245,
      lzTokenAmount: 0n,
      authTupleSignature: { yParity: sig.yParity, r: sig.r as `0x${string}`, s: sig.s as `0x${string}` },
      authTupleNonce: 0n,
      permitSig: ('0x' + 'ff'.repeat(65)) as `0x${string}`,
      permitNonce: 0n,
    }
  })

  it('a bootstrap that lands returns the tx hash and no error', async () => {
    const { svc, broadcast } = buildService({ kind: 'ok' })
    const result = await svc.sponsorBootstrap(params)
    expect(isSponsorError(result), JSON.stringify(result)).to.equal(false)
    expect(broadcast).to.have.length(1)
    if (!isSponsorError(result)) expect(result.txHash).to.equal(Transaction.from(broadcast[0]).hash)
  })

  it('a broadcast that throws carries the hash of the tx it sent', async () => {
    const { svc, broadcast } = buildService({ kind: 'broadcastThrows' })
    const result = await svc.sponsorBootstrap(params)
    expect(isSponsorError(result)).to.equal(true)
    expect(broadcast).to.have.length(1)
    if (isSponsorError(result)) expect(result.sentTxHash).to.equal(Transaction.from(broadcast[0]).hash)
  })

  it('a receipt wait that throws carries the tx hash', async () => {
    const { svc, broadcast } = buildService({ kind: 'waitThrows' })
    const result = await svc.sponsorBootstrap(params)
    expect(isSponsorError(result)).to.equal(true)
    if (isSponsorError(result)) expect(result.sentTxHash).to.equal(Transaction.from(broadcast[0]).hash)
  })

  it('a mined revert carries no tx hash: nothing was minted', async () => {
    const { svc, broadcast } = buildService({ kind: 'waitReverts' })
    const result = await svc.sponsorBootstrap(params)
    expect(broadcast).to.have.length(1)
    expect(isSponsorError(result)).to.equal(true)
    if (isSponsorError(result)) expect(result.sentTxHash).to.equal(undefined)
  })

  it('a failure before the broadcast carries no tx hash', async () => {
    const { svc, broadcast } = buildService({ kind: 'lzQuoteThrows' })
    const result = await svc.sponsorBootstrap(params)
    expect(broadcast).to.have.length(0)
    expect(isSponsorError(result)).to.equal(true)
    if (isSponsorError(result)) {
      expect(result.error).to.equal('LZ_QUOTE_FAILED')
      expect(result.sentTxHash).to.equal(undefined)
    }
  })
})
