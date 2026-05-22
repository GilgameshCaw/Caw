import { secp256k1 } from '@noble/curves/secp256k1'
import { requireSecureCrypto } from '~/utils/secureContext'

/**
 * KDF version constants embedded as the first byte of every DM ciphertext blob.
 *
 * V1 (0x01): legacy — SHA-256(full 65-byte uncompressed shared point: 0x04||x||y).
 *             Non-standard; retained only for decrypting existing stored messages.
 * V2 (0x02): canonical ANSI X9.63 / RFC 8418 — SHA-256(x-coordinate only, 32 bytes).
 *             All new messages use V2.
 *
 * Wire format (after this fix):
 *   base64( kdfVersion[1] || iv[12] || aesgcm_ciphertext+tag )
 *
 * Legacy stored ciphertexts (no version byte, raw base64 starting with iv[12])
 * are detected because their decoded first byte is NEVER 0x01 or 0x02 for a
 * random 12-byte IV (the AES-GCM IV is random, so bytes 0 and 1 can technically
 * collide — we handle this by checking the version byte explicitly and falling
 * back to V1 KDF only when the stored ciphertext predates this change).
 *
 * The server persists ciphertexts verbatim; no server changes are needed.
 * The sharedSecretByPeer cache is version-keyed so V1 and V2 keys don't collide.
 */
export const KDF_VERSION_V1 = 0x01
export const KDF_VERSION_V2 = 0x02

// Shared-secret cache. Keyed by `${peerUserId}:${kdfVersion}` so V1 and V2
// keys are cached independently and the version-aware decrypt path can
// always reach the right key without polluting the V2 path.
const sharedSecretByPeer = new Map<string, CryptoKey>()

const DM_KEYS_STORAGE_KEY = 'caw-dm-keys'

// In-memory cache — also persisted to localStorage for cross-refresh survival
let cachedPrivateKey: Uint8Array | null = null
let cachedPublicKey: string | null = null
let cachedTokenId: number | null = null

/** Persist current keys to localStorage */
function persistKeys() {
  if (!cachedPrivateKey || !cachedPublicKey || cachedTokenId === null) return
  try {
    const data: Record<number, { privateKey: string; publicKey: string }> = loadPersistedKeys()
    data[cachedTokenId] = {
      privateKey: bytesToHex(cachedPrivateKey),
      publicKey: cachedPublicKey,
    }
    localStorage.setItem(DM_KEYS_STORAGE_KEY, JSON.stringify(data))
  } catch {}
}

