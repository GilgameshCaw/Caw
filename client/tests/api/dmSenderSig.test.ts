/**
 * verifyDmSenderSig against signatures made the way the FE makes them
 * (DmCryptoService.signSenderEnvelope: noble secp256k1 over
 * keccak256(utf8(canonical)), 65 bytes r || s || v with v in {0, 1}).
 */

import { expect } from 'chai'
import { keccak256, toUtf8Bytes, getBytes, hexlify } from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  canonicalizeDmSenderEnvelope,
  verifyDmSenderSig,
  type DmSenderEnvelope,
} from '../../src/api/dmSenderSig'

const privateKey = getBytes(keccak256(toUtf8Bytes('dm sender sig test key')))
const publicKeyHex = hexlify(secp256k1.getPublicKey(privateKey, true))
const otherPublicKeyHex = hexlify(
  secp256k1.getPublicKey(getBytes(keccak256(toUtf8Bytes('someone else'))), true),
)

const envelope: DmSenderEnvelope = {
  encryptedPayload: 'ciphertext-base64==',
  senderId: 7,
  recipientId: 12,
  conversationId: 'conv-1',
  contentType: 'text',
  timestamp: 1760000000000,
}

// Same steps as signSenderEnvelope, minus the prefix.
function signHex(env: DmSenderEnvelope): string {
  const hash = getBytes(keccak256(toUtf8Bytes(canonicalizeDmSenderEnvelope(env))))
  const sig = secp256k1.sign(hash, privateKey)
  const out = new Uint8Array(65)
  out.set(sig.toCompactRawBytes(), 0)
  out[64] = (sig.recovery ?? 0) & 1
  return Buffer.from(out).toString('hex')
}

describe('verifyDmSenderSig', () => {
  it('accepts a 0x-prefixed 65-byte signature', () => {
    const sig = '0x' + signHex(envelope)
    expect(sig).to.have.length(132)
    expect(verifyDmSenderSig(envelope, sig, publicKeyHex)).to.equal(true)
  })

  it('accepts the "0x0x" form older frontends send', () => {
    const sig = '0x0x' + signHex(envelope)
    expect(sig).to.have.length(134)
    expect(verifyDmSenderSig(envelope, sig, publicKeyHex)).to.equal(true)
  })

  it('rejects a signature over a different envelope', () => {
    const sig = '0x' + signHex(envelope)
    expect(verifyDmSenderSig({ ...envelope, encryptedPayload: 'other' }, sig, publicKeyHex)).to.equal(false)
    expect(verifyDmSenderSig({ ...envelope, recipientId: 0 }, '0x0x' + signHex(envelope), publicKeyHex)).to.equal(false)
  })

  it("rejects a signature checked against someone else's key", () => {
    expect(verifyDmSenderSig(envelope, '0x' + signHex(envelope), otherPublicKeyHex)).to.equal(false)
    expect(verifyDmSenderSig(envelope, '0x0x' + signHex(envelope), otherPublicKeyHex)).to.equal(false)
  })

  it('rejects other prefixes and lengths', () => {
    const hex = signHex(envelope)
    for (const sig of ['0x0x0x' + hex, '0X0x' + hex, hex, '0x' + hex.slice(2), '', '0x0x']) {
      expect(verifyDmSenderSig(envelope, sig, publicKeyHex), sig.slice(0, 8) + '… len ' + sig.length).to.equal(false)
    }
  })
})
