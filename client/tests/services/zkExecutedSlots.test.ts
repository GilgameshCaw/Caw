import { expect } from 'chai'
import { Interface } from 'ethers'
import { cawActionsAbi } from '../../src/abi/generated'
import {
  ACTIONS_PROCESSED_ZK_IFACE,
  ACTIONS_PROCESSED_ZK_TOPIC,
  zkExecutedBitmap,
  slotExecuted,
  executedSlotCount,
} from '../../src/utils/zkExecutedSlots'

// processActionsWithZkSigs reports the slots it ran in ActionsProcessedZk's
// actionsExecutedBitmap and skips the rest. The indexer, the validator's
// calldata backstop and the checkpoint reconstruction use these helpers to
// leave skipped slots out.
describe('zkExecutedSlots', () => {
  const contract = new Interface(cawActionsAbi as any)

  function zkLog(bitmap: bigint, actionCount = 4) {
    return ACTIONS_PROCESSED_ZK_IFACE.encodeEventLog('ActionsProcessedZk', [
      7, 3, actionCount, bitmap, '0x' + '11'.repeat(32),
    ])
  }

  it('uses the same topic as the deployed contract ABI', () => {
    expect(ACTIONS_PROCESSED_ZK_TOPIC).to.equal(contract.getEvent('ActionsProcessedZk')!.topicHash)
  })

  it('returns null for an ActionsProcessed log', () => {
    const log = contract.encodeEventLog('ActionsProcessed', [7, 3, 4, '0x' + '22'.repeat(32)])
    expect(zkExecutedBitmap(log)).to.equal(null)
    for (let i = 0; i < 4; i++) expect(slotExecuted(null, i)).to.equal(true)
  })

  it('reads the bitmap from an ActionsProcessedZk log', () => {
    // Slots 0 and 2 ran, 1 and 3 were skipped.
    const bitmap = zkExecutedBitmap(zkLog(0b0101n))
    expect(bitmap).to.equal(0b0101n)
    expect([0, 1, 2, 3].map(i => slotExecuted(bitmap, i))).to.deep.equal([true, false, true, false])
  })

  it('matches an upper-case topic from the RPC', () => {
    const log = zkLog(1n)
    const upper = { topics: [log.topics[0].toUpperCase().replace('0X', '0x'), ...log.topics.slice(1)], data: log.data }
    expect(zkExecutedBitmap(upper)).to.equal(1n)
  })

  it('handles slot 255 of a full 256-action batch', () => {
    const bitmap = zkExecutedBitmap(zkLog(1n << 255n, 256))
    expect(slotExecuted(bitmap, 255)).to.equal(true)
    expect(slotExecuted(bitmap, 254)).to.equal(false)
  })

  it('treats a zero bitmap as nothing ran', () => {
    const bitmap = zkExecutedBitmap(zkLog(0n))
    expect(bitmap).to.equal(0n)
    expect(slotExecuted(bitmap, 0)).to.equal(false)
  })

  it('throws on a ZK log whose data does not decode', () => {
    const log = zkLog(1n)
    expect(() => zkExecutedBitmap({ topics: log.topics, data: '0x1234' })).to.throw()
  })

  it('counts every slot of a non-ZK batch, and only the executed slots of a ZK batch', () => {
    expect(executedSlotCount(null, 24)).to.equal(24)
    expect(executedSlotCount(0b0101n, 4)).to.equal(2)
    expect(executedSlotCount(0n, 4)).to.equal(0)
    expect(executedSlotCount((1n << 256n) - 1n, 256)).to.equal(256)
  })
})
