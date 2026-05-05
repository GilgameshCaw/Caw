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
  /** Which discovery tier produced the current instance list. Useful for
   *  debugging in DevTools — `localStorage` means we haven't refreshed
   *  yet this session, `api` means at least one peer is reachable. */
  loadedFrom: 'localStorage' | 'api' | 'chain' | null
  /** The API host that last successfully responded */
  activeApiHost: string | null
  setActiveApiHost: (host: string) => void
  fetchInstances: (clientId: number) => Promise<void>
  getActiveInstances: () => Instance[]
  getApiHosts: () => string[]
}

// Refresh threshold: if we have an in-memory copy newer than this, skip
// the network. The localStorage tier ignores this — it always returns
// what's persisted, even on a brand-new session (instant first render).
const FRESH_THRESHOLD_MS = 10 * 60 * 1000  // 10 minutes

// localStorage tier: cached peer list survives across sessions. Key is
// scoped by clientId so a multi-client browser doesn't blend lists.
const LS_KEY = (clientId: number) => `caw:instances:${clientId}`
const LS_FRESH_THRESHOLD_MS = 60 * 60 * 1000  // 1h — accept stale data on bootstrap, refresh in background

interface PersistedCache {
  instances: Instance[]
  fetchedAt: number
}

function loadFromLocalStorage(clientId: number): PersistedCache | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(LS_KEY(clientId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedCache
    if (!parsed?.instances || !Array.isArray(parsed.instances)) return null
    return parsed
  } catch {
    return null
  }
}

function saveToLocalStorage(clientId: number, instances: Instance[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LS_KEY(clientId), JSON.stringify({
      instances,
      fetchedAt: Date.now(),
    } satisfies PersistedCache))
  } catch {
    // quota / private mode — fail silently, in-memory cache still works
  }
}

/**
 * Drop on-chain instance entries whose apiUrl is unusable from this
 * browser. The InstanceRegistry is permissionless, so anyone can
 * register an instance with a localhost / dev-port URL during testing
 * — and that entry stays on chain forever. Without this filter, every
 * apiFetch / broadcast / WS connect attempt eventually hits those
 * URLs and either fails (CORS, network unreachable) or — much worse —
 * ends up routing prod traffic through a developer's localhost dev
 * server.
 *
 * Rules (all must pass):
 *   - URL is a syntactically valid http/https URL
 *   - hostname isn't loopback (localhost / 127.* / ::1 / 0.0.0.0)
 *   - if the page itself is served over https, the apiUrl must be
 *     https too (mixed-content would be blocked anyway, but logging
 *     it makes the reason visible in DevTools)
 *
 * Returns the filtered list. Logs the dropped entries once per call
 * so a misregistered instance is debuggable from the console.
 */
function filterUsableInstances(instances: Instance[]): Instance[] {
  if (typeof window === 'undefined') return instances
  const pageIsHttps = window.location.protocol === 'https:'
  const dropped: { reason: string; apiUrl: string; instanceId: number }[] = []
  const ok: Instance[] = []
  for (const inst of instances) {
    let url: URL
    try {
      url = new URL(inst.apiUrl)
    } catch {
      dropped.push({ reason: 'invalid URL', apiUrl: inst.apiUrl, instanceId: inst.instanceId })
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      dropped.push({ reason: `bad protocol ${url.protocol}`, apiUrl: inst.apiUrl, instanceId: inst.instanceId })
      continue
    }
    const host = url.hostname
    if (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.startsWith('127.')
    ) {
      dropped.push({ reason: 'loopback host', apiUrl: inst.apiUrl, instanceId: inst.instanceId })
      continue
    }
    if (pageIsHttps && url.protocol === 'http:') {
      dropped.push({ reason: 'mixed content (http apiUrl on https page)', apiUrl: inst.apiUrl, instanceId: inst.instanceId })
      continue
    }
    ok.push(inst)
  }
  if (dropped.length > 0) {
    console.warn(`[InstanceStore] dropped ${dropped.length} unusable instance(s):`, dropped)
  }
  return ok
}

/**
 * Fetch peer list from a CAW node's /api/instances endpoint. Returns
 * null on any failure (network, non-200, malformed body) so the caller
 * can fall through to the next tier without special-casing.
 */
async function fetchFromApi(host: string, clientId: number): Promise<Instance[] | null> {
  if (!host) return null
  const url = `${host}/api/instances?clientId=${clientId}`
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data?.instances)) return null
    return data.instances.map((i: any) => ({
      instanceId: Number(i.instanceId),
      clientId: Number(data.clientId ?? clientId),
      owner: String(i.owner ?? ''),
      apiUrl: String(i.apiUrl ?? ''),
      validatorAddress: String(i.validatorAddress ?? ''),
      active: i.active !== false,
    } satisfies Instance))
  } catch {
    return null
  }
}

/**
 * Try every host we know about until one's /api/instances responds. We
 * walk in priority order:
 *   1. The currently-configured VITE_API_HOST (if set).
 *   2. Whatever apiUrls were already in the in-memory store (peers we
 *      discovered in a prior session via localStorage).
 * Returns the first successful response — caller falls through to chain
 * scan if we got nothing.
 */
async function fetchFromAnyApi(
  primaryHost: string | null,
  knownHosts: string[],
  clientId: number,
): Promise<Instance[] | null> {
  const tried = new Set<string>()
  const candidates: string[] = []
  if (primaryHost) candidates.push(primaryHost)
  for (const h of knownHosts) {
    if (h && !tried.has(h)) candidates.push(h)
  }
  for (const host of candidates) {
    if (tried.has(host)) continue
    tried.add(host)
    const result = await fetchFromApi(host, clientId)
    if (result) return result
  }
  return null
}

