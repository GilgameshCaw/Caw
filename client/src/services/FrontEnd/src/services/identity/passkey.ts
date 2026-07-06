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

/**
 * Throw a precise error if WebAuthn can't run here. The usual cause on a phone
 * is NOT "browser unsupported" (iOS Safari/Chrome all support passkeys) but a
 * NON-SECURE ORIGIN: WebAuthn requires a secure context (https:// or
 * localhost). Over plain http on a LAN IP (e.g. http://192.168.x.x:5274),
 * `window.PublicKeyCredential` is undefined and the old message wrongly blamed
 * the browser. Surface the real reason so test setups aren't mystifying.
 */
function assertWebAuthnAvailable(): void {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new Error(
      'Passkeys require a secure connection (https). This page is served over ' +
      'plain http, so the browser blocks WebAuthn. Use the https site (or ' +
      'localhost / an https tunnel) to create a passkey.',
    )
  }
  if (typeof window === 'undefined' || !window.PublicKeyCredential) {
    throw new Error('WebAuthn (passkeys) is not available in this browser')
  }
}

export type PasskeyPubkey = {
  /** 32-byte P-256 X coordinate as 0x-prefixed hex */
  pubkeyX: `0x${string}`
  /** 32-byte P-256 Y coordinate as 0x-prefixed hex */
  pubkeyY: `0x${string}`
  /** base64url credential ID for re-using the credential on get() */
  credentialId: string
  /**
   * Whether this credential reported PRF support at creation
   * (`getClientExtensionResults().prf.enabled === true`). This is a HINT only:
   * some authenticators report `enabled` only at get() time, so a false here
   * doesn't prove PRF is unavailable — the real test is whether a later get()
   * with a salt returns `prfSecret`. Persist it to pre-select the unlock path.
   */
  prfEnabled: boolean
}

export type PasskeySignResult = {
  /** ABI-encoded blob ready for SmartEOA.isValidSignature */
  sig: `0x${string}`
  authenticatorData: `0x${string}`
  clientDataJSON: string
  r: `0x${string}`
  s: `0x${string}`
  /**
   * WebAuthn PRF extension output (32 bytes), present ONLY when a `prfSalt`
   * was passed AND the authenticator+browser support the `prf` extension.
   * This is a hardware-derived secret unique to (credential, salt); we use it
   * to wrap/unwrap the DM recovery key so a Face ID prompt can unlock DMs
   * with no vault password. `undefined` = PRF unsupported here → caller falls
   * back to the password path. NEVER send this to the server.
   */
  prfSecret?: Uint8Array
}

// ---------------------------------------------------------------------------
// PRF extension helpers
// ---------------------------------------------------------------------------

/**
 * Build the `extensions` fragment for a get() that requests the PRF secret.
 * Returns `{}` when no salt is given so callers can spread it unconditionally
 * (`...prfGetExtension(opts.prfSalt)`) without changing signature-only behavior.
 * The salt must be a stable per-user value (see prf.ts buildPrfSalt) so the
 * derived secret is reproducible across sessions/devices.
 */
function prfGetExtension(
  prfSalt?: Uint8Array,
): { extensions?: AuthenticationExtensionsClientInputs } {
  if (!prfSalt) return {}
  return {
    extensions: {
      prf: { eval: { first: prfSalt as BufferSource } },
    } as AuthenticationExtensionsClientInputs,
  }
}

/**
 * Pull the 32-byte PRF secret out of an assertion's client-extension results,
 * or `undefined` if the authenticator/browser didn't return one (no PRF
 * support, or no salt was requested). Never throws — a missing result means
 * "fall back to the password path".
 */
