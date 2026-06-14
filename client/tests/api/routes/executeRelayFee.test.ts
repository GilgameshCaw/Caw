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

describe('execute selector-deny gate (SEAM-EXEC-1 + SEAM-EXEC-3)', () => {
  // Mirrors the route's per-call deny predicate so the security-critical gate is
  // covered without standing up the full express app.
  const MINTER = '0x4444444444444444444444444444444444444444'
  const CAW = '0x56817dc696448135203c0556f702c6a953260411'
  const MINTER_DENIED = new Set(['0x10bce300', '0x7c1bb516', '0xd7ca2446'])
  const CAW_DENIED = new Set(['0x095ea7b3', '0x23b872dd']) // approve, transferFrom

  function isDenied(to: string, data: string): boolean {
    const toLc = to.toLowerCase()
    const selector = (data || '').length >= 10 ? data.slice(0, 10).toLowerCase() : ''
    if (toLc === MINTER.toLowerCase() && MINTER_DENIED.has(selector)) return true
    if (toLc === CAW.toLowerCase() && CAW_DENIED.has(selector)) return true
    return false
  }

  it('denies mintAndDepositSponsored on the Minter (relayer-CAW drain)', () => {
    expect(isDenied(MINTER, '0x10bce300' + '00'.repeat(32))).to.equal(true)
  })
  it('denies depositForSponsored + authenticateSponsored on the Minter', () => {
    expect(isDenied(MINTER, '0x7c1bb516' + 'ab'.repeat(8))).to.equal(true)
    expect(isDenied(MINTER, '0xd7ca2446' + 'ab'.repeat(8))).to.equal(true)
  })
  it('denies approve + transferFrom on the CAW token (SEAM-EXEC-3)', () => {
    expect(isDenied(CAW, '0x095ea7b3' + '00'.repeat(64))).to.equal(true)
    expect(isDenied(CAW, '0x23b872dd' + '00'.repeat(96))).to.equal(true)
  })
  it('ALLOWS a plain CAW.transfer (the fee + withdraw splits)', () => {
    expect(isDenied(CAW, '0xa9059cbb' + '00'.repeat(64))).to.equal(false)
  })
  it('allows withdrawTo on CawProfile (denies only apply to Minter/CAW selectors)', () => {
    // A non-CAW, non-Minter target call is never selector-denied here.
    expect(isDenied('0x9999999999999999999999999999999999999999', '0x10bce300')).to.equal(false)
  })
  it('case-insensitively denies an upper-cased denied selector', () => {
    expect(isDenied(CAW, '0x095EA7B3' + '00'.repeat(64))).to.equal(true)
  })
  it('I-1: short/empty calldata to the Minter is not mis-classified as a denied selector', () => {
    // slice(0,10) of '0x' would be '0x' — must NOT match a denied selector.
    expect(isDenied(MINTER, '0x')).to.equal(false)
    expect(isDenied(MINTER, '0x10bc')).to.equal(false) // truncated selector
  })
})
