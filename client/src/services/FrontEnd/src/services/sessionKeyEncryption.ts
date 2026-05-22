/**
 * Session key encryption & cross-tab sync.
 *
 * When the user opts in to "Require wallet unlock each session":
 * - The private key is encrypted with an AES key derived from a deterministic wallet signature
 * - The ciphertext is stored in localStorage (survives restarts, but useless without the wallet)
 * - On page load, the user signs once to decrypt — the plaintext lives only in memory
 * - BroadcastChannel syncs the decrypted key to other same-origin tabs (no extra popups)
 *
 * Persisted blob versions:
 *   v1 (legacy): base64(iv[12] || ciphertext)          — PBKDF2 with constant salt string
 *   v2 (current): JSON { version:2, salt:base64[16], iv:base64[12], ciphertext:base64 }
 *                  — PBKDF2 with per-record random salt
 *
 * Migration: stored v1 blobs are decrypted using the old constant salt ONE TIME,
 * then re-encrypted and persisted as v2 on the next write. After migration no v1
 * blobs remain. The caller (useSessionKey) triggers the re-write via encryptPrivateKey.
 */

import { requireSecureCrypto } from '~/utils/secureContext'

const ENCRYPTION_MESSAGE = 'CAW Quick Sign Encryption Key'
const CHANNEL_NAME = 'caw-session-key-sync'
const ALGORITHM = 'AES-GCM'

/** Legacy constant salt — used only when decrypting v1 blobs for the one-time migration */
const LEGACY_SALT_STRING = 'caw-session-key-encryption'

/** Derive a deterministic AES-256 key from a wallet signature using a given salt */
async function deriveKeyWithSalt(signature: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signature),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Structured v2 blob stored in localStorage */
interface EncryptedBlobV2 {
  version: 2
  salt: string    // base64-encoded 16-byte random salt
  iv: string      // base64-encoded 12-byte IV
  ciphertext: string // base64-encoded AES-GCM output
}

function blobToBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
}

function base64ToArr(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

/**
 * Encrypt a private key string.
 * Returns a JSON-serialised EncryptedBlobV2 string (version:2 with random salt).
 */
export async function encryptPrivateKey(privateKey: string, walletSignature: string): Promise<string> {
  requireSecureCrypto('Quick Sign encryption')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKeyWithSalt(walletSignature, salt)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(privateKey)
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded)
  const blob: EncryptedBlobV2 = {
    version: 2,
    salt: blobToBase64(salt),
    iv: blobToBase64(iv),
    ciphertext: blobToBase64(new Uint8Array(ciphertext)),
  }
  return JSON.stringify(blob)
}

/**
 * Decrypt a private key.
 * Accepts both v2 JSON blobs and legacy v1 base64 blobs.
 * V1 blobs are decrypted using the old constant salt for one-time back-compat.
 */
export async function decryptPrivateKey(encryptedData: string, walletSignature: string): Promise<string> {
  requireSecureCrypto('Quick Sign encryption')

  // Detect v2 JSON blob
  if (encryptedData.trimStart().startsWith('{')) {
    const blob: EncryptedBlobV2 = JSON.parse(encryptedData)
    const salt = base64ToArr(blob.salt)
    const iv = base64ToArr(blob.iv)
    const ciphertext = base64ToArr(blob.ciphertext)
    const key = await deriveKeyWithSalt(walletSignature, salt)
    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext)
    return new TextDecoder().decode(decrypted)
  }

  // Legacy v1: base64(iv[12] || ciphertext) with constant salt — one-time migration path
  const encoder = new TextEncoder()
  const key = await deriveKeyWithSalt(walletSignature, encoder.encode(LEGACY_SALT_STRING))
  const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext)
  return new TextDecoder().decode(decrypted)
}

/** The deterministic message the wallet signs to produce the encryption key */
export function getEncryptionSignMessage(): string {
  return ENCRYPTION_MESSAGE
}

// ─── BroadcastChannel cross-tab sync ────────────────────────────────

type ChannelMessage =
  | { type: 'request-key'; walletAddress: string }
  | { type: 'key-response'; walletAddress: string; privateKey: string }

let channel: BroadcastChannel | null = null

/** In-memory store of decrypted keys, keyed by lowercase wallet address */
const decryptedKeys = new Map<string, string>()

/**
 * Optional lookup registered by the store layer (avoids circular imports).
 * Returns the stored v2-JSON ciphertext for a given wallet address, or undefined.
 *
 * Call `initBroadcastVerification` once at boot (e.g., in the Zustand store
 * initialiser or a top-level hook) so that key-response messages are
 * cryptographically verified before being accepted into memory.
 */
