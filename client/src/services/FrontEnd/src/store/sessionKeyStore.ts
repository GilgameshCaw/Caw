import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getDecryptedKey, clearDecryptedKey, initBroadcastVerification } from '~/services/sessionKeyEncryption'

export interface SessionKeyEntry {
  privateKey: `0x${string}`
  address: `0x${string}`
  ownerAddress?: string // wallet address that registered this session
  expiry: number        // unix timestamp (seconds)
  scopeBitmap: number   // uint8 — bits 0-5 for CAW..UNFOLLOW
  spendLimit?: string   // whole CAW tokens as string (for JSON serialization), 0 = unlimited
  spent?: string        // whole CAW tokens spent so far (tracked locally; may under-count on a fresh/roamed device)
  /** Unix ms of the last time `spent` was reconciled against on-chain sessionSpent.
   *  The local counter can start stale-LOW (fresh device, roamed session, cleared
   *  storage) → the submit fast-path would trust it and let an over-limit action
   *  slip through to an on-chain SessionLimitExceeded. If this is missing/older
   *  than a short TTL, the pre-check forces the authoritative read even on the
   *  fast path. */
  spentSyncedAt?: number
  /** Max validator tip per action (whole CAW tokens, string for JSON). 0 = no tip (opt-out).
   *  Locked at session activation to prevent validators from extracting more than the user agreed to. */
  tipCeiling?: string
  /** If true, privateKey in localStorage is encrypted ciphertext — real key is in memory only */
  encrypted?: boolean
  /** The encrypted ciphertext (stored in localStorage when encrypted=true) */
  encryptedKey?: string
  /** True while the on-chain session registration is still in flight (the key was
   *  persisted UP FRONT for durability — so it survives a reload during the ~240s
   *  register poll — but is NOT yet registered on-chain). Signing an action with a
   *  pending key gets a hard 403 "Session key not registered" from the server, so
   *  the action-signing getters (getActiveSession*) MUST skip pending sessions.
   *  Cleared once registration confirms. Presence-only checks (durability, restore,
   *  the UI "is QS on" gate) still see the entry. */
  pending?: boolean
}

interface SessionKeyState {
  /** Sessions keyed by owner wallet address (lowercase) */
  sessions: Record<string, SessionKeyEntry>
  /** Currently active wallet address (lowercase, set by useSessionKeyWalletGuard) */
  activeWallet: string | null
  /** User preference: use session keys or sign every action with wallet */
  enabled: boolean
  /** Whether the user has been shown the Quick Sign prompt (after first stake).
   *  LEGACY / global — kept for migration. Prompt suppression is now per-owner
   *  (dontPromptOwners) so a "don't show again" on one account never silences the
   *  enable-Quick-Sign prompt for a DIFFERENT account that has no session. */
  hasSeenPrompt: boolean
  /** Owner addresses (lowercase) for which the user chose "don't show again" on
   *  the Quick Sign prompt. Per-owner so each account decides independently. */
  dontPromptOwners: Record<string, true>

  /** Get the session for the active wallet */
  getSession: () => SessionKeyEntry | null
  /** Get the session for a specific wallet address */
  getSessionForAddress: (address: string) => SessionKeyEntry | null
  setSession: (entry: SessionKeyEntry) => void
  clearSession: () => void
  /** Clear the Quick Sign session for a SPECIFIC owner address (per-wallet
   *  sign-out), regardless of which wallet is active. */
  clearSessionForAddress: (address: string) => void
  /** Wipe EVERY owner's session. Only for explicit destroy-everything flows
   *  (Clear All Data / deploy-epoch reset) — never as a fallback. */
  clearAllSessions: () => void
  setActiveWallet: (address: string | null) => void
  setEnabled: (enabled: boolean) => void
  setHasSeenPrompt: (seen: boolean) => void
  /** Mark "don't show the Quick Sign prompt again" for a specific owner address. */
  setDontPromptForOwner: (address: string) => void
  /** Whether the user opted out of the Quick Sign prompt for this owner address. */
  isPromptSuppressedForOwner: (address: string) => boolean
  getActiveSession: () => SessionKeyEntry | null
  /** Get active (enabled + non-expired) session for a specific wallet address */
  getActiveSessionForAddress: (address: string) => SessionKeyEntry | null
  /** Check if the active session is encrypted and needs unlocking */
  needsUnlock: () => boolean
  recordSpend: (amount: bigint) => boolean
  getRemainingLimit: () => bigint | null
}

