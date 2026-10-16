import { describe, it, expect } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak256, stringToBytes, hexToBytes, bytesToHex } from 'viem'
import { signSenderEnvelope, canonicalizeSenderEnvelope, type SenderEnvelope } from './DmCryptoService'

const privateKey = hexToBytes(keccak256(stringToBytes('dm sender sig test key')))

const envelope: SenderEnvelope = {
  encryptedPayload: 'ciphertext-base64==',
  senderId: 7,
  recipientId: 12,
  conversationId: 'conv-1',
  contentType: 'text',
  timestamp: 1760000000000,
}

describe('signSenderEnvelope', () => {
  // The server's verifier (client/src/api/dmSenderSig.ts) expects a single
  // 0x prefix: 132 chars, r || s || v with v in {0, 1}.
  it('returns 0x + 65 bytes of hex', async () => {
    const sig = await signSenderEnvelope(envelope, privateKey)
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/)
    expect([0, 1]).toContain(parseInt(sig.slice(-2), 16))
  })

  it("recovers to the signer's public key over keccak256(utf8(canonical))", async () => {
    const sig = hexToBytes((await signSenderEnvelope(envelope, privateKey)) as `0x${string}`)
    const hash = hexToBytes(keccak256(stringToBytes(canonicalizeSenderEnvelope(envelope))))
    const recovered = secp256k1.Signature.fromCompact(sig.slice(0, 64))
      .addRecoveryBit(sig[64])
      .recoverPublicKey(hash)
      .toRawBytes(true)
    expect(bytesToHex(recovered)).toBe(bytesToHex(secp256k1.getPublicKey(privateKey, true)))
  })
})