let _getStoredCiphertext: ((walletAddress: string) => string | undefined) | null = null

/**
 * Register a ciphertext-lookup callback used to verify incoming key-response
 * messages on the BroadcastChannel.
 *
 * Without this, any same-origin tab (including a compromised dependency or
 * service worker) can inject a fake key for any walletAddress.
 *
 * The callback must return the encryptedKey blob stored in sessionKeyStore
 * for the given wallet address.
 */
export function initBroadcastVerification(
  getCiphertext: (walletAddress: string) => string | undefined
) {
  _getStoredCiphertext = getCiphertext
}

/**
 * Attempt to verify a received BroadcastChannel key against the on-disk
 * ciphertext. Returns true only if decryption succeeds.
 *
 * IMPORTANT: This is ONLY called for messages arriving on the channel
 * (i.e., from other tabs). The local `setDecryptedKey` path (from our own
 * successful decrypt) never goes through this check.
 */
async function verifyChannelKey(walletAddress: string, receivedKey: string): Promise<boolean> {
  if (!_getStoredCiphertext) {
    // Lookup not registered yet — conservative: reject to avoid silently accepting
    // unverified keys. Caller should call initBroadcastVerification at boot.
    console.warn('[sessionKeyEncryption] BroadcastChannel verification not initialized; rejecting key-response for', walletAddress)
    return false
  }

  const ciphertext = _getStoredCiphertext(walletAddress)
  if (!ciphertext) {
    // No stored ciphertext for this wallet — nothing to verify against; reject
    console.warn('[sessionKeyEncryption] No stored ciphertext for wallet; rejecting channel key-response for', walletAddress)
    return false
  }

  try {
    // Attempt to decrypt the stored blob with the received key as the "wallet signature".
    // For v2 blobs this calls deriveKeyWithSalt(receivedKey, randomSalt) which will
    // produce the correct AES key if and only if `receivedKey` is the exact same
    // wallet signature used at encrypt-time.
    await decryptPrivateKey(ciphertext, receivedKey)
    return true
  } catch {
    console.warn('[sessionKeyEncryption] Channel key-response failed verification for', walletAddress)
    return false
  }
}

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const msg = event.data
      if (msg.type === 'request-key') {
        // Another tab is asking for the key — respond if we have it
        const key = decryptedKeys.get(msg.walletAddress.toLowerCase())
        if (key) {
          channel!.postMessage({
            type: 'key-response',
            walletAddress: msg.walletAddress.toLowerCase(),
            privateKey: key,
          })
        }
      } else if (msg.type === 'key-response') {
        // H-3 fix: verify the received key matches the stored ciphertext before
        // writing it into memory. Prevents a compromised same-origin tab or
        // malicious dependency from injecting a fake key for any walletAddress.
        const addr = msg.walletAddress.toLowerCase()
        verifyChannelKey(addr, msg.privateKey).then(valid => {
          if (!valid) return
          decryptedKeys.set(addr, msg.privateKey)
          // Notify any pending resolvers
          const resolver = pendingRequests.get(addr)
          if (resolver) {
            resolver(msg.privateKey)
            pendingRequests.delete(addr)
          }
        })
      }
    }
  }
  return channel
}

const pendingRequests = new Map<string, (key: string) => void>()

/** Store a decrypted key in memory and broadcast to other tabs */
export function setDecryptedKey(walletAddress: string, privateKey: string) {
  const addr = walletAddress.toLowerCase()
  decryptedKeys.set(addr, privateKey)
  getChannel().postMessage({
    type: 'key-response',
    walletAddress: addr,
    privateKey,
  })
}

/** Get decrypted key from memory (this tab only, synchronous) */
export function getDecryptedKey(walletAddress: string): string | null {
  return decryptedKeys.get(walletAddress.toLowerCase()) || null
}

/** Request the decrypted key from other tabs. Returns null if no tab responds within timeout. */
export function requestKeyFromOtherTabs(walletAddress: string, timeoutMs = 500): Promise<string | null> {
  const addr = walletAddress.toLowerCase()

  // Check local memory first
  const local = decryptedKeys.get(addr)
  if (local) return Promise.resolve(local)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(addr)
      resolve(null)
    }, timeoutMs)

    pendingRequests.set(addr, (key) => {
      clearTimeout(timer)
      resolve(key)
    })

    getChannel().postMessage({ type: 'request-key', walletAddress: addr })
  })
}

/** Clear decrypted key from memory (e.g., on session revoke) */
export function clearDecryptedKey(walletAddress: string) {
  decryptedKeys.delete(walletAddress.toLowerCase())
}