/** Helper: get the session for the current wallet from state, resolving decrypted keys from memory */
function sessionForWallet(state: { sessions: Record<string, SessionKeyEntry>; activeWallet: string | null }): SessionKeyEntry | null {
  if (!state.activeWallet) return null
  const session = state.sessions[state.activeWallet] || null
  if (!session) return null
  if (session.encrypted) {
    const decryptedKey = getDecryptedKey(state.activeWallet)
    if (!decryptedKey) return { ...session, privateKey: '' as `0x${string}` } // key locked
    return { ...session, privateKey: decryptedKey as `0x${string}` }
  }
  return session
}

/**
 * Reactive selector: use this instead of s.session in components.
 * Usage: const session = useSessionKeySession()
 */
export function useSessionKeySession(): SessionKeyEntry | null {
  const sessions = useSessionKeyStore(s => s.sessions)
  const activeWallet = useSessionKeyStore(s => s.activeWallet)
  return sessionForWallet({ sessions, activeWallet })
}

export const useSessionKeyStore = create<SessionKeyState>()(
  persist(
    (set, get) => ({
      sessions: {},
      activeWallet: null,
      enabled: false,
      hasSeenPrompt: false,
      dontPromptOwners: {},

      getSession: () => sessionForWallet(get()),

      getSessionForAddress: (address: string) => {
        const state = get()
        return state.sessions[address.toLowerCase()] || null
      },

      setSession: (entry) => {
        const wallet = (entry.ownerAddress || get().activeWallet || '').toLowerCase()
        if (!wallet) return
        set(state => ({
          sessions: {
            ...state.sessions,
            [wallet]: { spent: '0', ...entry, ownerAddress: wallet },
          },
        }))
      },

      clearSession: () => {
        const wallet = get().activeWallet
        if (wallet) {
          clearDecryptedKey(wallet)
          set(state => {
            const rest = { ...state.sessions }
            delete rest[wallet]
            return { sessions: rest, enabled: false }
          })
        } else {
          // No active wallet → nothing resolvable to clear. This used to fall back
          // to wiping EVERY owner's session, which meant one revoke/disable click
          // while activeWallet happened to be null (e.g. the wallet guard nulls it
          // when no wagmi wallet is connected) silently destroyed all ~N accounts'
          // session keys in the browser — keys that were still live on-chain and,
          // for owners with no roam blob, unrecoverable. Deliberate full wipes must
          // use clearAllSessions() explicitly.
          console.warn('[SessionKeyStore] clearSession() with no active wallet — nothing cleared (use clearAllSessions() for a full wipe)')
        }
      },

      clearAllSessions: () => {
        for (const addr of Object.keys(get().sessions)) clearDecryptedKey(addr)
        set({ sessions: {}, enabled: false, activeWallet: null })
      },

      clearSessionForAddress: (address: string) => {
        const addr = address.toLowerCase()
        clearDecryptedKey(addr)
        set(state => {
          const rest = { ...state.sessions }
          delete rest[addr]
          // Only flip the global enabled flag off if NO sessions remain — other
          // accounts in this browser may still want Quick Sign on.
          const noneLeft = Object.keys(rest).length === 0
          const next: Partial<SessionKeyState> = { sessions: rest }
          if (noneLeft) next.enabled = false
          if (state.activeWallet === addr) next.activeWallet = null
          return next as SessionKeyState
        })
      },

      setActiveWallet: (address) => set({ activeWallet: address?.toLowerCase() || null }),

      setEnabled: (enabled) => set({ enabled }),

      setHasSeenPrompt: (seen) => set({ hasSeenPrompt: seen }),

      setDontPromptForOwner: (address) => {
        const addr = address.toLowerCase()
        set(state => ({ dontPromptOwners: { ...state.dontPromptOwners, [addr]: true } }))
      },

      isPromptSuppressedForOwner: (address) => {
        if (!address) return false
        return !!get().dontPromptOwners[address.toLowerCase()]
      },

      getActiveSession: () => {
        const state = get()
        if (!state.enabled) return null
        const session = sessionForWallet(state)
        if (!session) return null
        // Not usable for signing until on-chain registration confirms — signing
        // with an unregistered key gets a hard 403 "Session key not registered".
        if (session.pending) return null
        if (session.expiry < Date.now() / 1000) {
          state.clearSession()
          return null
        }
        // If encrypted and not yet unlocked, return null (needs unlock first)
        if (session.encrypted && !session.privateKey) return null
        return session
      },

      getActiveSessionForAddress: (address: string) => {
        const state = get()
        // Do NOT gate on the shared global `enabled` flag. Sessions are per-owner;
        // `enabled` is browser-wide and any account's revoke/clear flips it off,
        // which would make a legitimately-sessioned account fall back to wallet
        // signing (the /settings-says-enabled-but-actions-open-wallet split-brain).
        // Presence + non-expiry of THIS owner's session is the source of truth —
        // revoke deletes the key, so a stored session always means "QS on here".
        const raw = state.sessions[address.toLowerCase()] || null
        if (!raw) return null
        // Registration still in flight — the key is persisted for durability but
        // isn't on-chain yet, so signing with it 403s. Treat as not-yet-active.
        if (raw.pending) return null
        if (raw.expiry < Date.now() / 1000) return null
        if (raw.encrypted) {
          const decryptedKey = getDecryptedKey(address)
          if (!decryptedKey) return null // needs unlock
          return { ...raw, privateKey: decryptedKey as `0x${string}` }
        }
        return raw
      },

      needsUnlock: () => {
        const state = get()
        if (!state.enabled || !state.activeWallet) return false
        const raw = state.sessions[state.activeWallet]
        if (!raw || !raw.encrypted) return false
        if (raw.expiry < Date.now() / 1000) return false
        return !getDecryptedKey(state.activeWallet)
      },

      recordSpend: (amount: bigint) => {
        const state = get()
        const session = sessionForWallet(state)
        if (!session) return false

        const limit = BigInt(session.spendLimit || '0')
        const currentSpent = BigInt(session.spent || '0')
        const newSpent = currentSpent + amount

        if (limit !== 0n && newSpent > limit) {
          return false
        }

        // Update the session in-place within the sessions map
        state.setSession({ ...session, spent: newSpent.toString() })
        return true
      },

      getRemainingLimit: () => {
        const state = get()
        const session = sessionForWallet(state)
        if (!session) return null

        const limit = BigInt(session.spendLimit || '0')
        if (limit === 0n) return null

        const spent = BigInt(session.spent || '0')
        const remaining = limit - spent
        return remaining > 0n ? remaining : 0n
      },
    }),
    {
      name: 'caw-session-keys',
      migrate: (persisted: any, version: number) => {
        let state = persisted

        // v0/v1 → v3: single session → per-wallet map
        if (state.session && !state.sessions) {
          const wallet = state.session.ownerAddress?.toLowerCase() || 'legacy'
          state = {
            sessions: { [wallet]: state.session },
            activeWallet: null,
            enabled: state.enabled ?? false,
            hasSeenPrompt: state.hasSeenPrompt ?? false,
          }
        }

        // v3 → v4: sweep expired entries (plaintext private keys must not linger past expiry)
        if (state.sessions) {
          const nowSeconds = Date.now() / 1000
          const pruned: Record<string, SessionKeyEntry> = {}
          for (const [wallet, entry] of Object.entries(state.sessions as Record<string, SessionKeyEntry>)) {
            if ((entry as SessionKeyEntry).expiry >= nowSeconds) {
              pruned[wallet] = entry as SessionKeyEntry
            }
          }
          state = { ...state, sessions: pruned }
        }

        // v4 → v5: introduce per-owner prompt suppression (dontPromptOwners).
        // Deliberately DO NOT seed it from the legacy global hasSeenPrompt — that
        // flag conflated "seen once" with "never prompt", which suppressed the
        // enable-Quick-Sign prompt for accounts that had no session. Starting
        // empty means each account is re-offered Quick Sign until it explicitly
        // opts out, which is the intended behavior.
        if (state && !state.dontPromptOwners) {
          state = { ...state, dontPromptOwners: {} }
        }

        return state
      },
      version: 5,
    }
  )
)

// H-3 fix: register the ciphertext-lookup callback so that incoming
// BroadcastChannel key-response messages are verified against the stored
// ciphertext before being written into the in-memory key map.
// This runs once at module load time (after the store is created).
initBroadcastVerification((walletAddress: string) => {
  const sessions = useSessionKeyStore.getState().sessions
  return sessions[walletAddress.toLowerCase()]?.encryptedKey
})
