/**
 * Unit tests for the WebAuthn/ERC-1271 detection and partition logic added in
 * the webauthn-pipeline diff.
 *
 * These tests mirror the exact predicates used in:
 *   - client/src/api/routes/actions.ts  — isWebAuthnBlob() + signerKind ternary
 *   - client/src/services/ValidatorService/index.ts — partition filter + signerKind
 *     routing
 *
 * Neither function is exported so we duplicate the one-liner predicates here.
 * The tests are RPC-free and DB-free — pure logic only.
 *
 * Invariants checked:
 *   A. isWebAuthnBlob correctly classifies sigs by byte-length.
 *   B. The partition filter routes legacy-null and 'owner'/'session' rows to the
 *      ECDSA path, never to the ERC-1271 path.
 *   C. The signerKind ternary produces 'erc1271' when isERC1271Action is true,
 *      'owner' when isOwner is true and not ERC-1271, 'session' otherwise.
 */

import { describe, it } from 'mocha'
import { expect } from 'chai'

// ─── Mirrors of the production predicates ───────────────────────────────────
// Keep in sync with src/api/routes/actions.ts and ValidatorService/index.ts.

/** Exact copy of actions.ts isWebAuthnBlob */
function isWebAuthnBlob(sig: string): boolean {
  const hex = sig.startsWith('0x') ? sig.slice(2) : sig
  return hex.length / 2 > 65
}

/** Mirror of signerKind ternary used at both single-action and batch write sites */
function resolveSignerKind(
  isERC1271: boolean,
  isOwner: boolean,
): 'erc1271' | 'owner' | 'session' {
  return isERC1271 ? 'erc1271' : (isOwner ? 'owner' : 'session')
}

/** Mirror of ValidatorService partition filter */
function partitionByKind(
  rows: Array<{ signerKind: string | null | undefined }>,
): { ecdsa: typeof rows; erc1271: typeof rows } {
  return {
    ecdsa: rows.filter(e => e.signerKind !== 'erc1271'),
    erc1271: rows.filter(e => e.signerKind === 'erc1271'),
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a hex sig string of exactly `byteLen` bytes (optionally 0x-prefixed) */
function makeSig(byteLen: number, prefix = true): string {
  const body = 'ab'.repeat(byteLen)
  return prefix ? '0x' + body : body
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WebAuthn pipeline — isWebAuthnBlob', () => {
  it('accepts exactly 65 bytes as ECDSA (not WebAuthn)', () => {
    expect(isWebAuthnBlob(makeSig(65))).to.equal(false)
  })

  it('accepts 64 bytes as ECDSA (compact sig edge case)', () => {
    expect(isWebAuthnBlob(makeSig(64))).to.equal(false)
  })

  it('accepts 1 byte as ECDSA', () => {
    expect(isWebAuthnBlob(makeSig(1))).to.equal(false)
  })

  it('flags 66 bytes as WebAuthn blob', () => {
    expect(isWebAuthnBlob(makeSig(66))).to.equal(true)
  })

  it('flags a realistic 200-byte WebAuthn blob as WebAuthn', () => {
    expect(isWebAuthnBlob(makeSig(200))).to.equal(true)
  })

  it('handles sig without 0x prefix correctly', () => {
    // No prefix: raw hex. 65 bytes = 130 hex chars.
    expect(isWebAuthnBlob(makeSig(65, false))).to.equal(false)
    expect(isWebAuthnBlob(makeSig(66, false))).to.equal(true)
  })

  it('empty string is NOT a WebAuthn blob (0 bytes, ≤65)', () => {
    expect(isWebAuthnBlob('')).to.equal(false)
    expect(isWebAuthnBlob('0x')).to.equal(false)
  })
})

describe('WebAuthn pipeline — signerKind ternary', () => {
  it('ERC-1271 flag wins over isOwner — produces erc1271', () => {
    // In the API, isERC1271 sets recoveredAddress=ownerAddress so isOwner=true;
    // the ternary must still produce 'erc1271', not 'owner'.
    expect(resolveSignerKind(true, true)).to.equal('erc1271')
  })

  it('non-ERC-1271 owner sig → owner', () => {
    expect(resolveSignerKind(false, true)).to.equal('owner')
  })

  it('non-ERC-1271 session sig → session', () => {
    expect(resolveSignerKind(false, false)).to.equal('session')
  })

  it('ERC-1271 flag wins over session (isOwner=false) — produces erc1271', () => {
    expect(resolveSignerKind(true, false)).to.equal('erc1271')
  })
})

describe('WebAuthn pipeline — ValidatorService partition', () => {
  const rows = [
    { signerKind: null },           // legacy row — must go ECDSA
    { signerKind: undefined },      // truly missing — must go ECDSA
    { signerKind: 'owner' },        // owner row — must go ECDSA
    { signerKind: 'session' },      // session row — must go ECDSA
    { signerKind: 'erc1271' },      // WebAuthn row — must go ERC-1271
    { signerKind: 'erc1271' },      // second WebAuthn row
  ]

  it('legacy null signerKind routes to ECDSA, not ERC-1271', () => {
    const { ecdsa, erc1271 } = partitionByKind(rows)
    const nullRows = ecdsa.filter(r => r.signerKind === null)
    expect(nullRows).to.have.length(1)
    const nullInErc1271 = erc1271.filter(r => r.signerKind === null)
    expect(nullInErc1271).to.have.length(0)
  })

  it('undefined signerKind routes to ECDSA, not ERC-1271', () => {
    const { ecdsa, erc1271 } = partitionByKind(rows)
    const undefRows = ecdsa.filter(r => r.signerKind === undefined)
    expect(undefRows).to.have.length(1)
    expect(erc1271.filter(r => r.signerKind === undefined)).to.have.length(0)
  })

  it('owner and session rows route to ECDSA', () => {
    const { ecdsa } = partitionByKind(rows)
    expect(ecdsa.some(r => r.signerKind === 'owner')).to.equal(true)
    expect(ecdsa.some(r => r.signerKind === 'session')).to.equal(true)
  })

  it('erc1271 rows route exclusively to ERC-1271 partition', () => {
    const { ecdsa, erc1271 } = partitionByKind(rows)
    expect(erc1271.every(r => r.signerKind === 'erc1271')).to.equal(true)
    expect(ecdsa.some(r => r.signerKind === 'erc1271')).to.equal(false)
  })

  it('partition is exhaustive — ecdsa.length + erc1271.length === rows.length', () => {
    const { ecdsa, erc1271 } = partitionByKind(rows)
    expect(ecdsa.length + erc1271.length).to.equal(rows.length)
  })

  it('ECDSA partition contains exactly 4 rows (null, undefined, owner, session)', () => {
    const { ecdsa } = partitionByKind(rows)
    expect(ecdsa).to.have.length(4)
  })

  it('ERC-1271 partition contains exactly 2 rows', () => {
    const { erc1271 } = partitionByKind(rows)
    expect(erc1271).to.have.length(2)
  })
})
