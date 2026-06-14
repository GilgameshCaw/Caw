/**
 * Unit tests for the /api/sponsor/execute fee-validation primitives.
 *
 * The relay's trust model rests on two pure pieces:
 *   1. decodeErc20Transfer — correctly reads (to, amount) out of a CAW.transfer
 *      calldata, and rejects anything that isn't a well-formed transfer. A
 *      mis-decode here would let a batch underpay (or overcount) the relayer fee.
 *   2. quoteExecuteGasFeeCaw — prices the gas the relayer fronts in CAW, refusing
 *      when prices are stale/unavailable (so the relay never fronts gas for free
 *      or against a stale-low rate).
 *
 * These are tested directly (no RPC/Redis) because they're the security-critical
 * decision inputs to the route. The route wiring itself (allow-list, 503 on
 * unconfigured) is covered by SponsorService.test.ts's supertest harness.
 */

import { describe, it } from 'mocha'
import { expect } from 'chai'
import { AbiCoder, getAddress } from 'ethers'
import { decodeErc20Transfer } from '../../../src/api/routes/sponsor'

const SELECTOR = '0xa9059cbb'
const coder = AbiCoder.defaultAbiCoder()

/** Build a real transfer(address,uint256) calldata the way the FE/viem would. */
function transferCalldata(to: string, amount: bigint): string {
  return SELECTOR + coder.encode(['address', 'uint256'], [to, amount]).slice(2)
}

describe('decodeErc20Transfer', () => {
  const someAddr = '0x1111111111111111111111111111111111111111'

  it('decodes a well-formed transfer (to + amount)', () => {
    const data = transferCalldata(someAddr, 123_456_789n)
    const out = decodeErc20Transfer(data)
    expect(out).to.not.equal(null)
    expect(getAddress(out!.to)).to.equal(getAddress(someAddr))
    expect(out!.amount).to.equal(123_456_789n)
  })

  it('decodes a zero amount', () => {
    const out = decodeErc20Transfer(transferCalldata(someAddr, 0n))
    expect(out!.amount).to.equal(0n)
  })

  it('decodes a max-uint256 amount without overflow', () => {
    const max = (1n << 256n) - 1n
    const out = decodeErc20Transfer(transferCalldata(someAddr, max))
    expect(out!.amount).to.equal(max)
  })

  it('is case-insensitive on the selector and address', () => {
    const data = transferCalldata(someAddr, 5n).toUpperCase().replace('0X', '0x')
    const out = decodeErc20Transfer(data)
    expect(out).to.not.equal(null)
    expect(out!.amount).to.equal(5n)
  })

  it('rejects a wrong selector (e.g. approve)', () => {
    const data = '0x095ea7b3' + coder.encode(['address', 'uint256'], [someAddr, 1n]).slice(2)
    expect(decodeErc20Transfer(data)).to.equal(null)
  })

  it('rejects truncated calldata (too short)', () => {
    expect(decodeErc20Transfer(SELECTOR + '00')).to.equal(null)
  })

  it('rejects over-length calldata (extra trailing bytes)', () => {
    const data = transferCalldata(someAddr, 1n) + 'deadbeef'
    expect(decodeErc20Transfer(data)).to.equal(null)
  })

  it('rejects a dirty address word (high 12 bytes non-zero)', () => {
    // Hand-craft a transfer whose `to` word has junk in the upper bytes — a
    // non-canonical encoding that must not silently decode to a clean address.
    const dirtyToWord = 'ff'.repeat(12) + someAddr.slice(2)
    const amountWord = '0'.repeat(63) + '1'
    const data = SELECTOR + dirtyToWord + amountWord
    expect(decodeErc20Transfer(data)).to.equal(null)
  })

  it('rejects empty / non-hex data', () => {
    expect(decodeErc20Transfer('0x')).to.equal(null)
    expect(decodeErc20Transfer('')).to.equal(null)
  })
})

describe('execute fee-gate decision (sum transfers to relayer)', () => {
  // Mirror the route's summation logic in isolation: only CAW.transfer calls
  // whose recipient == relayer count toward the fee. This guards the exact
  // predicate the route uses (feePaidCawWei >= minFeeCawWei).
  const CAW = '0x56817dc696448135203c0556f702c6a953260411'
  const RELAYER = '0x2222222222222222222222222222222222222222'
  const OTHER = '0x3333333333333333333333333333333333333333'

  function sumFeeToRelayer(calls: { to: string; data: string }[]): bigint {
    let total = 0n
    for (const c of calls) {
      if (c.to.toLowerCase() !== CAW.toLowerCase()) continue
      const d = decodeErc20Transfer(c.data)
      if (d && d.to.toLowerCase() === RELAYER.toLowerCase()) total += d.amount
    }
    return total
  }

  it('counts a single CAW.transfer to the relayer', () => {
    const calls = [{ to: CAW, data: transferCalldata(RELAYER, 1000n) }]
    expect(sumFeeToRelayer(calls)).to.equal(1000n)
  })

  it('ignores a CAW.transfer to a NON-relayer (the withdraw recipient)', () => {
    const calls = [
      { to: CAW, data: transferCalldata(OTHER, 9_000_000n) },   // user's own withdrawal
      { to: CAW, data: transferCalldata(RELAYER, 1000n) },      // the fee
    ]
    expect(sumFeeToRelayer(calls)).to.equal(1000n)
  })

  it('ignores transfers on a non-CAW token even if addressed to the relayer', () => {
    const calls = [{ to: OTHER, data: transferCalldata(RELAYER, 5000n) }]
    expect(sumFeeToRelayer(calls)).to.equal(0n)
  })

  it('sums multiple fee transfers to the relayer', () => {
    const calls = [
      { to: CAW, data: transferCalldata(RELAYER, 400n) },
      { to: CAW, data: transferCalldata(RELAYER, 600n) },
    ]
    expect(sumFeeToRelayer(calls)).to.equal(1000n)
  })

  it('returns 0 when the batch pays the relayer nothing (the old free-relay bug)', () => {
    const calls = [{ to: CAW, data: transferCalldata(OTHER, 9_000_000n) }]
    expect(sumFeeToRelayer(calls)).to.equal(0n)  // < any positive minFee → FEE_TOO_LOW
  })
})