/**
 * Chunked log walker, mirrors the server-side scanLogsForward but
 * adapted for viem (free RPCs cap eth_getLogs at ~50K blocks).
 *
 * Backward walk because we want recent registrations first and stop as
 * soon as we hit an empty window — registrations cluster around the
 * contract's deploy block, not spread across history. 10K blocks per
 * chunk plays nice with publicnode (50K cap) without hammering paid
 * RPCs.
 */
async function chunkedGetLogs(
  publicClient: any,
  args: { event: any; eventArgs: any; address: string },
  opts: { chunkBlocks?: number; maxWindows?: number } = {},
): Promise<any[]> {
  const chunkBlocks = BigInt(opts.chunkBlocks ?? 10_000)
  const maxWindows = opts.maxWindows ?? 30
  const head: bigint = await publicClient.getBlockNumber()
  const all: any[] = []
  let foundAny = false
  let toBlock = head
  for (let i = 0; i < maxWindows; i++) {
    const fromBlock = toBlock > chunkBlocks ? toBlock - chunkBlocks + 1n : 0n
    let logs: any[]
    try {
      logs = await publicClient.getLogs({
        address: args.address,
        event: args.event,
        args: args.eventArgs,
        fromBlock,
        toBlock,
      })
    } catch {
      // Halve and try just the upper half rather than spinning on a
      // problematic chunk.
      try {
        const halfStart = fromBlock + (toBlock - fromBlock) / 2n
        logs = await publicClient.getLogs({
          address: args.address,
          event: args.event,
          args: args.eventArgs,
          fromBlock: halfStart,
          toBlock,
        })
      } catch {
        break
      }
    }
    if (logs.length > 0) foundAny = true
    all.push(...logs)
    if (foundAny && logs.length === 0) break
    if (fromBlock === 0n) break
    toBlock = fromBlock - 1n
  }
  return all
}

async function fetchFromChain(clientId: number): Promise<Instance[] | null> {
  const publicClient = getPublicClient(wagmiConfig, { chainId: sepolia.id })
  if (!publicClient) return null

  try {
    const registeredLogs = await chunkedGetLogs(publicClient, {
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
      eventArgs: { clientId },
    })

    const instanceMap = new Map<number, Instance>()
    for (const log of registeredLogs) {
      const a = (log as any).args
      instanceMap.set(Number(a.instanceId), {
        instanceId: Number(a.instanceId),
        clientId: Number(a.clientId),
        owner: a.owner,
        apiUrl: a.apiUrl,
        validatorAddress: a.validatorAddress,
        active: true,
      })
    }

    if (instanceMap.size === 0) return []

    // Apply InstanceUpdated overrides — not clientId-indexed so we pull
    // all and filter by instanceId membership.
    const updatedLogs = await chunkedGetLogs(publicClient, {
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
      eventArgs: {},
    })
    for (const log of updatedLogs) {
      const a = (log as any).args
      const existing = instanceMap.get(Number(a.instanceId))
      if (existing) {
        existing.apiUrl = a.apiUrl
        existing.validatorAddress = a.validatorAddress
      }
    }

    // Refresh the active flag from on-chain state. instanceActive() is a
    // single SLOAD per instance — even with 100 peers this is <1s.
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
        instance.active = true
      }
    }

    return Array.from(instanceMap.values())
  } catch (err: any) {
    console.warn('[InstanceStore] chain fetch failed:', err?.message)
    return null
  }
}

export const useInstanceStore = create<InstanceState>((set, get) => ({
  instances: [],
  isLoading: false,
  error: null,
  lastFetchedAt: null,
  loadedFrom: null,
  activeApiHost: null,
  setActiveApiHost: (host: string) => set({ activeApiHost: host }),

  fetchInstances: async (clientId: number) => {
    const state = get()

    // In-memory cache: if we refreshed recently for this clientId, skip.
    if (
      state.lastFetchedAt &&
      Date.now() - state.lastFetchedAt < FRESH_THRESHOLD_MS &&
      state.instances.length > 0 &&
      state.instances[0]?.clientId === clientId
    ) {
      return
    }

    // Tier 1: localStorage. Always populates the store immediately if a
    // cached entry exists, so the FE has a peer list to render with on
    // boot. We then fall through to a network refresh in the background.
    const ls = loadFromLocalStorage(clientId)
    if (ls && ls.instances.length > 0) {
      set({
        instances: filterUsableInstances(ls.instances),
        loadedFrom: 'localStorage',
        lastFetchedAt: Date.now() - LS_FRESH_THRESHOLD_MS, // mark stale so the network refresh below proceeds
      })
    }

    set({ isLoading: true, error: null })

    // Tier 2: /api/instances on any known node. Try the configured
    // primary first, then any peer apiUrls we already know about. Even
    // a single round-trip beats a chain scan.
    const knownHosts = (ls?.instances ?? state.instances).map(i => i.apiUrl).filter(Boolean)
    const fromApi = await fetchFromAnyApi(API_HOST || null, knownHosts, clientId)
    if (fromApi) {
      const filtered = filterUsableInstances(fromApi)
      set({
        instances: filtered,
        loadedFrom: 'api',
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      })
      saveToLocalStorage(clientId, filtered)
      return
    }

    // Tier 3: chain scan via viem. Slow on cold start (chunked walk
    // back from head) but works without ANY working CAW node — the
    // scenario for a static-hosted FE on a fresh browser.
    const fromChain = await fetchFromChain(clientId)
    if (fromChain) {
      const filtered = filterUsableInstances(fromChain)
      set({
        instances: filtered,
        loadedFrom: 'chain',
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      })
      saveToLocalStorage(clientId, filtered)
      return
    }

    set({
      isLoading: false,
      error: 'All discovery tiers failed (localStorage / API / chain). Using stale cache if available.',
    })
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
