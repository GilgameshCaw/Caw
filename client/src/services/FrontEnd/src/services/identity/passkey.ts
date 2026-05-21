/**
 * WebAuthn passkey helpers for SmartEOA / EIP-7702 Population-B users.
 *
 * Sig blob format (what SmartEOA._verifyWebAuthn expects):
 *   abi.encode(bytes authenticatorData, bytes clientDataJSON, bytes32 r, bytes32 s)
 *
 * Challenge binding: the digest passed to signWithPasskey IS the 32-byte
 * WebAuthn challenge. navigator.credentials.get receives it as a raw byte
 * buffer so the browser encodes it as base64url inside clientDataJSON. The
 * contract reads "challenge" from clientDataJSON and base64url-decodes it,
 * then compares to the digest — so the challenge and the digest are the same
 * bytes, which is what _challengeMatchesDigest in SmartEOA verifies.
 */

import { encodeAbiParameters } from 'viem'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PasskeyPubkey = {
  /** 32-byte P-256 X coordinate as 0x-prefixed hex */
  pubkeyX: `0x${string}`
  /** 32-byte P-256 Y coordinate as 0x-prefixed hex */
  pubkeyY: `0x${string}`
  /** base64url credential ID for re-using the credential on get() */
  credentialId: string
}

export type PasskeySignResult = {
  /** ABI-encoded blob ready for SmartEOA.isValidSignature */
  sig: `0x${string}`
  authenticatorData: `0x${string}`
  clientDataJSON: string
  r: `0x${string}`
  s: `0x${string}`
}

// ---------------------------------------------------------------------------
// Enroll (create)
// ---------------------------------------------------------------------------

/**
 * Enroll a new passkey via navigator.credentials.create().
 * Returns the P-256 public key coordinates and the credential ID.
 *
 * rpId should be the current hostname (e.g., "app.caw.social").
 * A random challenge is generated internally if not supplied.
 */
export async function enrollPasskey(opts: {
  rpId: string
  userName: string
  userDisplayName: string
  challenge?: Uint8Array
}): Promise<PasskeyPubkey> {
  if (!window.PublicKeyCredential) {
    throw new Error('WebAuthn not supported in this browser')
  }

  const challenge = opts.challenge ?? crypto.getRandomValues(new Uint8Array(32))

  const credential = await navigator.credentials.create({
    publicKey: {
      rp: {
        name: opts.rpId,
        id: opts.rpId,
      },
      user: {
        // userId must be unique per user — use a random value so no
        // PII is embedded in the credential (we derive identity from the
        // secp256k1 keypair, not from the WebAuthn userId field).
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: opts.userName,
        displayName: opts.userDisplayName,
      },
      challenge,
      pubKeyCredParams: [
        // Prefer P-256 (COSE -7). P-384 (-35) and RS256 (-257) are not
        // supported by the P-256 precompile SmartEOA uses.
        { type: 'public-key', alg: -7 },
      ],
      authenticatorSelection: {
        // residentKey + requireResidentKey = discoverable credential
        // (passkey). Syncs across iCloud Keychain / Google PM.
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      attestation: 'none',
    },
  })

  if (!credential || credential.type !== 'public-key') {
    throw new Error('enrollPasskey: unexpected credential type')
  }

  const pkCred = credential as PublicKeyCredential
  const response = pkCred.response as AuthenticatorAttestationResponse

  // Extract the COSE-encoded public key from the authenticator data.
  // authenticatorData layout:
  //   [0..31]  rpIdHash (SHA-256 of rpId)
  //   [32]     flags
  //   [33..36] signCount (uint32 BE)
  //   [37..52] AAGUID (if AT flag set)
  //   [53..54] credIdLen (uint16 BE)
  //   [55 .. 55+credIdLen-1] credentialId
  //   [55+credIdLen ..]      COSE public key (CBOR)
  //
  // We use getPublicKey() which returns the SubjectPublicKeyInfo (SPKI) DER
  // blob — the last 64 bytes are the raw X || Y coordinates on the P-256 curve.
  const spkiBytes = response.getPublicKey()
  if (!spkiBytes) {
    throw new Error('enrollPasskey: browser did not expose public key via getPublicKey()')
  }

  const { x, y } = extractP256XYFromSpki(new Uint8Array(spkiBytes))

  const credentialId = bufferToBase64url(pkCred.rawId)

  return {
    pubkeyX: ('0x' + bytesToHex(x)) as `0x${string}`,
    pubkeyY: ('0x' + bytesToHex(y)) as `0x${string}`,
    credentialId,
  }
}

// ---------------------------------------------------------------------------
// Sign (get assertion)
// ---------------------------------------------------------------------------

/**
 * Sign a 32-byte digest using an enrolled passkey.
 *
 * digest is used verbatim as the WebAuthn challenge, so the contract's
 * _challengeMatchesDigest check passes (it base64url-decodes the challenge
 * field in clientDataJSON and compares to the same digest bytes).
 *
 * Returns the ABI-encoded sig blob SmartEOA.isValidSignature accepts, plus
 * the raw components for diagnostic use.
 */
export async function signWithPasskey(opts: {
  credentialId: string
  /** 32-byte EIP-712 digest as 0x-prefixed hex */
  digest: `0x${string}`
  rpId: string
}): Promise<PasskeySignResult> {
  if (!window.PublicKeyCredential) {
    throw new Error('WebAuthn not supported in this browser')
  }

  // The digest IS the challenge. Strip the 0x prefix and convert to bytes.
  const digestBytes = hexToBytes(opts.digest.slice(2) as string)
  if (digestBytes.length !== 32) {
    throw new Error('signWithPasskey: digest must be exactly 32 bytes')
  }

  const credIdBytes = base64urlToBytes(opts.credentialId)

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: digestBytes,
      rpId: opts.rpId,
      allowCredentials: [
        { type: 'public-key', id: credIdBytes },
      ],
      userVerification: 'required',
    },
  })

  if (!assertion || assertion.type !== 'public-key') {
    throw new Error('signWithPasskey: unexpected assertion type')
  }

  const pkAssertion = assertion as PublicKeyCredential
  const response = pkAssertion.response as AuthenticatorAssertionResponse

  const authData = new Uint8Array(response.authenticatorData)
  const clientDataJSONBytes = new Uint8Array(response.clientDataJSON)
  const clientDataJSONStr = new TextDecoder().decode(clientDataJSONBytes)
  const derSig = new Uint8Array(response.signature)

  // Extract r, s from DER-encoded ECDSA signature.
  const { r, s } = decodeDerSignature(derSig)

  const authDataHex = ('0x' + bytesToHex(authData)) as `0x${string}`
  const rHex = ('0x' + bytesToHex(r)) as `0x${string}`
  const sHex = ('0x' + bytesToHex(s)) as `0x${string}`

  // ABI-encode the blob SmartEOA._decodeWebAuthn expects:
  //   abi.decode(sig, (bytes, bytes, bytes32, bytes32))
  // = (authenticatorData, clientDataJSON, r, s)
  const sig = encodeAbiParameters(
    [
      { type: 'bytes' },
      { type: 'bytes' },
      { type: 'bytes32' },
      { type: 'bytes32' },
    ],
    [
      authDataHex,
      (('0x' + bytesToHex(clientDataJSONBytes)) as `0x${string}`),
      rHex,
      sHex,
    ]
  )

  return {
    sig,
    authenticatorData: authDataHex,
    clientDataJSON: clientDataJSONStr,
    r: rHex,
    s: sHex,
  }
}

