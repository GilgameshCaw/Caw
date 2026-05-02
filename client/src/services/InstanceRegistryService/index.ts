// src/services/InstanceRegistryService/index.ts
//
// Two responsibilities:
//
//   1. SELF-REGISTRATION — on startup, if INSTANCE_API_URL is set and we
//      aren't already registered (apiUrl + owner combo), submit a
//      registerInstance() tx so other nodes can route to us.
//
//   2. PEER DISCOVERY — periodically refresh the on-chain registry to a
//      module-scoped cache. Other parts of the system (the redundant-
//      action-broadcast path, the planned /api/instances FE endpoint) read
//      from the cache instead of re-scanning chain on every request.
//
// The on-chain registry stores apiUrl + validatorAddress in event args
// only (CawClientManager.sol comment line 42: "Details live in events to
// minimize L1 gas costs"). So peer discovery means scanning logs, which
// on free RPCs is bounded to ~50K blocks per request — chunked via
// utils/chunkedLogs.

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { Contract, Wallet, AbstractProvider, Interface } from 'ethers'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../../utils/rpcProvider'
import { scanLogsBackward } from '../../utils/chunkedLogs'
import { cawClientManagerAbi } from '../../abi/generated'
import { CLIENT_MANAGER_ADDRESS } from '../../abi/addresses'

const InstanceRegistryConfig = z.object({
  l1RpcUrl: z.string(),
  clientId: z.number().int(),
  apiUrl: z.string().optional(),
  /** How often to refresh the peer list. Defaults to 60s — registrations
   *  are rare so this can be slow. Set lower in tests if needed. */
  pollIntervalMs: z.number().int().positive().optional(),
})
type InstanceRegistryConfig = z.infer<typeof InstanceRegistryConfig>

// =====================================================================
// Module-scoped peer cache. Shared across the process — `/api/instances`
// reads it, redundant-broadcast helpers read it, etc. Keyed by clientId
// because a process is always scoped to one client today, but we keep
// the structure cleanly separable in case that changes.
// =====================================================================

export interface PeerInstance {
  instanceId: number
  clientId: number
  owner: string
  apiUrl: string
  validatorAddress: string
  active: boolean
}

const peerCache = new Map<number /* clientId */, Map<number /* instanceId */, PeerInstance>>()

/** Public read of the cached peer list for a given client. */
export function getPeers(clientId: number): PeerInstance[] {
  const m = peerCache.get(clientId)
  if (!m) return []
  return [...m.values()].sort((a, b) => a.instanceId - b.instanceId)
}

// Apply event scan results into the cache, returning the diff so the
// caller can log "new peer joined" / "peer URL changed" without keeping
// before-state on hand.
function applyToCache(
  clientId: number,
  registered: { instanceId: number; clientId: number; owner: string; apiUrl: string; validatorAddress: string }[],
  updates:    { instanceId: number; apiUrl: string; validatorAddress: string }[],
): { added: PeerInstance[]; changed: PeerInstance[] } {
  const cur = peerCache.get(clientId) ?? new Map<number, PeerInstance>()
  const added: PeerInstance[] = []
  const changed: PeerInstance[] = []

  // Apply registrations first.
  for (const r of registered) {
    const existing = cur.get(r.instanceId)
    if (!existing) {
      const fresh: PeerInstance = { ...r, active: true }
      cur.set(r.instanceId, fresh)
      added.push(fresh)
    }
    // Re-registrations of the same id (shouldn't happen on-chain but be safe)
    // are ignored — InstanceUpdated is the canonical mutation event.
  }

  // Apply updates — these mutate apiUrl / validatorAddress for existing instances.
  for (const u of updates) {
    const existing = cur.get(u.instanceId)
    if (!existing) continue
    if (existing.apiUrl !== u.apiUrl || existing.validatorAddress.toLowerCase() !== u.validatorAddress.toLowerCase()) {
      existing.apiUrl = u.apiUrl
      existing.validatorAddress = u.validatorAddress
      changed.push(existing)
    }
  }

  peerCache.set(clientId, cur)
  return { added, changed }
}

