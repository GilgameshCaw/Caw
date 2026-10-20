// buildActionBatchMessage: DataCleaner's waiting_for_session promotion has to
// recover the signer of batch-sig rows, which store one action's data per
// row but share one ActionBatch signature over the whole group.

import { expect } from 'chai'
import { ethers } from 'ethers'
import { buildActionBatchMessage } from '../../../src/utils/actionBatchMessage'
import { packActions, getPackedActionSlices } from '../../../src/utils/packActions'

const domain = {
  name: 'CawActions',
  version: '1',
  chainId: 84532,
  verifyingContract: '0x73246104f57001EDC6d0659Fa37Afb672a76E763',
}
const ActionBatch = [
  { name: 'senderId', type: 'uint32' },
  { name: 'firstCawonce', type: 'uint32' },
  { name: 'actionCount', type: 'uint32' },
  { name: 'actionsHash', type: 'bytes32' },
]

// Per-row payload.data as /api/actions/batch stores it: a three-chunk thread,
// first chunk carrying an embedded tip, the rest session-signed with no amounts.
const rows = [
  { actionType: 0, senderId: 37, receiverId: 0, receiverCawonce: 0, networkId: 1, cawonce: 12, recipients: [5], amounts: ['1000000000000000000000'], text: '0x6869' },
  { actionType: 0, senderId: 37, receiverId: 37, receiverCawonce: 12, networkId: 1, cawonce: 13, recipients: [], amounts: [], text: '0x7468657265' },
  { actionType: 0, senderId: 37, receiverId: 37, receiverCawonce: 12, networkId: 1, cawonce: 14, text: '0x21' },
]

// Sign the way the FE's signAndSubmitMany does (keccak256(concat(hashes))),
// written out independently of the helper under test.
async function signBatchLikeFrontEnd(wallet: ethers.HDNodeWallet | ethers.Wallet, data: any[]) {
  const packed = packActions(data.map(d => ({
    actionType: Number(d.actionType),
    senderId: Number(d.senderId),
    receiverId: Number(d.receiverId || 0),
    receiverCawonce: Number(d.receiverCawonce || 0),
    networkId: Number(d.networkId),
    cawonce: Number(d.cawonce),
    recipients: (d.recipients || []).map(Number),
    amounts: (d.amounts || []).map((x: any) => BigInt(x)),
    text: d.text || '0x',
  })))
  const hashes = getPackedActionSlices(packed).map(s => ethers.keccak256(s))
  const message = {
    senderId: Number(data[0].senderId),
    firstCawonce: Number(data[0].cawonce),
    actionCount: data.length,
    actionsHash: ethers.keccak256(ethers.concat(hashes)),
  }
  return wallet.signTypedData(domain, { ActionBatch }, message)
}

describe('buildActionBatchMessage', () => {
  const wallet = ethers.Wallet.createRandom()

  it('recovers the session signer from the per-row data of the group', async () => {
    const sig = await signBatchLikeFrontEnd(wallet, rows)
    const recovered = ethers.verifyTypedData(domain, { ActionBatch }, buildActionBatchMessage(rows), sig)
    expect(recovered.toLowerCase()).to.equal(wallet.address.toLowerCase())
  })

  it('the previous call shape (one row\'s data against ActionBatch) throws', async () => {
    const sig = await signBatchLikeFrontEnd(wallet, rows)
    expect(() => ethers.verifyTypedData(domain, { ActionBatch }, rows[0], sig)).to.throw()
  })

  it('depends on row order: a reordered group recovers a different address', async () => {
    const sig = await signBatchLikeFrontEnd(wallet, rows)
    const reordered = [rows[1], rows[0], rows[2]]
    const recovered = ethers.verifyTypedData(domain, { ActionBatch }, buildActionBatchMessage(reordered), sig)
    expect(recovered.toLowerCase()).to.not.equal(wallet.address.toLowerCase())
  })

  it('a missing row recovers a different address', async () => {
    const sig = await signBatchLikeFrontEnd(wallet, rows)
    const recovered = ethers.verifyTypedData(domain, { ActionBatch }, buildActionBatchMessage(rows.slice(0, 2)), sig)
    expect(recovered.toLowerCase()).to.not.equal(wallet.address.toLowerCase())
  })

  it('rejects an empty group', () => {
    expect(() => buildActionBatchMessage([])).to.throw('Empty action batch')
  })
})
