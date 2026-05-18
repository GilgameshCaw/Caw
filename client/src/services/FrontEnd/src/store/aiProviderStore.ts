import { create } from 'zustand'

// BYOK (bring-your-own-key) AI image provider connection. The key belongs to
// the user and calls go straight from the browser to the provider — it never
// touches our backend (keeps the trustless model intact, no key custody).
//
// Storage policy (#ai-images): in-memory by default so an XSS can't lift the
// key from localStorage on a shared/again-loaded session. Persisted ONLY when
// the user explicitly opts into "remember on this device", and even then just
// their own provider key at their own risk (clear security note in the UI).

export type AIProvider = 'gemini'

const LS_KEY = 'caw.ai.connection'

interface Persisted {
  provider: AIProvider
  apiKey: string
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (p && typeof p.apiKey === 'string' && p.provider === 'gemini') return p
  } catch {
    /* corrupt / unavailable storage — treat as not connected */
  }
  return null
}

interface AIProviderState {
  provider: AIProvider | null
  apiKey: string | null
  /** true when the current key came from / is mirrored to localStorage */
  remembered: boolean
  isConnected: () => boolean
  /** Save the connection. `remember` persists it to this device. */
  connect: (provider: AIProvider, apiKey: string, remember: boolean) => void
  /** Clear in-memory + any persisted copy. */
  disconnect: () => void
}

const persisted = typeof window !== 'undefined' ? loadPersisted() : null

export const useAIProviderStore = create<AIProviderState>((set, get) => ({
  provider: persisted?.provider ?? null,
  apiKey: persisted?.apiKey ?? null,
  remembered: !!persisted,

  isConnected: () => !!get().apiKey && !!get().provider,

  connect: (provider, apiKey, remember) => {
    if (remember) {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ provider, apiKey }))
      } catch {
        /* storage full/blocked — fall back to in-memory only */
      }
    } else {
      try { localStorage.removeItem(LS_KEY) } catch { /* noop */ }
    }
    set({ provider, apiKey, remembered: remember })
  },

  disconnect: () => {
    try { localStorage.removeItem(LS_KEY) } catch { /* noop */ }
    set({ provider: null, apiKey: null, remembered: false })
  },
}))