/**
 * Pull every InstanceRegistered + InstanceUpdated event for `clientId`
 * via the chunked log walker and apply them to the peer cache. Returns
 * the diff (added / changed) so callers can log new peers as they appear.
 *
 * Backward scan because we want recent activity first — the cache
 * survives across calls so we don't need to re-pull the full history
 * every poll, but we DO need a deep enough back-walk on a cold start to
 * find the contract's deploy block. scanLogsBackward bails on the first
 * empty window after finding events, so a single full back-walk on
 * cold-start naturally limits to "the chunk containing the deploy."
 */
async function refreshPeers(
  provider: AbstractProvider,
  clientManagerAddress: string,
  clientId: number,
): Promise<{ added: PeerInstance[]; changed: PeerInstance[] }> {
  const iface = new Interface(cawClientManagerAbi)
  const regSig = iface.getEvent('InstanceRegistered')!.topicHash
  const updSig = iface.getEvent('InstanceUpdated')!.topicHash
  const clientIdTopic = '0x' + clientId.toString(16).padStart(64, '0')

  // Filter on (sig, instanceId=ANY, clientId). InstanceRegistered indexes
  // (instanceId, clientId, owner) so we can pin the second topic.
  const regLogs = await scanLogsBackward(provider, clientManagerAddress, [regSig, null, clientIdTopic])
  // InstanceUpdated isn't clientId-indexed (only instanceId is), so we
  // pull all updates and filter client-side.
  const updLogs = await scanLogsBackward(provider, clientManagerAddress, [updSig])

  const registered: any[] = []
  for (const log of regLogs) {
    const parsed = iface.parseLog(log)
    if (!parsed) continue
    registered.push({
      instanceId: Number(parsed.args.instanceId),
      clientId: Number(parsed.args.clientId),
      owner: parsed.args.owner,
      apiUrl: parsed.args.apiUrl,
      validatorAddress: parsed.args.validatorAddress,
    })
  }

  const updates: any[] = []
  for (const log of updLogs) {
    const parsed = iface.parseLog(log)
    if (!parsed) continue
    updates.push({
      instanceId: Number(parsed.args.instanceId),
      apiUrl: parsed.args.apiUrl,
      validatorAddress: parsed.args.validatorAddress,
    })
  }

  return applyToCache(clientId, registered, updates)
}

// =====================================================================
// Service entry point.
// =====================================================================

