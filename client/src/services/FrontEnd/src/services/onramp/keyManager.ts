/**
 * Onramp EOA key manager.
 *
 * Generates a fresh secp256k1 private key for the card-onramp flow and
 * persists it in localStorage at `caw:onramp-pk:<address>`.
 *
 * This is a Population-A path: once Moonpay delivers ETH to the generated
 * address the user runs mintAndDepositZap with their own funds — no sponsor
 * involved.
 *
 * TODO (pre-prod): encrypt the private key with a passkey + vault-password
 * before this reaches a production audience. The Population-B identity layer
 * in /onboarding already has the Argon2id-encrypted blob infrastructure.
 * Until then, the "back this up" warning surfaces in OnrampOnboarding.tsx.
 *
 * Clearing the onramp key is intentionally NOT wired into StateProvider's
 * disconnect handler here — the key belongs to a generated EOA, not the
 * connected wagmi wallet. Wire it into the global "clear everything" flow
 * when the clear-all-data UI lands.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getJSON, setJSON } from '~/utils/safeStorage'

/** Storage key prefix. Address suffix lets multiple onramp accounts coexist. */
const KEY_PREFIX = 'caw:onramp-pk:'
/** Index of all known onramp addresses so we can list / clear them later. */
const INDEX_KEY = 'caw:onramp-index'

export interface OnrampAccount {
  address: `0x${string}`
  privateKey: `0x${string}`
}

/**
 * Generate a fresh EOA and persist the private key.
 * Returns the account (address + private key).
 */
export function generateOnrampAccount(): OnrampAccount {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const address = account.address

  setJSON(`${KEY_PREFIX}${address.toLowerCase()}`, privateKey)

  // Maintain a flat index so the UI can enumerate all onramp accounts.
  const index = getJSON<string[]>(INDEX_KEY, [])
  const lc = address.toLowerCase()
  if (!index.includes(lc)) {
    setJSON(INDEX_KEY, [...index, lc])
  }

  return { address, privateKey }
}

/**
 * Load a previously-generated onramp private key for a given address.
 * Returns null if not found (e.g. storage was cleared).
 */
export function loadOnrampAccount(address: `0x${string}`): OnrampAccount | null {
  const privateKey = getJSON<string | null>(
    `${KEY_PREFIX}${address.toLowerCase()}`,
    null
  )
  if (!privateKey || !privateKey.startsWith('0x')) return null
  return { address, privateKey: privateKey as `0x${string}` }
}

/**
 * Return all onramp accounts that still have a key in storage.
 * Missing entries (user cleared storage partially) are silently skipped.
 */
export function listOnrampAccounts(): OnrampAccount[] {
  const index = getJSON<string[]>(INDEX_KEY, [])
  const accounts: OnrampAccount[] = []
  for (const lc of index) {
    const privateKey = getJSON<string | null>(`${KEY_PREFIX}${lc}`, null)
    if (privateKey && privateKey.startsWith('0x')) {
      const address = privateKeyToAccount(privateKey as `0x${string}`).address
      accounts.push({ address, privateKey: privateKey as `0x${string}` })
    }
  }
  return accounts
}

/**
 * Wipe a single onramp private key from storage.
 * Called if the user explicitly exports their key and wants to forget it.
 */
export function removeOnrampAccount(address: `0x${string}`): void {
  const lc = address.toLowerCase()
  try {
    localStorage.removeItem(`${KEY_PREFIX}${lc}`)
  } catch {
    /* storage may be unavailable */
  }
  const index = getJSON<string[]>(INDEX_KEY, [])
  setJSON(INDEX_KEY, index.filter(a => a !== lc))
}
