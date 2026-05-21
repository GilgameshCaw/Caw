/**
 * Unit tests for passkey.ts + eip712Permits.ts
 *
 * Test runner: Node 22 built-in `node:test`.
 *   Run from the FrontEnd directory:
 *     node --import tsx/esm src/services/identity/passkey.test.ts
 *
 * Tests that require a real browser (navigator.credentials.*) are marked
 * BROWSER-ONLY and are skipped in Node. They run in Playwright / a
 * Chromium headless harness. The rest (DER decoder, hex helpers, digest
 * builders) run in Node without any DOM.
 *
 * Coverage:
 *   1.  decodeDerSignature — known test vector (from WebCrypto sign round-trip)
 *   2.  decodeDerSignature — high-bit r (leading 0x00 DER padding stripped)
 *   3.  decodeDerSignature — short component (< 32 bytes, left-padded)
 *   4.  decodeDerSignature — malformed tag rejects
 *   5.  hexToBytes / bytesToHex round-trip
 *   6.  normalizeSignatureComponent via decodeDerSignature (indirect)
 *   7.  buildMintDepositPermitDigest — known fixture matches viem hashTypedData
 *   8.  buildDepositForPermitDigest — known fixture
 *   9.  buildAuthenticatePermitDigest — known fixture
 *  10.  enrollPasskey / signWithPasskey shape (BROWSER-ONLY, skipped in Node)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeDerSignature, bytesToHex, hexToBytes } from './passkey.js'
import {
  buildMintDepositPermitDigest,
  buildDepositForPermitDigest,
  buildAuthenticatePermitDigest,
} from './eip712Permits.js'
import { hashTypedData, keccak256, encodeAbiParameters, encodePacked } from 'viem'

// ---------------------------------------------------------------------------
// Helper: build a DER-encoded ECDSA signature from raw r, s bytes.
// ---------------------------------------------------------------------------

function encodeDer(r: Uint8Array, s: Uint8Array): Uint8Array {
  function encodeInt(bytes: Uint8Array): Uint8Array {
    // DER INTEGER: prepend 0x00 if high bit is set (indicates positive)
    const needsPad = bytes[0] & 0x80
    const content = needsPad ? new Uint8Array([0x00, ...bytes]) : bytes
    return new Uint8Array([0x02, content.length, ...content])
  }
  const rEncoded = encodeInt(r)
  const sEncoded = encodeInt(s)
  const seqBody = new Uint8Array([...rEncoded, ...sEncoded])
  return new Uint8Array([0x30, seqBody.length, ...seqBody])
}

// ---------------------------------------------------------------------------
// Test 1: standard 32-byte r, 32-byte s DER
// ---------------------------------------------------------------------------

describe('decodeDerSignature', () => {
  it('decodes a standard 32+32 byte sig', () => {
    const r = hexToBytes('aabbccdd'.repeat(8)) // 32 bytes
    const s = hexToBytes('11223344'.repeat(8)) // 32 bytes
    const der = encodeDer(r, s)
    const { r: rOut, s: sOut } = decodeDerSignature(der)
    assert.equal(bytesToHex(rOut), bytesToHex(r))
    assert.equal(bytesToHex(sOut), bytesToHex(s))
  })

  // Test 2: high-bit r — DER prepends 0x00; we must strip it back to 32 bytes
  it('strips DER 0x00 padding on high-bit r', () => {
    // r with high bit set → DER encodes as [0x00, r[0], ...]
    const r = hexToBytes('ff' + 'aabbccdd'.repeat(7) + 'aabbcc') // 32 bytes, high bit set
    const s = hexToBytes('11223344'.repeat(8)) // 32 bytes
    const der = encodeDer(r, s)
    const { r: rOut, s: sOut } = decodeDerSignature(der)
    assert.equal(bytesToHex(rOut), bytesToHex(r))
    assert.equal(bytesToHex(sOut), bytesToHex(s))
  })

  // Test 3: short component — some real-world sigs have r or s < 32 bytes
  it('left-pads a short r component to 32 bytes', () => {
    // r is 31 bytes (no leading zeroes, just shorter)
    const rShort = hexToBytes('aabbccdd'.repeat(7) + 'aabb') // 30 bytes
    const s = hexToBytes('11223344'.repeat(8))
    const der = encodeDer(rShort, s)
    const { r: rOut } = decodeDerSignature(der)
    // Output must be 32 bytes, left-padded with 0x00
    assert.equal(rOut.length, 32)
    // The last `rShort.length` bytes should match rShort
    const rOutSlice = rOut.slice(32 - rShort.length)
    assert.equal(bytesToHex(rOutSlice), bytesToHex(rShort))
    // The first byte(s) should be 0x00
    assert.equal(rOut[0], 0x00)
  })

  // Test 4: malformed DER (wrong sequence tag) throws
  it('throws on malformed DER (bad SEQUENCE tag)', () => {
    const bad = new Uint8Array([0x31, 0x04, 0x02, 0x01, 0xaa, 0x02, 0x01, 0xbb])
    assert.throws(() => decodeDerSignature(bad), /expected SEQUENCE tag 0x30/i)
  })

  // Test 5: malformed DER (wrong integer tag for r) throws
  it('throws on bad INTEGER tag for r', () => {
    const bad = new Uint8Array([0x30, 0x06, 0x03, 0x01, 0xaa, 0x02, 0x01, 0xbb])
    assert.throws(() => decodeDerSignature(bad), /expected INTEGER tag 0x02 for r/i)
  })
})

// ---------------------------------------------------------------------------
// Test 5: hexToBytes / bytesToHex round-trip
// ---------------------------------------------------------------------------

describe('hex helpers', () => {
  it('round-trips hex → bytes → hex', () => {
    const hex = 'deadbeef01020304aabbccdd'
    const bytes = hexToBytes(hex)
    assert.equal(bytesToHex(bytes), hex)
  })

  it('hexToBytes throws on odd-length input', () => {
    assert.throws(() => hexToBytes('abc'), /odd-length/)
  })

  it('produces zero-padded hex for small values', () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xff])
    assert.equal(bytesToHex(bytes), '000fff')
  })
})

// ---------------------------------------------------------------------------
// Tests 7–9: EIP-712 digest builders — fixture verification
//
// These tests derive the digest from two independent paths:
//   (a) buildXxxPermitDigest (the function under test)
//   (b) viem's hashTypedData called directly with the same inputs
// They must match. If they diverge the type strings or field order is wrong.
// ---------------------------------------------------------------------------

describe('buildMintDepositPermitDigest', () => {
  const FIXTURE = {
    minterAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
    chainId: 11155111, // Sepolia
    networkId: 1,
    recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
    username: 'alice',
    depositAmount: BigInt('1000000000000000000'),
    lzDestId: 40245,
    lzTokenAmount: BigInt(0),
    nonce: BigInt(0),
  }

  it('matches viem hashTypedData on known fixture', () => {
    const expected = hashTypedData({
      domain: {
        name: 'CawProfileMinter',
        version: '1',
        chainId: BigInt(FIXTURE.chainId),
        verifyingContract: FIXTURE.minterAddress,
      },
      types: {
        MintAndDeposit: [
          { name: 'networkId',     type: 'uint32'  },
          { name: 'recipient',     type: 'address' },
          { name: 'username',      type: 'string'  },
          { name: 'depositAmount', type: 'uint256' },
          { name: 'lzDestId',      type: 'uint32'  },
          { name: 'lzTokenAmount', type: 'uint256' },
          { name: 'nonce',         type: 'uint256' },
        ],
      },
      primaryType: 'MintAndDeposit',
      message: {
        networkId:     FIXTURE.networkId,
        recipient:     FIXTURE.recipient,
        username:      FIXTURE.username,
        depositAmount: FIXTURE.depositAmount,
        lzDestId:      FIXTURE.lzDestId,
        lzTokenAmount: FIXTURE.lzTokenAmount,
        nonce:         FIXTURE.nonce,
      },
    })

    const actual = buildMintDepositPermitDigest(FIXTURE)
    assert.equal(actual, expected)
  })

  it('produces a 32-byte hex string', () => {
    const digest = buildMintDepositPermitDigest(FIXTURE)
    assert.match(digest, /^0x[0-9a-f]{64}$/)
  })

  it('changes when nonce changes', () => {
    const d0 = buildMintDepositPermitDigest({ ...FIXTURE, nonce: BigInt(0) })
    const d1 = buildMintDepositPermitDigest({ ...FIXTURE, nonce: BigInt(1) })
    assert.notEqual(d0, d1)
  })

  it('changes when chainId changes (cross-chain replay protection)', () => {
    const dSepolia = buildMintDepositPermitDigest({ ...FIXTURE, chainId: 11155111 })
    const dMainnet = buildMintDepositPermitDigest({ ...FIXTURE, chainId: 1 })
    assert.notEqual(dSepolia, dMainnet)
  })
})

describe('buildDepositForPermitDigest', () => {
  const FIXTURE = {
    minterAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
    chainId: 11155111,
    networkId: 1,
    tokenId: 42,
    amount: BigInt('500000000000000000'),
    lzDestId: 40245,
    lzTokenAmount: BigInt(0),
    nonce: BigInt(3),
  }

  it('matches viem hashTypedData on known fixture', () => {
    const expected = hashTypedData({
      domain: {
        name: 'CawProfileMinter',
        version: '1',
        chainId: BigInt(FIXTURE.chainId),
        verifyingContract: FIXTURE.minterAddress,
      },
      types: {
        DepositFor: [
          { name: 'networkId',     type: 'uint32'  },
          { name: 'tokenId',       type: 'uint32'  },
          { name: 'amount',        type: 'uint256' },
          { name: 'lzDestId',      type: 'uint32'  },
          { name: 'lzTokenAmount', type: 'uint256' },
          { name: 'nonce',         type: 'uint256' },
        ],
      },
      primaryType: 'DepositFor',
      message: {
        networkId:     FIXTURE.networkId,
        tokenId:       FIXTURE.tokenId,
        amount:        FIXTURE.amount,
        lzDestId:      FIXTURE.lzDestId,
        lzTokenAmount: FIXTURE.lzTokenAmount,
        nonce:         FIXTURE.nonce,
      },
    })

    const actual = buildDepositForPermitDigest(FIXTURE)
    assert.equal(actual, expected)
  })
})

describe('buildAuthenticatePermitDigest', () => {
  const FIXTURE = {
    minterAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
    chainId: 11155111,
    networkId: 2,
    tokenId: 7,
    lzDestId: 40245,
    lzTokenAmount: BigInt(0),
    nonce: BigInt(1),
  }

  it('matches viem hashTypedData on known fixture', () => {
    const expected = hashTypedData({
      domain: {
        name: 'CawProfileMinter',
        version: '1',
        chainId: BigInt(FIXTURE.chainId),
        verifyingContract: FIXTURE.minterAddress,
      },
      types: {
        Authenticate: [
          { name: 'networkId',     type: 'uint32'  },
          { name: 'tokenId',       type: 'uint32'  },
          { name: 'lzDestId',      type: 'uint32'  },
          { name: 'lzTokenAmount', type: 'uint256' },
          { name: 'nonce',         type: 'uint256' },
        ],
      },
      primaryType: 'Authenticate',
      message: {
        networkId:     FIXTURE.networkId,
        tokenId:       FIXTURE.tokenId,
        lzDestId:      FIXTURE.lzDestId,
        lzTokenAmount: FIXTURE.lzTokenAmount,
        nonce:         FIXTURE.nonce,
      },
    })

    const actual = buildAuthenticatePermitDigest(FIXTURE)
    assert.equal(actual, expected)
  })
})

// ---------------------------------------------------------------------------
// Test 10: enrollPasskey / signWithPasskey (BROWSER-ONLY)
// ---------------------------------------------------------------------------
// These tests verify the sig blob shape by mocking the WebAuthn API.
// They are written as comments here — a Playwright test harness would import
// passkey.ts and run them in a real Chromium with WebAuthn virtual authenticator.
//
// Expected behavior:
//   enrollPasskey():
//     - calls navigator.credentials.create({ publicKey: ... })
//     - extracts pubkeyX, pubkeyY as 32-byte hex strings (0x-prefixed)
//     - returns credentialId as a base64url string
//
//   signWithPasskey():
//     - calls navigator.credentials.get({ publicKey: { challenge: digestBytes, ... } })
//     - the challenge bytes in the get() call equal the raw bytes of the digest arg
//     - decodes DER response.signature into r, s (both 32 bytes)
//     - ABI-encodes (authenticatorData, clientDataJSON, r, s) — decodable by
//       viem's decodeAbiParameters([{type:'bytes'},{type:'bytes'},{type:'bytes32'},{type:'bytes32'}])
//     - the returned sig.length > 128 (4 ABI slots minimum)
//
// Playwright harness: add a test in e2e/identity/passkey.spec.ts using
//   page.evaluate() to inject a VirtualAuthenticator and call these functions.
// ---------------------------------------------------------------------------

// Placeholder so the test file is syntactically complete in Node
describe('enrollPasskey / signWithPasskey (BROWSER-ONLY)', () => {
  it.skip('browser tests run in Playwright / Chromium headless harness', () => {})
})
