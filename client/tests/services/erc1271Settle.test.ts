import { expect } from 'chai'
import { makeError, TransactionResponse } from 'ethers'
import { waitForReceipt } from '../../src/utils/txWait'
import { settleFailedERC1271Row, isRetryableERC1271SubmitError } from '../../src/utils/erc1271Settle'
import { TxWaitTimeoutError } from '../../src/utils/txWait'

type Resolution = 'done' | 'failed' | 'awaiting_indexer'

// isCawonceUsed: true / false / 'throws'. resolveCawonceUsed's answer, and a
// counter so the tests can tell whether it was asked at all.
function run(opts: { used: boolean | 'throws'; resolution?: Resolution; retryable: boolean }) {
  let resolveCalls = 0
  const verdict = settleFailedERC1271Row({
    submitError: 'execution reverted: Batch sig invalid',
    retryable: opts.retryable,
    isCawonceUsed: async () => {
      if (opts.used === 'throws') throw new Error('missing response')
      return opts.used
    },
    resolveCawonceUsed: async () => {
      resolveCalls++
      return opts.resolution ?? 'failed'
    },
  })
  return verdict.then(v => ({ v, resolveCalls }))
}

describe('settleFailedERC1271Row', () => {
  describe('cawonce used on chain', () => {
    it('same action in the Action table → landed', async () => {
      const { v, resolveCalls } = await run({ used: true, resolution: 'done', retryable: true })
      expect(v).to.deep.equal({ kind: 'landed' })
      expect(resolveCalls).to.equal(1)
    })

    it('not indexed yet → awaiting_indexer, not pending (would be re-sent)', async () => {
      const { v } = await run({ used: true, resolution: 'awaiting_indexer', retryable: false })
      expect(v).to.deep.equal({ kind: 'awaiting_indexer' })
    })

    it('a different action holds the cawonce → failed with Cawonce already used', async () => {
      const { v } = await run({ used: true, resolution: 'failed', retryable: true })
      expect(v).to.deep.equal({ kind: 'failed', reason: 'Cawonce already used' })
    })

    it('settles the same way after a revert as after a timeout', async () => {
      // e.g. the tx landed before a restart, the re-send reverted with CawonceUsed
      const { v } = await run({ used: true, resolution: 'done', retryable: false })
      expect(v).to.deep.equal({ kind: 'landed' })
    })
  })

  describe('cawonce not used', () => {
    it('retryable (receipt timeout, RPC error after the send) → pending', async () => {
      const { v, resolveCalls } = await run({ used: false, retryable: true })
      expect(v).to.deep.equal({ kind: 'pending' })
      expect(resolveCalls).to.equal(0)
    })

    it('not retryable (a revert) → failed with the submit error, as before', async () => {
      const { v, resolveCalls } = await run({ used: false, retryable: false })
      expect(v).to.deep.equal({ kind: 'failed', reason: 'execution reverted: Batch sig invalid' })
      expect(resolveCalls).to.equal(0)
    })
  })

  describe('bitmap read fails', () => {
    it('retryable → pending', async () => {
      const { v, resolveCalls } = await run({ used: 'throws', retryable: true })
      expect(v).to.deep.equal({ kind: 'pending' })
      expect(resolveCalls).to.equal(0)
    })

    it('not retryable → failed with the submit error', async () => {
      const { v } = await run({ used: 'throws', retryable: false })
      expect(v).to.deep.equal({ kind: 'failed', reason: 'execution reverted: Batch sig invalid' })
    })
  })
})

