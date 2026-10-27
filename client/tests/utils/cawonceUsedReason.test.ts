import { expect } from 'chai'
import { sanitizeFailureReason, CAWONCE_USED_REASON } from '../../src/utils/sanitizeFailureReason'
import {
  isCawonceUsedReason,
  shouldRetryCawonceUsed,
  pickCawonceUsedRetries,
  type LandedVerdict,
} from '../../src/services/FrontEnd/src/utils/cawonceUsedReason'

// markTxQueueFailed stores sanitizeFailureReason(raw), not the raw validator
// phrase. The routes behind the FE's auto-retry (/api/txqueue/failed-cawonce,
// /api/me's failedRetries) and the FE's status poll have to recognise what is
// actually stored, or a "Cawonce already used" row is never retried.
describe('Cawonce already used: stored reason', () => {
  // Raw reasons the validator passes to markTxQueueFailed for this case:
  // its own literal, and the decoded CawonceUsed revert.
  const RAW = [
    'Cawonce already used',
    'CawonceUsed — Cawonce already used',
    'execution reverted: CawonceUsed — Cawonce already used',
  ]

  for (const raw of RAW) {
    it(`stores "${raw}" as CAWONCE_USED_REASON`, () => {
      expect(sanitizeFailureReason(raw)).to.equal(CAWONCE_USED_REASON)
    })

    it(`the FE recognises the stored reason of "${raw}"`, () => {
      expect(isCawonceUsedReason(sanitizeFailureReason(raw))).to.equal(true)
    })
  }

  it('the FE still recognises the raw phrase on rows stored before the sanitizer', () => {
    expect(isCawonceUsedReason('Cawonce already used')).to.equal(true)
  })

  it("the FE doesn't treat other failures as Cawonce already used", () => {
    for (const raw of [
      'Transaction already processed - duplicate cawonce',
      'Insufficient balance to complete this action.',
      'SessionInvalid — session key expired, unknown, or scope-mismatched',
      'execution reverted',
      '',
    ]) {
      expect(isCawonceUsedReason(sanitizeFailureReason(raw)), raw).to.equal(false)
      expect(isCawonceUsedReason(raw), raw).to.equal(false)
    }
    expect(isCawonceUsedReason(null)).to.equal(false)
    expect(isCawonceUsedReason(undefined)).to.equal(false)
  })
})

// A "Cawonce already used" row is usually an action a peer validator landed
// moments earlier, before its Action row was indexed here. check-landed then
// says 'unknown', and only later 'ours'. Retrying on 'unknown' posts it twice.
describe('Cawonce already used: which rows to retry', () => {
  it('retries only a collision', () => {
    expect(shouldRetryCawonceUsed('collision')).to.equal(true)
    expect(shouldRetryCawonceUsed('ours')).to.equal(false)
    expect(shouldRetryCawonceUsed('unknown')).to.equal(false)
  })

  const rows = [1, 2, 3, 4, 5].map(id => ({ id }))

  function checker(verdicts: Record<number, LandedVerdict>) {
    const asked: number[] = []
    const check = async (id: number) => {
      asked.push(id)
      return verdicts[id]
    }
    return { asked, check }
  }

  it('sorts rows into retry and landed, leaving unknown ones for later', async () => {
    const { check } = checker({ 1: 'ours', 2: 'unknown', 3: 'collision', 4: 'ours', 5: 'collision' })
    const { retry, landed } = await pickCawonceUsedRetries(rows, check, 3)
    expect(retry.map(r => r.id)).to.deep.equal([3, 5])
    expect(landed.map(r => r.id)).to.deep.equal([1, 4])
  })

  it('retries none of rows that all landed', async () => {
    const { check } = checker({ 1: 'ours', 2: 'ours', 3: 'ours', 4: 'ours', 5: 'ours' })
    const { retry, landed } = await pickCawonceUsedRetries(rows, check, 3)
    expect(retry).to.deep.equal([])
    expect(landed).to.have.length(5)
  })

  it("doesn't let landed rows use up the cap", async () => {
    const { check } = checker({ 1: 'ours', 2: 'ours', 3: 'ours', 4: 'collision', 5: 'collision' })
    const { retry } = await pickCawonceUsedRetries(rows, check, 1)
    expect(retry.map(r => r.id)).to.deep.equal([4])
  })

  it('stops asking once the cap is reached', async () => {
    const { asked, check } = checker({ 1: 'collision', 2: 'collision', 3: 'collision', 4: 'collision', 5: 'collision' })
    const { retry } = await pickCawonceUsedRetries(rows, check, 2)
    expect(retry.map(r => r.id)).to.deep.equal([1, 2])
    expect(asked).to.deep.equal([1, 2])
  })
})
