// src/services/DmRelayService/index.ts
//
// After a DM is stored locally, relay it to other instances serving the
// same client so the message reaches users regardless of which instance
// they're connected to. Fire-and-forget — best effort delivery.

import 'dotenv/config'
import { Contract } from 'ethers'
import { makeJsonRpcProvider } from '../../utils/rpcProvider'
import { cawClientManagerAbi } from '../../abi/generated'
import { CLIENT_MANAGER_ADDRESS } from '../../abi/addresses'

interface PeerInstance {
  instanceId: number
  apiUrl: string
  validatorAddress: string
}

let peerInstances: PeerInstance[] = []
let lastRefresh = 0
const REFRESH_INTERVAL = 10 * 60 * 1000 // 10 minutes

const clientId = Number(process.env.CLIENT_ID || 1)
const l1RpcUrl = process.env.L1_RPC_URL || ''
const ownApiUrl = process.env.INSTANCE_API_URL || ''

/**
 * Refresh the list of peer instances from on-chain events.
 */
async function refreshPeerInstances(): Promise<void> {
  if (!l1RpcUrl) return
  if (Date.now() - lastRefresh < REFRESH_INTERVAL) return

  try {
    const provider = makeJsonRpcProvider(l1RpcUrl, 11155111)
    const clientManager = new Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi, provider)

    // Fetch InstanceRegistered events for our clientId
    const filter = clientManager.filters.InstanceRegistered(null, clientId)
    const logs = await clientManager.queryFilter(filter, 0, 'latest')

    const instanceMap = new Map<number, PeerInstance>()
    for (const log of logs) {
      const args = (log as any).args
      instanceMap.set(Number(args.instanceId), {
        instanceId: Number(args.instanceId),
        apiUrl: args.apiUrl,
        validatorAddress: args.validatorAddress,
      })
    }

    // Apply updates
    const updateFilter = clientManager.filters.InstanceUpdated()
    const updateLogs = await clientManager.queryFilter(updateFilter, 0, 'latest')
    for (const log of updateLogs) {
      const args = (log as any).args
      const id = Number(args.instanceId)
      const existing = instanceMap.get(id)
      if (existing) {
        existing.apiUrl = args.apiUrl
        existing.validatorAddress = args.validatorAddress
      }
    }

    // Check active state
    for (const [id, instance] of instanceMap) {
      try {
        const isActive = await clientManager.instanceActive(id)
        if (!isActive) instanceMap.delete(id)
      } catch {
        // If read fails, keep it
      }
    }

    // Filter out ourselves
    peerInstances = Array.from(instanceMap.values()).filter(i =>
      i.apiUrl !== ownApiUrl
    )

    lastRefresh = Date.now()
    console.log(`[DmRelay] Refreshed peer instances: ${peerInstances.length} peers`)
  } catch (err: any) {
    console.error('[DmRelay] Failed to refresh peer instances:', err.message)
  }
}

/**
 * Relay a DM message to all peer instances. Fire-and-forget.
 */
export async function relayDmToPeers(params: {
  encryptedPayload: string
  senderId: number
  recipientId: number
  conversationId: string
  contentType?: string
  timestamp: number
  signature: string
  senderAddress: string
}): Promise<void> {
  await refreshPeerInstances()

  if (peerInstances.length === 0) return

  const body = JSON.stringify(params)

  for (const peer of peerInstances) {
    // Fire-and-forget — don't await, don't throw
    fetch(`${peer.apiUrl}/api/dm/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(err => {
      console.warn(`[DmRelay] Failed to relay to ${peer.apiUrl}:`, err.message)
    })
  }
}

/**
 * Get the deterministic conversation ID for two users.
 */
export function deterministicConversationId(userA: number, userB: number): string {
  const min = Math.min(userA, userB)
  const max = Math.max(userA, userB)
  return `dm:${min}:${max}`
}
