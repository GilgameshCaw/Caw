import { secp256k1 } from '@noble/curves/secp256k1'

// Key cache: conversationId -> shared secret (CryptoKey)
const sharedSecretCache = new Map<string, CryptoKey>()

// In-memory private key — never persisted to localStorage
let cachedPrivateKey: Uint8Array | null = null
let cachedPublicKey: string | null = null

/**
 * Derive a deterministic secp256k1 keypair from a wallet signature.
 * The wallet signs a fixed message; SHA-256 of the signature becomes the private key.
 * Same wallet on any domain produces the same keypair.
 */
export async function deriveKeyPair(
  signMessage: (message: string) => Promise<string>,
  tokenId: number
): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  // Return cached if available
  if (cachedPrivateKey && cachedPublicKey) {
    return { privateKey: cachedPrivateKey, publicKeyHex: cachedPublicKey }
  }

  const message = `CAW Protocol DM Key\nUser: ${tokenId}`
  const signature = await signMessage(message)

  // SHA-256 of the signature → 32-byte private key
  const sigBytes = hexToBytes(signature)
  const hashBuffer = await crypto.subtle.digest('SHA-256', sigBytes)
  const privateKey = new Uint8Array(hashBuffer)

  // Derive compressed public key (33 bytes, hex-encoded)
  const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKey, true))

  cachedPrivateKey = privateKey
  cachedPublicKey = publicKeyHex

  return { privateKey, publicKeyHex }
}

/**
 * Check if we have a cached keypair (user has already signed)
 */
export function hasCachedKeyPair(): boolean {
  return cachedPrivateKey !== null && cachedPublicKey !== null
}

/**
 * Get the cached public key hex if available
 */
export function getCachedPublicKeyHex(): string | null {
  return cachedPublicKey
}

/**
 * Clear cached keys (e.g., on disconnect)
 */
export function clearKeyCache() {
  cachedPrivateKey = null
  cachedPublicKey = null
  sharedSecretCache.clear()
}

/**
 * Compute a shared secret via ECDH, then derive an AES-256-GCM key.
 * Result is cached by conversationId.
 */
export async function computeSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKeyHex: string,
  conversationId: string
): Promise<CryptoKey> {
  const cached = sharedSecretCache.get(conversationId)
  if (cached) return cached

  // ECDH: shared point
  const theirPublicKeyBytes = hexToBytes(theirPublicKeyHex)
  const sharedPoint = secp256k1.getSharedSecret(myPrivateKey, theirPublicKeyBytes)

  // SHA-256 of the shared point → 32-byte AES key
  const hashBuffer = await crypto.subtle.digest('SHA-256', sharedPoint)

  const aesKey = await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )

  sharedSecretCache.set(conversationId, aesKey)
  return aesKey
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