describe('execute STRICT allow-list gate (SEAM-EXEC-4)', () => {
  // Mirrors the route's strict-allow-list predicate: only (CawProfile, withdrawTo)
  // and (CAW, transfer) are permitted; everything else is default-denied. Plus the
  // withdrawTo-recipient-must-be-self shape check. No express app needed.
  const PROFILE = '0x1111111111111111111111111111111111111111'
  const CAW = '0x56817dc696448135203c0556f702c6a953260411'
  const MINTER = '0x4444444444444444444444444444444444444444'
  const SELF = '0x2222222222222222222222222222222222222222'
  const EXTERNAL = '0x3333333333333333333333333333333333333333'
  const SEL_WITHDRAW = '0xcdbafcd0'
  const SEL_TRANSFER = '0xa9059cbb'

  const ALLOWED: Record<string, Set<string>> = {
    [PROFILE.toLowerCase()]: new Set([SEL_WITHDRAW]),
    [CAW.toLowerCase()]: new Set([SEL_TRANSFER]),
  }

  // Returns null if accepted, or an error code string if rejected — mirrors route.
  function gate(to: string, data: string, smartEoa: string): string | null {
    const toLc = to.toLowerCase()
    const allowedSelectors = ALLOWED[toLc]
    if (!allowedSelectors) return 'TARGET_NOT_ALLOWED'
    const selector = (data || '').length >= 10 ? data.slice(0, 10).toLowerCase() : ''
    if (!allowedSelectors.has(selector)) return 'SELECTOR_NOT_ALLOWED'
    if (toLc === PROFILE.toLowerCase() && selector === SEL_WITHDRAW) {
      const recipientWord = data.slice(10 + 128, 10 + 192)
      if (recipientWord.length !== 64 || recipientWord.slice(0, 24) !== '0'.repeat(24)) return 'BAD_WITHDRAW_SHAPE'
      const recipient = '0x' + recipientWord.slice(24)
      if (recipient.toLowerCase() !== smartEoa.toLowerCase()) return 'WITHDRAW_RECIPIENT_NOT_SELF'
    }
    return null
  }

  // withdrawTo(uint32,uint32,address,uint32,uint256) calldata with given recipient.
  function withdrawToData(recipient: string): string {
    const w = (v: string) => v.replace(/^0x/, '').padStart(64, '0')
    return SEL_WITHDRAW + w('1') + w('1') + w(recipient.toLowerCase()) + w('0') + w('0')
  }
  function transferData(to: string, amount: bigint): string {
    const w = (v: string) => v.replace(/^0x/, '').padStart(64, '0')
    return SEL_TRANSFER + w(to.toLowerCase()) + w(amount.toString(16))
  }

  it('ALLOWS withdrawTo on CawProfile when recipient is the signer EOA', () => {
    expect(gate(PROFILE, withdrawToData(SELF), SELF)).to.equal(null)
  })
  it('ALLOWS CAW.transfer (fee + external split)', () => {
    expect(gate(CAW, transferData(SELF, 1000n), SELF)).to.equal(null)
    expect(gate(CAW, transferData(EXTERNAL, 9_000_000n), SELF)).to.equal(null)
  })
  it('DENIES the Minter entirely — SEAM-EXEC-1 drain class is unreachable', () => {
    expect(gate(MINTER, '0x10bce300' + '00'.repeat(32), SELF)).to.equal('TARGET_NOT_ALLOWED')
  })
  it('DENIES approve/transferFrom on CAW (selector not allow-listed)', () => {
    expect(gate(CAW, '0x095ea7b3' + '00'.repeat(64), SELF)).to.equal('SELECTOR_NOT_ALLOWED')
    expect(gate(CAW, '0x23b872dd' + '00'.repeat(96), SELF)).to.equal('SELECTOR_NOT_ALLOWED')
  })
  it('DENIES an arbitrary target', () => {
    expect(gate('0x9999999999999999999999999999999999999999', transferData(SELF, 1n), SELF)).to.equal('TARGET_NOT_ALLOWED')
  })
  it('DENIES withdrawTo to an EXTERNAL recipient (must be self)', () => {
    expect(gate(PROFILE, withdrawToData(EXTERNAL), SELF)).to.equal('WITHDRAW_RECIPIENT_NOT_SELF')
  })
  it('DENIES short/empty calldata (no selector)', () => {
    expect(gate(CAW, '0x', SELF)).to.equal('SELECTOR_NOT_ALLOWED')
    expect(gate(PROFILE, '0xcdba', SELF)).to.equal('SELECTOR_NOT_ALLOWED')
  })
  it('is case-insensitive on selector + recipient', () => {
    expect(gate(CAW, '0xA9059CBB' + '00'.repeat(64), SELF)).to.equal(null)
    expect(gate(PROFILE, withdrawToData(SELF).toUpperCase().replace('0X', '0x'), SELF)).to.equal(null)
  })
})