/** Load all persisted keys from localStorage */
function loadPersistedKeys(): Record<number, { privateKey: string; publicKey: string }> {
  try {
    const raw = localStorage.getItem(DM_KEYS_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Restore keys for a specific tokenId from localStorage into memory */
function restoreFromStorage(tokenId: number): boolean {
  const all = loadPersistedKeys()
  const entry = all[tokenId]
  if (!entry) return false
  cachedPrivateKey = hexToBytes(entry.privateKey)
  cachedPublicKey = entry.publicKey
  cachedTokenId = tokenId
  return true
}

/**
 * Derive a deterministic secp256k1 keypair from a wallet signature.
 * The wallet signs a fixed message; SHA-256 of the signature becomes the private key.
 * Same wallet on any domain produces the same keypair.
 */
export async function deriveKeyPair(
  signMessage: (message: string) => Promise<string>,
  tokenId: number,
  username?: string
): Promise<{ privateKey: Uint8Array; publicKeyHex: string; rawSignature?: string; sigMessage?: string }> {
  // Fail fast with a clear message before triggering a wallet signature: if
  // the browser doesn't expose crypto.subtle (HTTP on a network host, some
  // in-app browsers), the SHA-256 step below would crash with "Cannot read
  // properties of undefined (reading 'digest')".
  requireSecureCrypto('DM encryption')

  // Return cached if available and for the same tokenId
  if (cachedPrivateKey && cachedPublicKey && cachedTokenId === tokenId) {
    return { privateKey: cachedPrivateKey, publicKeyHex: cachedPublicKey }
  }

  // Clear stale in-memory cache from a different tokenId
  if (cachedTokenId !== null && cachedTokenId !== tokenId) {
    cachedPrivateKey = null
    cachedPublicKey = null
    cachedTokenId = null
    sharedSecretByPeer.clear() // keyed by `${peerUserId}:${kdfVersion}`
  }

  // Try restoring from localStorage before requesting a signature
  if (restoreFromStorage(tokenId)) {
    return { privateKey: cachedPrivateKey!, publicKeyHex: cachedPublicKey! }
  }

  // Always use username-based message (testnet — no legacy compatibility needed)
  if (!username) throw new Error('Username is required for DM key derivation')
  const message = `CAW Protocol\nEnable DMs\n@${username}`
  const signature = await signMessage(message)

  // SHA-256 of the signature → 32-byte private key
  const sigBytes = hexToBytes(signature)
  const hashBuffer = await crypto.subtle.digest('SHA-256', sigBytes)
  const privateKey = new Uint8Array(hashBuffer)

  // Derive compressed public key (33 bytes, hex-encoded)
  const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKey, true))

  cachedPrivateKey = privateKey
  cachedPublicKey = publicKeyHex
  cachedTokenId = tokenId
  persistKeys()

  return { privateKey, publicKeyHex, rawSignature: signature, sigMessage: message }
}

/**
 * Check if we have a cached keypair — in memory or localStorage
 */
export function hasCachedKeyPair(tokenId?: number): boolean {
  if (cachedPrivateKey && cachedPublicKey) {
    if (tokenId === undefined || cachedTokenId === tokenId) return true
  }
  // In-memory keys missing or belong to a different tokenId — try localStorage
  if (tokenId !== undefined) {
    return restoreFromStorage(tokenId)
  }
  return false
}

/**
 * Get the cached public key hex if available
 */
export function getCachedPublicKeyHex(): string | null {
  return cachedPublicKey
}

/**
 * Get the cached private key if available
 */
export function getCachedPrivateKey(): Uint8Array | null {
  return cachedPrivateKey
}

/**
 * Canonical envelope bytes that the SENDER signs over per-message. The
 * receiver reproduces the exact same canonicalization and verifies the
 * recovered address matches DmIdentity.walletAddress for senderId.
 *
 * Field order is fixed; JSON.stringify with this exact key order is the
 * canonical form. NO room for senderSig itself in the canonical bytes
 * (it'd be self-referential). The shape is a STRICT SUBSET of what the
 * relay envelope has — relayId / sourceInstanceId / etc are routing
 * metadata that don't belong in a wallet-scoped sig.
 */
export interface SenderEnvelope {
  encryptedPayload: string
  senderId: number
  recipientId: number
  conversationId: string
  contentType: string
  timestamp: number
}

export function canonicalizeSenderEnvelope(env: SenderEnvelope): string {
  return JSON.stringify({
    encryptedPayload: env.encryptedPayload,
    senderId:         env.senderId,
    recipientId:      env.recipientId,
    conversationId:   env.conversationId,
    contentType:      env.contentType,
    timestamp:        env.timestamp,
  })
}

/**
 * Sign a SenderEnvelope with the user's DmIdentity secp256k1 private
 * key. Returns 65-byte (r || s || v) hex prefixed with `0x`. Hash is
 * keccak256 over the UTF-8 bytes of the canonical string — matches the
 * server-side verifier which uses ethers `recoverAddress(keccak256(...),
 * sig)` to recover the wallet-derived address.
 *
 * Round 7 audit fix #1b: closes the cross-instance forgery vector
 * where any registered relay node could put words in any user's mouth.
 */
export async function signSenderEnvelope(
  env: SenderEnvelope,
  privateKey: Uint8Array,
): Promise<string> {
  const { keccak256, toUtf8Bytes } = await import('ethers')
  const canonical = canonicalizeSenderEnvelope(env)
  const hashHex = keccak256(toUtf8Bytes(canonical))
  // Strip 0x for noble's expected form
  const hashBytes = hexToBytes(hashHex)
  const sig = secp256k1.sign(hashBytes, privateKey)
  const compact = sig.toCompactRawBytes()
  const v = (sig.recovery ?? 0) & 1
  const out = new Uint8Array(65)
  out.set(compact, 0)
  out[64] = v
  return '0x' + bytesToHex(out)
}

/**
 * Clear cached keys (e.g., on disconnect)
 */
export function clearKeyCache(tokenId?: number) {
  cachedPrivateKey = null
  cachedPublicKey = null
  cachedTokenId = null
  sharedSecretByPeer.clear()
  // Clear from localStorage
  if (tokenId !== undefined) {
    try {
      const all = loadPersistedKeys()
      delete all[tokenId]
      localStorage.setItem(DM_KEYS_STORAGE_KEY, JSON.stringify(all))
    } catch {}
  }
}

/**
 * V1 KDF (legacy): SHA-256 of the full 65-byte uncompressed shared point.
 * Retained ONLY for decrypting existing stored messages.
 * Never call this for new encryptions.
 */
async function _deriveAesKeyV1(sharedPoint: Uint8Array): Promise<CryptoKey> {
  // Hash the full 65-byte uncompressed point (0x04 || x || y)
  const hashBuffer = await crypto.subtle.digest('SHA-256', sharedPoint)
  return crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * V2 KDF (canonical): SHA-256 of the x-coordinate only (bytes 1..32 of the
 * uncompressed point). This is the ANSI X9.63 / RFC 8418 standard.
 */
async function _deriveAesKeyV2(sharedPoint: Uint8Array): Promise<CryptoKey> {
  // Drop the 0x04 prefix byte; take the next 32 bytes (x-coordinate)
  const xCoord = sharedPoint.slice(1, 33)
  const hashBuffer = await crypto.subtle.digest('SHA-256', xCoord)
  return crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * Compute a shared secret via ECDH for a given peer, then derive an
 * AES-256-GCM key. Result is cached by `${peerUserId}:${kdfVersion}` so V1
 * and V2 keys are independent.
 *
 * @param kdfVersion - KDF_VERSION_V1 for legacy decrypt, KDF_VERSION_V2 (default) for new messages
 */
export async function computeSharedSecretForPeer(
  myPrivateKey: Uint8Array,
  peerUserId: number,
  theirPublicKeyHex: string,
  kdfVersion: typeof KDF_VERSION_V1 | typeof KDF_VERSION_V2 = KDF_VERSION_V2,
): Promise<CryptoKey> {
  const cacheKey = `${peerUserId}:${kdfVersion}`
  const cached = sharedSecretByPeer.get(cacheKey)
  if (cached) return cached

  const theirPublicKeyBytes = hexToBytes(theirPublicKeyHex)
  // getSharedSecret returns full 65-byte uncompressed point (0x04 || x || y)
  const sharedPoint = secp256k1.getSharedSecret(myPrivateKey, theirPublicKeyBytes)

  const aesKey = kdfVersion === KDF_VERSION_V1
    ? await _deriveAesKeyV1(sharedPoint)
    : await _deriveAesKeyV2(sharedPoint)

  sharedSecretByPeer.set(cacheKey, aesKey)
  return aesKey
}

/**
 * Backwards-compatible wrapper that takes a conversationId for the cache
 * tag — kept so DM call sites don't all change shape at once. Internally
 * still keys by peer so groups + DMs share AES keys correctly.
 *
 * peerUserId is now required; callers that previously omitted it must
 * supply it (the inbox has it; brand-new conversations seed it via the
 * conversationPeerCache in useDm).
 *
 * Always derives with V2 KDF (x-coord only). Decrypt paths that need to
 * handle legacy ciphertexts call computeSharedSecretForPeer directly with
 * KDF_VERSION_V1.
 */
export async function computeSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKeyHex: string,
  peerUserId: number,
  _conversationIdHint?: string,
): Promise<CryptoKey> {
  void _conversationIdHint
  return computeSharedSecretForPeer(myPrivateKey, peerUserId, theirPublicKeyHex, KDF_VERSION_V2)
}

/**
 * Encrypt the same plaintext once per recipient using per-pair ECDH.
 * Returns { [recipientUserId]: cipher } ready to be POSTed as
 * `recipientPayloads`. Sender's own row is included so they can decrypt
 * their own messages on reload.
 *
 * Self-encryption uses the sender's own publicKey — ECDH(priv, pub) on
 * the same keypair yields a deterministic but valid shared point, so
 * the cipher is recoverable on reload using the same code path.
 */
export async function encryptForRecipients(
  plaintext: string,
  myPrivateKey: Uint8Array,
  members: { userId: number; publicKey: string }[],
): Promise<Record<number, string>> {
  const out: Record<number, string> = {}
  for (const m of members) {
    // Always derive with V2 KDF for new outgoing messages
    const key = await computeSharedSecretForPeer(myPrivateKey, m.userId, m.publicKey, KDF_VERSION_V2)
    out[m.userId] = await encrypt(plaintext, key, KDF_VERSION_V2)
  }
  return out
}

/**
 * Read the kdfVersion byte from a serialised DM ciphertext blob without
 * decrypting it. Returns KDF_VERSION_V1 or KDF_VERSION_V2 if the leading
 * byte is a recognised version, or null for legacy blobs produced before
 * the version byte was added (treated as V1).
 */
export function readKdfVersion(ciphertextBase64: string): typeof KDF_VERSION_V1 | typeof KDF_VERSION_V2 | null {
  try {
    const data = base64ToUint8Array(ciphertextBase64)
    const firstByte = data[0]
    if (firstByte === KDF_VERSION_V1 || firstByte === KDF_VERSION_V2) return firstByte
    return null // legacy: no version byte prefix
  } catch {
    return null
  }
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns base64(kdfVersion[1] || iv[12] || ciphertext+tag).
 *
 * The kdfVersion byte records which KDF was used to derive sharedSecret,
 * so the receiver can select the matching KDF when decrypting.
 * New messages always use KDF_VERSION_V2.
 */
export async function encrypt(
  plaintext: string,
  sharedSecret: CryptoKey,
  kdfVersion: typeof KDF_VERSION_V1 | typeof KDF_VERSION_V2 = KDF_VERSION_V2,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    encoded
  )

  // Concatenate kdfVersion + iv + ciphertext (tag is appended by AES-GCM)
  const result = new Uint8Array(1 + iv.length + ciphertext.byteLength)
  result[0] = kdfVersion
  result.set(iv, 1)
  result.set(new Uint8Array(ciphertext), 1 + iv.length)

  return uint8ArrayToBase64(result)
}

/**
 * Decrypt a DM ciphertext payload using a pre-derived AES-GCM key.
 *
 * Handles two wire formats:
 *   - New (v2): base64(kdfVersion[1] || iv[12] || ciphertext+tag)
 *   - Legacy (pre-version-byte): base64(iv[12] || ciphertext+tag)
 *
 * The caller is responsible for supplying the correct key for the detected
 * version. Use `readKdfVersion` + `computeSharedSecretForPeer` with the
 * matching KDF_VERSION_V* constant to obtain the right key before calling
 * this function. Or use `decryptAutoVersion` for the all-in-one path.
 */
export async function decrypt(ciphertextBase64: string, sharedSecret: CryptoKey): Promise<string> {
  const data = base64ToUint8Array(ciphertextBase64)

  // Detect wire format by inspecting the first byte
  let iv: Uint8Array
  let ciphertext: Uint8Array
  const firstByte = data[0]
  if (firstByte === KDF_VERSION_V1 || firstByte === KDF_VERSION_V2) {
    // New format: skip the version byte
    iv = data.slice(1, 13)
    ciphertext = data.slice(13)
  } else {
    // Legacy format: no version byte — iv starts at byte 0
    iv = data.slice(0, 12)
    ciphertext = data.slice(12)
  }

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    ciphertext
  )

  return new TextDecoder().decode(decrypted)
}

/**
 * Convenience wrapper: detects the KDF version embedded in the ciphertext,
 * derives the correct shared secret, and decrypts in one call.
 *
 * Use this in DM receive paths instead of calling decrypt() directly.
 * Handles both legacy V1 (full-point hash) and current V2 (x-coord hash).
 */
export async function decryptAutoVersion(
  ciphertextBase64: string,
  myPrivateKey: Uint8Array,
  peerUserId: number,
  theirPublicKeyHex: string,
): Promise<string> {
  const detectedVersion = readKdfVersion(ciphertextBase64) ?? KDF_VERSION_V1
  const sharedSecret = await computeSharedSecretForPeer(myPrivateKey, peerUserId, theirPublicKeyHex, detectedVersion)
  return decrypt(ciphertextBase64, sharedSecret)
}

/**
 * Encrypt binary data using AES-256-GCM.
 * Returns Uint8Array(iv || ciphertext || tag).
 */
export async function encryptBinary(data: Uint8Array, sharedSecret: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    data
  )
  const result = new Uint8Array(iv.length + ciphertext.byteLength)
  result.set(iv)
  result.set(new Uint8Array(ciphertext), iv.length)
  return result
}

