import { secp256k1 } from '@noble/curves/secp256k1'
import { requireSecureCrypto } from '~/utils/secureContext'

// Shared-secret cache. Keyed by peerUserId so the same key can be reused
// across multiple conversations that share that peer (e.g. a DM with X
// and a group with X — the per-pair ECDH key is identical). Pre-launch
// testnet, so we drop the legacy conversationId-keyed cache wholesale
// rather than dual-write.
const sharedSecretByPeer = new Map<number, CryptoKey>()

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
): Promise<{ privateKey: Uint8Array; publicKeyHex: string; rawSignature?: string; sigMessage?: string; walletProof?: string }> {
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
    sharedSecretByPeer.clear()
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

  // Wallet-signed proof of (userId, publicKey, walletAddress). Travels
  // with the DmIdentity to peer mirrors so they can verify directly
  // against the wallet rather than trusting the source instance.
  // Audit fix 2026-05-09 (Round 7 #1c).
  //
  // Costs ONE extra wallet popup at DM-enable time. Worth it because:
  //   1. Without the proof, any registered instance can forge a
  //      DmIdentity for any user (CL-2 from cross-layer audit).
  //   2. DM-enable is a one-time cost per (wallet, username) pair —
  //      the proof persists and travels with the identity.
  //   3. Users who skip / cancel still get DMs working in DEGRADED mode
  //      (peer mirrors will accept their identity but won't strongly
  //      verify cross-instance) — a strict security mode could later
  //      require it.
  const proofMessage = `CAW DM identity\nuserId:${tokenId}\npublicKey:${publicKeyHex.toLowerCase()}`
  let walletProof: string | undefined
  try {
    walletProof = await signMessage(proofMessage)
  } catch {
    walletProof = undefined
  }

  cachedPrivateKey = privateKey
  cachedPublicKey = publicKeyHex
  cachedTokenId = tokenId
  persistKeys()

  return { privateKey, publicKeyHex, rawSignature: signature, sigMessage: message, walletProof }
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
 * Compute a shared secret via ECDH for a given peer, then derive an
 * AES-256-GCM key. Result is cached by peerUserId so a DM and a group
 * that both involve the same peer reuse the key.
 */
export async function computeSharedSecretForPeer(
  myPrivateKey: Uint8Array,
  peerUserId: number,
  theirPublicKeyHex: string,
): Promise<CryptoKey> {
  const cached = sharedSecretByPeer.get(peerUserId)
  if (cached) return cached

  const theirPublicKeyBytes = hexToBytes(theirPublicKeyHex)
  const sharedPoint = secp256k1.getSharedSecret(myPrivateKey, theirPublicKeyBytes)
  const hashBuffer = await crypto.subtle.digest('SHA-256', sharedPoint)

  const aesKey = await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )

  sharedSecretByPeer.set(peerUserId, aesKey)
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
 */
export async function computeSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKeyHex: string,
  peerUserId: number,
  _conversationIdHint?: string,
): Promise<CryptoKey> {
  void _conversationIdHint
  return computeSharedSecretForPeer(myPrivateKey, peerUserId, theirPublicKeyHex)
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
    const key = await computeSharedSecretForPeer(myPrivateKey, m.userId, m.publicKey)
    out[m.userId] = await encrypt(plaintext, key)
  }
  return out
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns base64(iv || ciphertext || tag).
 */
export async function encrypt(plaintext: string, sharedSecret: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    encoded
  )

  // Concatenate iv + ciphertext (tag is appended by AES-GCM)
  const result = new Uint8Array(iv.length + ciphertext.byteLength)
  result.set(iv)
  result.set(new Uint8Array(ciphertext), iv.length)

  return uint8ArrayToBase64(result)
}

/**
 * Decrypt ciphertext (base64(iv || ciphertext || tag)) using AES-256-GCM.
 */
export async function decrypt(ciphertextBase64: string, sharedSecret: CryptoKey): Promise<string> {
  const data = base64ToUint8Array(ciphertextBase64)

  const iv = data.slice(0, 12)
  const ciphertext = data.slice(12)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    sharedSecret,
    ciphertext
  )

  return new TextDecoder().decode(decrypted)
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