function extractPrfSecret(assertion: PublicKeyCredential): Uint8Array | undefined {
  try {
    const ext = assertion.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer } }
    }
    const first = ext?.prf?.results?.first
    if (!first) return undefined
    const bytes = new Uint8Array(first)
    return bytes.length === 32 ? bytes : undefined
  } catch {
    return undefined
  }
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
  assertWebAuthnAvailable()

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
      // Request the PRF extension at creation so a supporting authenticator
      // enables it for this credential. We only PROBE eligibility here
      // (`getClientExtensionResults().prf?.enabled`) — the actual 32-byte
      // secret is only readable during get(), not create(). Harmless on
      // authenticators that don't support prf (ignored).
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
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

  // PRF eligibility hint (see PasskeyPubkey.prfEnabled). getClientExtensionResults
  // may throw on ancient browsers; treat any failure as "unknown → false".
  let prfEnabled = false
  try {
    const ext = pkCred.getClientExtensionResults() as { prf?: { enabled?: boolean } }
    prfEnabled = ext?.prf?.enabled === true
  } catch { /* not supported → false */ }

  return {
    pubkeyX: ('0x' + bytesToHex(x)) as `0x${string}`,
    pubkeyY: ('0x' + bytesToHex(y)) as `0x${string}`,
    credentialId,
    prfEnabled,
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
  /**
   * Optional 32-byte PRF salt. When present, request the WebAuthn `prf`
   * extension in this SAME assertion so a single Face ID prompt yields both
   * the signature AND a hardware-derived secret (returned as
   * `PasskeySignResult.prfSecret`). Omit for a normal signature-only ceremony.
   */
  prfSalt?: Uint8Array
}): Promise<PasskeySignResult> {
  assertWebAuthnAvailable()

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
      ...prfGetExtension(opts.prfSalt),
    },
  })

  if (!assertion || assertion.type !== 'public-key') {
    throw new Error('signWithPasskey: unexpected assertion type')
  }

  const pkAssertion = assertion as PublicKeyCredential
  const response = pkAssertion.response as AuthenticatorAssertionResponse
  const prfSecret = extractPrfSecret(pkAssertion)

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
    prfSecret,
  }
}

/**
 * Sign a 32-byte digest with a DISCOVERABLE (resident) passkey — no credentialId
 * required. For passkey sign-in on a fresh device (localStorage cleared): the
 * authenticator surfaces the synced passkey for this rpId (iCloud Keychain /
 * Google Password Manager) via an empty allowCredentials list, and the user
 * picks it. Returns the same blob as signWithPasskey, plus the credentialId of
 * the chosen credential (so the caller can persist it for next time).
 */
export async function signWithPasskeyDiscoverable(opts: {
  digest: `0x${string}`
  rpId: string
  /** See signWithPasskey.prfSalt — request the PRF secret in this same get(). */
  prfSalt?: Uint8Array
}): Promise<PasskeySignResult & { credentialId: string }> {
  assertWebAuthnAvailable()
  const digestBytes = hexToBytes(opts.digest.slice(2) as string)
  if (digestBytes.length !== 32) {
    throw new Error('signWithPasskeyDiscoverable: digest must be exactly 32 bytes')
  }

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: digestBytes,
      rpId: opts.rpId,
      // No allowCredentials → the platform offers any resident passkey for this
      // rpId. This is what makes "sign in on a new device" work with no local
      // credentialId.
      userVerification: 'required',
      ...prfGetExtension(opts.prfSalt),
    },
  })
  if (!assertion || assertion.type !== 'public-key') {
    throw new Error('signWithPasskeyDiscoverable: unexpected assertion type')
  }

  const pkAssertion = assertion as PublicKeyCredential
  const response = pkAssertion.response as AuthenticatorAssertionResponse
  const prfSecret = extractPrfSecret(pkAssertion)
  const authData = new Uint8Array(response.authenticatorData)
  const clientDataJSONBytes = new Uint8Array(response.clientDataJSON)
  const clientDataJSONStr = new TextDecoder().decode(clientDataJSONBytes)
  const { r, s } = decodeDerSignature(new Uint8Array(response.signature))

  const authDataHex = ('0x' + bytesToHex(authData)) as `0x${string}`
  const rHex = ('0x' + bytesToHex(r)) as `0x${string}`
  const sHex = ('0x' + bytesToHex(s)) as `0x${string}`
  const sig = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [authDataHex, (('0x' + bytesToHex(clientDataJSONBytes)) as `0x${string}`), rHex, sHex],
  )

  return {
    sig,
    authenticatorData: authDataHex,
    clientDataJSON: clientDataJSONStr,
    r: rHex,
    s: sHex,
    prfSecret,
    credentialId: bufferToBase64url(pkAssertion.rawId),
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
    // CRITICAL (low-s): WebAuthn authenticators (notably Apple Touch ID / iCloud
    // Keychain) emit ECDSA signatures with a HIGH `s` value ~half the time. The
    // EIP-7951 P-256 precompile at 0x0100 — which SmartEOA._verifyP256 calls —
    // enforces the canonical 1 <= s <= n/2 and REJECTS high-s. Without flipping
    // high-s to (n - s) here, ~50% of passkey-signed executeBatch / sponsored
    // operations would fail on-chain intermittently with no clear cause. (s, n-s)
    // are equivalent valid signatures, so this normalization is always safe.
    s: toLowS(normalizeSignatureComponent(sRaw)),
  }
}