/**
 * Decrypt binary data (iv || ciphertext || tag) using AES-256-GCM.
 */
export async function decryptBinary(encrypted: Uint8Array, sharedSecret: CryptoKey): Promise<Uint8Array> {
  const iv = encrypted.slice(0, 12)
  const ciphertext = encrypted.slice(12)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    ciphertext
  )
  return new Uint8Array(decrypted)
}

/**
 * Generate a fresh AES-256 key for one-shot use (e.g. encrypting a single
 * attachment binary). Returns both the raw 32-byte material and the
 * imported CryptoKey. The raw bytes get sealed per recipient via
 * `sealKeyForRecipients`; the CryptoKey is what `encryptBinary` consumes.
 *
 * extractable=true on the imported key so the raw form survives a round-
 * trip through web crypto if a caller ever needs to re-derive — but the
 * usual flow keeps the original `raw` and discards the CryptoKey after
 * the binary is encrypted.
 */
export async function generateRandomAesKey(): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { raw, key }
}

/**
 * Seal a raw AES key once per recipient using per-pair ECDH. Output shape
 * matches `encryptForRecipients` (Record<userId, base64Ciphertext>) but
 * the plaintext is 32 random bytes instead of message text. The receiver
 * unseals with their own pair key, then uses the recovered raw key to
 * decrypt the (single, shared) attachment ciphertext.
 *
 * Why per-recipient: same reasoning as text. The image binary is
 * encrypted ONCE with a random key, then the *key* is sealed N times.
 * This is cheap (32 bytes × N) and keeps the storage shape symmetric
 * with text — every recipient extracts their own slot.
 */
