import { create } from 'zustand'
import { getPublicClient } from '@wagmi/core'
import { sepolia } from 'wagmi/chains'
import { wagmiConfig } from '~/config/Web3Provider'
import { cawClientManagerAbi } from '~/../../../abi/generated'
import { CLIENT_MANAGER_ADDRESS } from '~/../../../abi/addresses'
import { API_HOST } from '~/api/client'

export interface Instance {
  instanceId: number
  clientId: number
  owner: string
  apiUrl: string
  validatorAddress: string
  active: boolean
}

interface InstanceState {
  instances: Instance[]
  isLoading: boolean
  error: string | null
  lastFetchedAt: number | null
  /** The API host that last successfully responded */
  activeApiHost: string | null
  setActiveApiHost: (host: string) => void
  fetchInstances: (clientId: number) => Promise<void>
  getActiveInstances: () => Instance[]
  getApiHosts: () => string[]
}

// Cache duration: 10 minutes
const CACHE_DURATION_MS = 10 * 60 * 1000

export const useInstanceStore = create<InstanceState>((set, get) => ({
  instances: [],
  isLoading: false,
  error: null,
  lastFetchedAt: null,
  activeApiHost: null,
  setActiveApiHost: (host: string) => set({ activeApiHost: host }),

  fetchInstances: async (clientId: number) => {
    const state = get()

    // Check cache
    if (
      state.lastFetchedAt &&
      Date.now() - state.lastFetchedAt < CACHE_DURATION_MS &&
      state.instances.length > 0 &&
      state.instances[0]?.clientId === clientId
    ) {
      return
    }

    set({ isLoading: true, error: null })

    try {
      const publicClient = getPublicClient(wagmiConfig, { chainId: sepolia.id })
      if (!publicClient) throw new Error('No public client for Sepolia')

      // Fetch all InstanceRegistered events for this clientId
      const registeredLogs = await publicClient.getLogs({
        address: CLIENT_MANAGER_ADDRESS,
        event: {
          type: 'event',
          name: 'InstanceRegistered',
          inputs: [
            { name: 'instanceId', type: 'uint32', indexed: true },
            { name: 'clientId', type: 'uint32', indexed: true },
            { name: 'owner', type: 'address', indexed: true },
            { name: 'apiUrl', type: 'string', indexed: false },
            { name: 'validatorAddress', type: 'address', indexed: false },
          ],
        },
        args: { clientId },
        fromBlock: 0n,
        toBlock: 'latest',
      })

      // Build instance map from registration events
      const instanceMap = new Map<number, Instance>()
      for (const log of registeredLogs) {
        const { instanceId, clientId: cId, owner, apiUrl, validatorAddress } = log.args as any
        instanceMap.set(Number(instanceId), {
          instanceId: Number(instanceId),
          clientId: Number(cId),
          owner,
          apiUrl,
          validatorAddress,
          active: true,
        })
      }

      // Apply updates from InstanceUpdated events
      const updatedLogs = await publicClient.getLogs({
        address: CLIENT_MANAGER_ADDRESS,
        event: {
          type: 'event',
          name: 'InstanceUpdated',
          inputs: [
            { name: 'instanceId', type: 'uint32', indexed: true },
            { name: 'apiUrl', type: 'string', indexed: false },
            { name: 'validatorAddress', type: 'address', indexed: false },
          ],
        },
        fromBlock: 0n,
        toBlock: 'latest',
      })

      for (const log of updatedLogs) {
        const { instanceId, apiUrl, validatorAddress } = log.args as any
        const id = Number(instanceId)
        const existing = instanceMap.get(id)
        if (existing) {
          existing.apiUrl = apiUrl
          existing.validatorAddress = validatorAddress
        }
      }

      // Read the on-chain instanceActive state for each instance
      // This is authoritative — handles deactivations and reactivations correctly
      for (const [id, instance] of instanceMap) {
        try {
          const isActive = await publicClient.readContract({
            address: CLIENT_MANAGER_ADDRESS,
            abi: cawClientManagerAbi,
            functionName: 'instanceActive',
            args: [id],
          })
          instance.active = isActive as boolean
        } catch {
          // If on-chain read fails, assume active (registration event exists)
          instance.active = true
        }
      }

      const instances = Array.from(instanceMap.values())

      set({
        instances,
        isLoading: false,
        lastFetchedAt: Date.now(),
      })
    } catch (err: any) {
      console.warn('[InstanceStore] Failed to fetch instances from chain:', err.message)
      set({
        error: err.message,
        isLoading: false,
      })
    }
  },

  getActiveInstances: () => {
    return get().instances.filter(i => i.active)
  },

  /**
   * Returns ordered list of API hosts for failover.
   * VITE_API_HOST (if set) is always first. On-chain instances follow.
   */
  getApiHosts: () => {
    const active = get().instances.filter(i => i.active)
    const hosts = active.map(i => i.apiUrl)

    // If VITE_API_HOST is set, ensure it's first (deduplicated)
    if (API_HOST) {
      const filtered = hosts.filter(h => h !== API_HOST)
      return [API_HOST, ...filtered]
    }

    return hosts
  },
}))