describe('isRetryableERC1271SubmitError', () => {
  // Same shape as the validator's isTransientRpcError for these inputs.
  const isTransient = (err: any) => /missing response|timeout|econnreset/i.test(err?.message || '')
  const revert = makeError('transaction execution reverted', 'CALL_EXCEPTION', {
    action: 'sendTransaction', data: null, reason: null, invocation: null, revert: null,
    transaction: { to: null, from: undefined, data: '' }, receipt: null as any,
  })
  const serverError = makeError('server response 503 Service Unavailable', 'SERVER_ERROR')
  const replaced = makeError('transaction was replaced', 'TRANSACTION_REPLACED', {
    cancelled: true, reason: 'replaced', replacement: null as any, hash: '0x01', receipt: null as any,
  })
  const insufficientFunds = makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS', {
    transaction: {},
  })

  it('a receipt timeout is retryable, sent or not', () => {
    const err = new TxWaitTimeoutError('0x01', 60_000)
    expect(isRetryableERC1271SubmitError(err, true, () => false)).to.equal(true)
    expect(isRetryableERC1271SubmitError(err, false, () => false)).to.equal(true)
  })

  describe('after the send', () => {
    it('a revert (status 0 receipt) is not retryable', () => {
      expect(isRetryableERC1271SubmitError(revert, true, isTransient)).to.equal(false)
    })

    it('an RPC error from the receipt lookup is retryable, even one isTransientRpcError misses', () => {
      expect(isTransient(serverError)).to.equal(false)
      expect(isRetryableERC1271SubmitError(serverError, true, isTransient)).to.equal(true)
      expect(isRetryableERC1271SubmitError(new Error('missing response'), true, isTransient)).to.equal(true)
    })

    it('a replaced tx is retryable (the bitmap decides)', () => {
      expect(isRetryableERC1271SubmitError(replaced, true, isTransient)).to.equal(true)
    })
  })

  describe('before the send', () => {
    it('a transient RPC error is retryable', () => {
      expect(isRetryableERC1271SubmitError(new Error('read ECONNRESET'), false, isTransient)).to.equal(true)
    })

    it('a nonce held by another of our txs is retryable (the re-send while the first is in flight)', () => {
      const nonceExpired = makeError('nonce has already been used', 'NONCE_EXPIRED', { transaction: {} })
      const underpriced = makeError('replacement fee too low', 'REPLACEMENT_UNDERPRICED', { transaction: {} })
      expect(isRetryableERC1271SubmitError(nonceExpired, false, isTransient)).to.equal(true)
      expect(isRetryableERC1271SubmitError(underpriced, false, isTransient)).to.equal(true)
    })

    it('a persistent error is not (nothing times out a pending row)', () => {
      expect(isRetryableERC1271SubmitError(insufficientFunds, false, isTransient)).to.equal(false)
      expect(isRetryableERC1271SubmitError(serverError, false, isTransient)).to.equal(false)
    })
  })
})

// ethers' own TransactionResponse.wait() over a stub provider (no network):
// what the classifier sees after the send.
describe('isRetryableERC1271SubmitError with ethers tx.wait()', () => {
  const isTransient = (err: any) => /missing response|timeout|econnreset/i.test(err?.message || '')
  function sentTx(getTransactionReceipt: () => Promise<any>) {
    const provider: any = { getTransactionReceipt }
    return new TransactionResponse({
      hash: '0x' + '11'.repeat(32), from: '0x' + '22'.repeat(20), to: '0x' + '33'.repeat(20),
      nonce: 7, gasLimit: 200_000n, data: '0x', value: 0n, chainId: 84532n, type: 2,
      blockNumber: null, blockHash: null, index: 0, gasPrice: 0n, signature: null,
    } as any, provider)
  }
  async function errorOf(p: Promise<unknown>) {
    try { await p } catch (err) { return err }
    throw new Error('expected a rejection')
  }

  it('an RPC error from the first receipt lookup comes straight out of wait() → retryable', async () => {
    const tx = sentTx(async () => { throw makeError('server response 503 Service Unavailable', 'SERVER_ERROR') })
    const err: any = await errorOf(waitForReceipt(tx, 60_000))
    expect(err.code).to.equal('SERVER_ERROR')
    expect(isTransient(err)).to.equal(false)
    expect(isRetryableERC1271SubmitError(err, true, isTransient)).to.equal(true)
  })

  it('a status 0 receipt is CALL_EXCEPTION → not retryable', async () => {
    const tx = sentTx(async () => ({ status: 0, to: tx.to, from: tx.from, blockNumber: 10 }))
    const err: any = await errorOf(waitForReceipt(tx, 60_000))
    expect(err.code).to.equal('CALL_EXCEPTION')
    expect(isRetryableERC1271SubmitError(err, true, isTransient)).to.equal(false)
  })

  it('a status 1 receipt resolves', async () => {
    const tx = sentTx(async () => ({ status: 1, to: tx.to, from: tx.from, blockNumber: 10 }))
    const receipt: any = await waitForReceipt(tx, 60_000)
    expect(receipt.status).to.equal(1)
  })

  it('end to end: RPC error after the send, cawonce not used yet → pending, not failed', async () => {
    const tx = sentTx(async () => { throw makeError('server response 503 Service Unavailable', 'SERVER_ERROR') })
    const err: any = await errorOf(waitForReceipt(tx, 60_000))
    const v = await settleFailedERC1271Row({
      submitError: err.message,
      retryable: isRetryableERC1271SubmitError(err, true, isTransient),
      isCawonceUsed: async () => false,
      resolveCawonceUsed: async () => 'failed',
    })
    expect(v).to.deep.equal({ kind: 'pending' })
  })
})
