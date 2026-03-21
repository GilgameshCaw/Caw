import { create } from 'zustand'
import { API_HOST } from '~/api/client'

interface ClientConfig {
  id: number
  ownerAddress: string
  feeAddress: string
  fees: {
    mint: string
    deposit: string
    withdraw: string
    auth: string
  }
  replication: {
    enabled: boolean
    chainCount: number
    destinations: Array<{ eid: number; target: string }>
  }
  lastSyncedAt: string | null
}

interface ClientConfigState {
  clientConfig: ClientConfig | null
  isLoading: boolean
  error: string | null
  lastFetchedAt: number | null
  fetchClientConfig: (clientId: number) => Promise<void>
  getReplicationChainCount: () => number
}

// Cache duration: 5 minutes
const CACHE_DURATION_MS = 5 * 60 * 1000

export const useClientConfigStore = create<ClientConfigState>((set, get) => ({
  clientConfig: null,
  isLoading: false,
  error: null,
  lastFetchedAt: null,

  fetchClientConfig: async (clientId: number) => {
    const state = get()

    // Check if we have a recent cache
    if (
      state.clientConfig?.id === clientId &&
      state.lastFetchedAt &&
      Date.now() - state.lastFetchedAt < CACHE_DURATION_MS
    ) {
      return // Use cached data
    }

    set({ isLoading: true, error: null })

    const MAX_RETRIES = 4
    const BASE_DELAY = 2000 // 2s, 4s, 8s, 16s

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${API_HOST}/api/clients/${clientId}`)

        if (!response.ok) {
          throw new Error(`Failed to fetch client config: ${response.status}`)
        }

        const config = await response.json()

        set({
          clientConfig: config,
          isLoading: false,
          lastFetchedAt: Date.now()
        })
        return
      } catch (err: any) {
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, attempt)
          console.warn(`[ClientConfig] Fetch failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay / 1000}s...`)
          await new Promise(r => setTimeout(r, delay))
        } else {
          console.error('[ClientConfig] Error fetching client config after retries:', err)
          set({
            error: err.message,
            isLoading: false
          })
        }
      }
    }
  },

  getReplicationChainCount: () => {
    const state = get()
    if (!state.clientConfig?.replication?.enabled) {
      return 0
    }
    return state.clientConfig.replication.chainCount || 0
  }
}))

/**
 * Hook to get the current replication chain count
 * Returns 0 if not loaded or disabled
 */
export function useReplicationChainCount(): number {
  const chainCount = useClientConfigStore(state =>
    state.clientConfig?.replication?.enabled
      ? state.clientConfig.replication.chainCount
      : 0
  )
  return chainCount || 0
}

/**
 * Hook to ensure client config is loaded
 */
export function useClientConfig(clientId: number) {
  const { clientConfig, isLoading, error, fetchClientConfig } = useClientConfigStore()

  // Fetch on mount if not loaded
  if (!clientConfig && !isLoading && !error) {
    fetchClientConfig(clientId)
  }

  return { clientConfig, isLoading, error, refetch: () => fetchClientConfig(clientId) }
}