export async function sealKeyForRecipients(
  rawKey: Uint8Array,
  myPrivateKey: Uint8Array,
  members: { userId: number; publicKey: string }[],
): Promise<Record<number, string>> {
  // Reuse `encrypt` (which takes a string plaintext) by base64-encoding
  // the raw bytes — keeps the wire format identical to text payloads.
  const rawB64 = uint8ArrayToBase64(rawKey)
  const out: Record<number, string> = {}
  for (const m of members) {
    // Always derive with V2 KDF for new outgoing sealed keys
    const pairKey = await computeSharedSecretForPeer(myPrivateKey, m.userId, m.publicKey, KDF_VERSION_V2)
    out[m.userId] = await encrypt(rawB64, pairKey, KDF_VERSION_V2)
  }
  return out
}

/**
 * Reverse of `sealKeyForRecipients`: unseal the recipient's slot with
 * their pair key, then re-import the raw bytes as an AES-GCM CryptoKey
 * ready for `decryptBinary`.
 */
export async function unsealAttachmentKey(
  sealedBase64: string,
  pairKey: CryptoKey,
): Promise<CryptoKey> {
  const rawB64 = await decrypt(sealedBase64, pairKey)
  const raw = base64ToUint8Array(rawB64)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

// --- Utility functions ---

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