// ---------------------------------------------------------------------------
// DER ECDSA signature decoder
// ---------------------------------------------------------------------------
// WebAuthn response.signature is DER-encoded: SEQUENCE { INTEGER r, INTEGER s }.
// Format: 0x30 [totalLen] 0x02 [rLen] [r bytes] 0x02 [sLen] [s bytes]
// r and s may be 33 bytes (with a 0x00 prefix to indicate positive) or 31/32 bytes.
// We normalize each to exactly 32 bytes.

export function decodeDerSignature(der: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  let offset = 0

  if (der[offset++] !== 0x30) {
    throw new Error('decodeDerSignature: expected SEQUENCE tag 0x30')
  }

  // Skip length byte(s). Long-form encoding is unusual for ECDSA sigs but handle it.
  const seqLenByte = der[offset++]
  if (seqLenByte & 0x80) {
    // Long-form: lower 7 bits = number of subsequent length bytes
    const lenBytes = seqLenByte & 0x7f
    offset += lenBytes
  }

  // Read r
  if (der[offset++] !== 0x02) {
    throw new Error('decodeDerSignature: expected INTEGER tag 0x02 for r')
  }
  const rLen = der[offset++]
  const rRaw = der.slice(offset, offset + rLen)
  offset += rLen

  // Read s
  if (der[offset++] !== 0x02) {
    throw new Error('decodeDerSignature: expected INTEGER tag 0x02 for s')
  }
  const sLen = der[offset++]
  const sRaw = der.slice(offset, offset + sLen)

  return {
    r: normalizeSignatureComponent(rRaw),
    s: normalizeSignatureComponent(sRaw),
  }
}

/**
 * Strip a leading 0x00 (positive-integer marker in DER) and left-pad to 32 bytes.
 */
function normalizeSignatureComponent(raw: Uint8Array): Uint8Array {
  // Strip leading zero byte if present (DER positive marker for high-bit integers).
  let bytes = raw[0] === 0x00 ? raw.slice(1) : raw
  if (bytes.length > 32) {
    throw new Error('normalizeSignatureComponent: component exceeds 32 bytes')
  }
  // Left-pad with zeros to 32 bytes
  const out = new Uint8Array(32)
  out.set(bytes, 32 - bytes.length)
  return out
}

// ---------------------------------------------------------------------------
// SPKI public key extraction
// ---------------------------------------------------------------------------
// SubjectPublicKeyInfo DER for P-256 ends with 65 uncompressed-point bytes:
//   0x04 || X (32 bytes) || Y (32 bytes)
// We find the 0x04 marker and read the subsequent 64 bytes.

function extractP256XYFromSpki(spki: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  // P-256 uncompressed point prefix
  const markerIdx = spki.lastIndexOf(0x04)
  if (markerIdx === -1 || spki.length < markerIdx + 65) {
    throw new Error('extractP256XYFromSpki: could not find uncompressed point in SPKI')
  }
  const x = spki.slice(markerIdx + 1, markerIdx + 33)
  const y = spki.slice(markerIdx + 33, markerIdx + 65)
  return { x, y }
}

// ---------------------------------------------------------------------------
// Small encoding helpers (no external deps)
// ---------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hexToBytes: odd-length hex string')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return out
}

function bufferToBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64urlToBytes(b64url: string): Uint8Array {
  // Restore standard base64 padding
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    b64url.length + ((4 - (b64url.length % 4)) % 4),
    '='
  )
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