export const instanceRegistryService: Service = {
  name: 'InstanceRegistry',

  validateConfig(raw) {
    const result = InstanceRegistryConfig.safeParse(raw)
    return result.success ? [] : result.error.errors.map(e => new Error(e.message))
  },

  start(rawCfg, _ctx) {
    const cfg = InstanceRegistryConfig.parse(rawCfg)
    const l1RpcUrl = getL1HttpRpcUrl() || cfg.l1RpcUrl
    const clientId = Number(process.env.CLIENT_ID || cfg.clientId)
    const apiUrl = process.env.INSTANCE_API_URL || cfg.apiUrl
    const pollIntervalMs = cfg.pollIntervalMs ?? 60_000

    const privateKey = process.env.VALIDATOR_PRIVATE_KEY

    // Even without a private key we still want peer discovery — a
    // frontend-api node has no validator wallet but still benefits from
    // knowing about peers so its FE bundle can fall back to them.
    const canRegister = !!(privateKey && apiUrl)
    if (!privateKey) {
      console.log('[InstanceRegistry] No VALIDATOR_PRIVATE_KEY — peer discovery only (no self-registration)')
    } else if (!apiUrl) {
      console.log('[InstanceRegistry] No INSTANCE_API_URL — peer discovery only (no self-registration)')
    }

    let instanceId: number | null = null
    let pollTimer: NodeJS.Timeout | null = null
    let stopped = false

    const provider = makeJsonRpcProvider(l1RpcUrl, 11155111)
    const wallet = canRegister ? new Wallet(privateKey!, provider) : null
    const clientManager = wallet
      ? new Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi, wallet)
      : new Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi, provider)

    /** First refresh: populates the cache. Subsequent refreshes log diffs. */
    async function refreshAndLog() {
      try {
        const { added, changed } = await refreshPeers(provider, CLIENT_MANAGER_ADDRESS, clientId)
        for (const p of added) {
          console.log(
            `[InstanceRegistry] Peer discovered — instance #${p.instanceId} ` +
            `client=${p.clientId} url=${p.apiUrl} validator=${p.validatorAddress}`,
          )
        }
        for (const p of changed) {
          console.log(
            `[InstanceRegistry] Peer updated — instance #${p.instanceId} ` +
            `→ url=${p.apiUrl} validator=${p.validatorAddress}`,
          )
        }
      } catch (err: any) {
        console.warn(`[InstanceRegistry] Peer refresh failed (continuing): ${err.message}`)
      }
    }

    /** Self-registration. Reads the cache populated by refreshAndLog. */
    async function selfRegister() {
      if (!canRegister || !wallet) return
      const validatorAddress = wallet.address
      console.log(`[InstanceRegistry] Checking registration for client ${clientId}, validator ${validatorAddress}, url ${apiUrl}`)

      // Find an existing instance owned by us pointing at our apiUrl.
      const peers = peerCache.get(clientId)
      let existingInstanceId: number | null = null
      let existingPeer: PeerInstance | null = null
      if (peers) {
        for (const p of peers.values()) {
          if (p.apiUrl === apiUrl && p.owner.toLowerCase() === wallet.address.toLowerCase()) {
            existingInstanceId = p.instanceId
            existingPeer = p
            break
          }
        }
      }

      try {
        if (existingInstanceId !== null && existingPeer) {
          instanceId = existingInstanceId
          console.log(`[InstanceRegistry] Already registered as instance #${instanceId} for this URL`)
          if (existingPeer.validatorAddress.toLowerCase() !== validatorAddress.toLowerCase()) {
            console.log(`[InstanceRegistry] Updating validator address on instance #${instanceId}`)
            const updateTx = await clientManager.updateInstance(instanceId, apiUrl, validatorAddress)
            await updateTx.wait()
            console.log(`[InstanceRegistry] Instance #${instanceId} updated`)
          }
        } else {
          console.log(`[InstanceRegistry] Registering new instance for client ${clientId}, url ${apiUrl}...`)
          const tx = await clientManager.registerInstance(clientId, apiUrl, validatorAddress)
          const receipt = await tx.wait()
          const iface = clientManager.interface
          for (const log of receipt.logs) {
            try {
              const parsed = iface.parseLog(log)
              if (parsed?.name === 'InstanceRegistered') {
                instanceId = Number(parsed.args.instanceId)
                break
              }
            } catch { /* not our event */ }
          }
          console.log(`[InstanceRegistry] Registered as instance #${instanceId}`)
          // Refresh again so the new entry lands in the cache without
          // waiting for the next poll tick.
          await refreshAndLog()
        }
      } catch (err: any) {
        console.error('[InstanceRegistry] Self-registration failed (non-fatal):', err.message)
      }
    }

    const started = (async () => {
      await refreshAndLog()
      await selfRegister()
      // Kick off the periodic refresh. Subsequent ticks log only diffs
      // because the cache has the prior state.
      pollTimer = setInterval(() => {
        if (stopped) return
        refreshAndLog().catch(() => { /* logged inside */ })
      }, pollIntervalMs)
    })()

    return {
      started,
      stop: async () => {
        stopped = true
        if (pollTimer) clearInterval(pollTimer)
        console.log('[InstanceRegistry] Stopped')
      },
      stats: async () => ({
        registered: instanceId !== null,
        instanceId,
        clientId,
        apiUrl,
        peerCount: peerCache.get(clientId)?.size ?? 0,
      }),
    }
  },
}
