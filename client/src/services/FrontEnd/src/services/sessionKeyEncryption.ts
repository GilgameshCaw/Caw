/**
 * Session key encryption & cross-tab sync.
 *
 * When the user opts in to "Require wallet unlock each session":
 * - The private key is encrypted with an AES key derived from a deterministic wallet signature
 * - The ciphertext is stored in localStorage (survives restarts, but useless without the wallet)
 * - On page load, the user signs once to decrypt — the plaintext lives only in memory
 * - BroadcastChannel syncs the decrypted key to other same-origin tabs (no extra popups)
 */

const ENCRYPTION_MESSAGE = 'CAW Quick Sign Encryption Key'
const CHANNEL_NAME = 'caw-session-key-sync'
const ALGORITHM = 'AES-GCM'

/** Derive a deterministic AES-256 key from a wallet signature */
async function deriveKey(signature: string): Promise<CryptoKey> {
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
      salt: encoder.encode('caw-session-key-encryption'),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Encrypt a private key string. Returns base64-encoded iv+ciphertext. */
export async function encryptPrivateKey(privateKey: string, walletSignature: string): Promise<string> {
  const key = await deriveKey(walletSignature)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(privateKey)
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoded
  )
  // Concatenate iv + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

/** Decrypt a private key. Returns the plaintext private key string. */
export async function decryptPrivateKey(encryptedData: string, walletSignature: string): Promise<string> {
  const key = await deriveKey(walletSignature)
  const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext
  )
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
        // Another tab sent us the key
        decryptedKeys.set(msg.walletAddress.toLowerCase(), msg.privateKey)
        // Notify any pending resolvers
        const resolver = pendingRequests.get(msg.walletAddress.toLowerCase())
        if (resolver) {
          resolver(msg.privateKey)
          pendingRequests.delete(msg.walletAddress.toLowerCase())
        }
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
