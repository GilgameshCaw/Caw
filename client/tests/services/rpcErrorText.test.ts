import { expect } from 'chai'
import { JsonRpcProvider, Interface, FetchRequest, FetchResponse, hexlify } from 'ethers'
import { rpcErrorText, revertReasonText } from '../../src/utils/rpcErrorText'
import { packActions, packGroupedSignatures } from '../../src/utils/packActions'

const iface = new Interface([
  'function safeProcessActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable returns (uint256 successCount, bytes[] rejections)',
])
const provider = new JsonRpcProvider('http://127.0.0.1:1', 1, { staticNetwork: true })

// A 20-row batch's calldata, as simulateActions sends it. Every r and s
// holds the digits 429.
const calldata = (() => {
  const actions = Array.from({ length: 20 }, (_, i) => ({
    actionType: 1, senderId: 100 + i, receiverId: 7, receiverCawonce: 3, networkId: 1, cawonce: i,
    recipients: [], amounts: [], text: '0x',
  }))
  const word = '0x' + 'ab429cd0'.repeat(8)
  const groups = actions.map(() => ({ groupSize: 1, v: 27, r: word, s: word }))
  return iface.encodeFunctionData('safeProcessActions', [
    1, hexlify(packActions(actions)), hexlify(packGroupedSignatures(groups)), 0n, 0n,
  ])
})()
const from = '0x4290000000000000000000000000000000000001'

// An eth_call failure, the way JsonRpcProvider throws it for this node error.
function ethCallError(error: { code: number; message: string; data?: string }) {
  return provider.getRpcError(
    { method: 'eth_call', params: [{ from, to: '0x' + '2'.repeat(40), data: calldata }, 'latest'], id: 1, jsonrpc: '2.0' },
    { id: 1, error } as any,
  ) as any
}

describe('rpcErrorText', () => {
  it('leaves out the transaction of a failed eth_call', () => {
    const err = ethCallError({ code: -32000, message: 'execution reverted' })
    expect(err.code).to.equal('CALL_EXCEPTION')
    expect(err.message).to.include(calldata).and.to.include('429')
    expect(rpcErrorText(err)).to.equal('missing revert data (execution reverted)')
  })

  it("keeps the node's message, which ethers leaves out of err.message", () => {
    for (const error of [
      { code: -32005, message: 'rate limit exceeded' },
      { code: 4444, message: 'rate limit exceeded' },
      { code: -32603, message: 'header not found' },
    ]) {
      const err = ethCallError(error)
      expect(err.message, error.message).to.not.include(error.message)
      expect(rpcErrorText(err), error.message).to.equal(`missing revert data (${error.message})`)
    }
  })

  it('keeps a revert reason', () => {
    const data = new Interface(['function Error(string)']).encodeFunctionData('Error', ['boom'])
    const err = ethCallError({ code: 3, message: 'execution reverted: boom', data })
    expect(rpcErrorText(err)).to.match(/^execution reverted: "boom"/)
    expect(rpcErrorText(err)).to.not.include(calldata.slice(2, 74))
  })

  it('keeps an HTTP 429', () => {
    const req = new FetchRequest('http://127.0.0.1:1/')
    let err: any
    try { new FetchResponse(429, 'Too Many Requests', {}, null, req).assertOk() } catch (e) { err = e }
    expect(err?.code).to.equal('SERVER_ERROR')
    expect(rpcErrorText(err)).to.include('429')
  })

  it('uses the whole message of other errors', () => {
    expect(rpcErrorText(new Error('RPC call timeout after 30 seconds'))).to.equal('RPC call timeout after 30 seconds')
    expect(rpcErrorText(undefined)).to.equal('')
    expect(rpcErrorText({})).to.equal('')
  })
})

describe('revertReasonText', () => {
  // The last block destroys the provider; the blocks above use it, too.
  after(() => provider.destroy())

  it('adds the selector of a custom error, without its arguments', () => {
    const data = '0xdeadbeef' + 'ab429cd0'.repeat(8)
    const err = ethCallError({ code: 3, message: 'execution reverted', data })
    expect(err.message).to.include(data)
    expect(revertReasonText(err, null)).to.equal('execution reverted (unknown custom error) (0xdeadbeef)')
  })

  it("uses the caller's name for the error", () => {
    const err = ethCallError({ code: 3, message: 'execution reverted', data: '0x734a00c1' })
    expect(revertReasonText(err, 'NoWithdrawFee')).to.equal('NoWithdrawFee')
  })

  it('adds nothing without revert data', () => {
    const err = ethCallError({ code: -32000, message: 'execution reverted' })
    expect(revertReasonText(err, null)).to.equal('missing revert data (execution reverted)')
  })
})