// P-256 (secp256r1) curve order n.
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const P256_N_HALF = P256_N >> 1n

function bytes32ToBigInt(b: Uint8Array): bigint {
  let v = 0n
  for (const byte of b) v = (v << 8n) | BigInt(byte)
  return v
}

function bigIntToBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n }
  return out
}

/** Return the canonical low-s form: if s > n/2, replace with n - s. */
function toLowS(s32: Uint8Array): Uint8Array {
  const s = bytes32ToBigInt(s32)
  return s > P256_N_HALF ? bigIntToBytes32(P256_N - s) : s32
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
// P-256 SubjectPublicKeyInfo for an uncompressed point is exactly 91 bytes:
//   Bytes 0–25:  DER prefix (SEQUENCE { SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING })
//   Byte  26:    0x00 (BIT STRING unused-bits count)
//   Byte  27:    0x04 (uncompressed point marker)
//   Bytes 28–59: X (32 bytes)
//   Bytes 60–91: Y (32 bytes)

function extractP256XYFromSpki(spki: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  // P-256 SPKI for an uncompressed point is *typically* 91 bytes with the 0x04
  // marker at byte 27 — but the exact DER prefix length is NOT guaranteed across
  // authenticators. Cross-device / hybrid (caBLE) passkeys and some platform
  // authenticators return a structurally-valid SPKI whose AlgorithmIdentifier or
  // length encoding shifts the marker off byte 27. Hard-coding the offset broke
  // those (symptom: "uncompressed point marker not at byte 27" on phone-relayed
  // sign-in).
  //
  // Robust parse: the public key is the trailing `0x04 || X(32) || Y(32)` = 65
  // bytes. We don't need to walk the whole DER — for an uncompressed P-256 point
  // the last 65 bytes are exactly that, and the byte at position len-65 MUST be
  // the 0x04 uncompressed marker. This is unambiguous: the only place a 65-byte
  // `0x04`-prefixed run lands is the BIT STRING payload at the very end of SPKI.
  // The trailing 65 bytes of any uncompressed-point SPKI are exactly
  // `0x04 || X(32) || Y(32)` — the BIT STRING payload always sits at the end,
  // so the marker is at len-65 no matter how long the DER prefix is. Validate
  // that anchor (rejects a corrupt / non-uncompressed key) and slice.
  const PT_LEN = 65 // 0x04 + 32-byte X + 32-byte Y
  if (spki.length < PT_LEN) {
    throw new Error(`extractP256XYFromSpki: SPKI too short (${spki.length} bytes, need ≥ ${PT_LEN})`)
  }
  const markerIdx = spki.length - PT_LEN
  if (spki[markerIdx] !== 0x04) {
    throw new Error(
      `extractP256XYFromSpki: expected 0x04 uncompressed-point marker at byte ${markerIdx} ` +
      `(len=${spki.length}), got 0x${spki[markerIdx].toString(16).padStart(2, '0')}`,
    )
  }
  return { x: spki.slice(markerIdx + 1, markerIdx + 33), y: spki.slice(markerIdx + 33, markerIdx + 65) }
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
