// src/services/InstanceRegistryService/index.ts
//
// On startup, registers this instance in the on-chain CawClientManager
// if not already registered. Stores the instanceId for future updates.

import { z } from 'zod'
import 'dotenv/config'
import { Service } from '../../Service'
import { JsonRpcProvider, Contract, Wallet } from 'ethers'
import { makeJsonRpcProvider } from '../../utils/rpcProvider'
import { cawClientManagerAbi } from '../../abi/generated'
import { CLIENT_MANAGER_ADDRESS } from '../../abi/addresses'

const InstanceRegistryConfig = z.object({
  l1RpcUrl: z.string(),
  clientId: z.number().int(),
  apiUrl: z.string().optional(),
})
type InstanceRegistryConfig = z.infer<typeof InstanceRegistryConfig>

export const instanceRegistryService: Service = {
  name: 'InstanceRegistry',

  validateConfig(raw) {
    const result = InstanceRegistryConfig.safeParse(raw)
    return result.success ? [] : result.error.errors.map(e => new Error(e.message))
  },

  // InstanceRegistry is a one-shot service — registers on startup and then
  // idles. It doesn't declare any heartbeat loops, so the watchdog only
  // monitors it via stats() (which is fine — there's nothing to watch).
  start(rawCfg, _ctx) {
    const cfg = InstanceRegistryConfig.parse(rawCfg)
    const l1RpcUrl = process.env.L1_RPC_URL || cfg.l1RpcUrl
    const clientId = Number(process.env.CLIENT_ID || cfg.clientId)
    const apiUrl = process.env.INSTANCE_API_URL || cfg.apiUrl

    const privateKey = process.env.VALIDATOR_PRIVATE_KEY
    if (!privateKey) {
      console.log('[InstanceRegistry] No VALIDATOR_PRIVATE_KEY — skipping auto-registration')
      return {
        started: Promise.resolve(),
        stop: async () => {},
        stats: async () => ({ registered: false }),
      }
    }

    if (!apiUrl) {
      console.log('[InstanceRegistry] No INSTANCE_API_URL — skipping auto-registration')
      return {
        started: Promise.resolve(),
        stop: async () => {},
        stats: async () => ({ registered: false }),
      }
    }

    let instanceId: number | null = null

    const started = (async () => {
      try {
        const provider = makeJsonRpcProvider(l1RpcUrl)
        const wallet = new Wallet(privateKey, provider)
        const clientManager = new Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi, wallet)

        const validatorAddress = wallet.address
        console.log(`[InstanceRegistry] Checking registration for client ${clientId}, validator ${validatorAddress}, url ${apiUrl}`)

        // Check if this specific (apiUrl, validatorAddress, clientId) combo is already registered.
        // A single validator can run multiple URLs for the same client — each gets its own instanceId.
        // We also check InstanceUpdated events since the URL may have been changed after registration.
        const filter = clientManager.filters.InstanceRegistered(null, clientId)
        const allLogs = await clientManager.queryFilter(filter, 0, 'latest')

        // Build a map of instanceId -> latest apiUrl (accounting for updates)
        const instanceUrls = new Map<number, { apiUrl: string; owner: string; validatorAddress: string }>()
        for (const log of allLogs) {
          const args = (log as any).args
          instanceUrls.set(Number(args.instanceId), {
            apiUrl: args.apiUrl,
            owner: args.owner,
            validatorAddress: args.validatorAddress,
          })
        }

        // Apply InstanceUpdated events
        const updateFilter = clientManager.filters.InstanceUpdated()
        const updateLogs = await clientManager.queryFilter(updateFilter, 0, 'latest')
        for (const log of updateLogs) {
          const args = (log as any).args
          const id = Number(args.instanceId)
          const existing = instanceUrls.get(id)
          if (existing) {
            existing.apiUrl = args.apiUrl
            existing.validatorAddress = args.validatorAddress
          }
        }

        // Find an existing instance that matches our apiUrl AND is owned by us
        let existingInstanceId: number | null = null
        for (const [id, info] of instanceUrls) {
          if (info.apiUrl === apiUrl && info.owner.toLowerCase() === wallet.address.toLowerCase()) {
            existingInstanceId = id
            break
          }
        }

        if (existingInstanceId !== null) {
          instanceId = existingInstanceId
          console.log(`[InstanceRegistry] Already registered as instance #${instanceId} for this URL`)

          // Update validator address if it changed
          const existing = instanceUrls.get(instanceId)!
          if (existing.validatorAddress.toLowerCase() !== validatorAddress.toLowerCase()) {
            console.log(`[InstanceRegistry] Updating validator address on instance #${instanceId}`)
            const updateTx = await clientManager.updateInstance(instanceId, apiUrl, validatorAddress)
            await updateTx.wait()
            console.log(`[InstanceRegistry] Instance #${instanceId} updated`)
          }
        } else {
          // Register new instance — this is a new (url, client) combo
          console.log(`[InstanceRegistry] Registering new instance for client ${clientId}, url ${apiUrl}...`)
          const tx = await clientManager.registerInstance(clientId, apiUrl, validatorAddress)
          const receipt = await tx.wait()

          // Parse the InstanceRegistered event to get the instanceId
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
        }
      } catch (err: any) {
        console.error('[InstanceRegistry] Registration failed (non-fatal):', err.message)
      }
    })()

    return {
      started,
      stop: async () => {
        console.log('[InstanceRegistry] Stopped')
      },
      stats: async () => ({
        registered: instanceId !== null,
        instanceId,
        clientId,
        apiUrl,
      }),
    }
  },
}
