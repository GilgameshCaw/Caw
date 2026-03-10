// src/services/ChainSyncService/index.ts
// Generic service for syncing on-chain data to the database

import { PrismaClient } from '@prisma/client'
import { JsonRpcProvider, Contract } from 'ethers'
import { cawClientManagerAbi } from '../../abi/generated'
import { CLIENT_MANAGER_ADDRESS, CAW_ADDRESS, WETH_ADDRESS } from '../../abi/addresses'

const prisma = new PrismaClient()

// USDT address on Ethereum mainnet
const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

// Uniswap V2 Router ABI (minimal for getAmountsOut)
const UNISWAP_V2_ROUTER_ABI = [
  {
    constant: true,
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' }
    ],
    name: 'getAmountsOut',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    type: 'function'
  }
]

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

// ============================================================================
// Types
// ============================================================================

interface SyncTask {
  name: string
  interval: number // ms
  sync: () => Promise<void>
  lastRun?: number
  timerId?: NodeJS.Timeout
}

interface ChainSyncConfig {
  l1RpcUrl: string        // Ethereum L1 for client data
  l2RpcUrl?: string       // L2 for other data
  ethMainnetRpcUrl?: string // Mainnet for price data
}

interface CachedCawPrice {
  cawPerEth: bigint      // How much CAW per 1 ETH (scaled by 1e18)
  ethPerCaw: bigint      // How much ETH per 1 CAW (in wei)
  updatedAt: number      // Timestamp
}

interface CachedEthPrice {
  ethPerUsd: bigint      // How much ETH per 1 USD (in wei, scaled)
  usdPerEth: bigint      // How much USD per 1 ETH (scaled by 1e6 for USDT decimals)
  updatedAt: number      // Timestamp
}

// ============================================================================
// State
// ============================================================================

let l1Provider: JsonRpcProvider | null = null
let l2Provider: JsonRpcProvider | null = null
let mainnetProvider: JsonRpcProvider | null = null
let clientManager: Contract | null = null
let uniswapRouter: Contract | null = null

const syncTasks: Map<string, SyncTask> = new Map()

// In-memory price caches (also persisted to DB)
let cawPriceCache: CachedCawPrice | null = null
let ethPriceCache: CachedEthPrice | null = null

// ============================================================================
// Provider Initialization
// ============================================================================

function initializeProviders(config: ChainSyncConfig) {
  if (!l1Provider && config.l1RpcUrl) {
    l1Provider = new JsonRpcProvider(config.l1RpcUrl)
    clientManager = new Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi, l1Provider)
  }

  if (!l2Provider && config.l2RpcUrl) {
    l2Provider = new JsonRpcProvider(config.l2RpcUrl)
  }

  if (!mainnetProvider && config.ethMainnetRpcUrl) {
    mainnetProvider = new JsonRpcProvider(config.ethMainnetRpcUrl)
    uniswapRouter = new Contract(UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, mainnetProvider)
  }
}

// ============================================================================
// Client Sync
// ============================================================================

async function syncClient(clientId: number): Promise<boolean> {
  if (!clientManager || !l1Provider) {
    console.error('[ChainSync:Clients] Contract not initialized')
    return false
  }

  try {
    const client = await clientManager.getClient(clientId)

    if (client.ownerAddress === '0x0000000000000000000000000000000000000000') {
      return false
    }

    const replications = await clientManager.getReplications(clientId)
    const replicationEnabled = await clientManager.clientReplicationEnabled(clientId)

    const replicationData = replications.map((r: any) => ({
      eid: Number(r.eid),
      target: r.target
    }))

    const currentBlock = await l1Provider.getBlockNumber()

    await prisma.client.upsert({
      where: { id: clientId },
      update: {
        ownerAddress: client.ownerAddress,
        feeAddress: client.feeAddress,
        mintFee: client.mintFee.toString(),
        depositFee: client.depositFee.toString(),
        withdrawFee: client.withdrawFee.toString(),
        authFee: client.authFee.toString(),
        replicationEnabled: replicationEnabled,
        replicationCount: replicationData.length,
        replications: replicationData,
        lastSyncedAt: new Date(),
        lastSyncedBlock: BigInt(currentBlock)
      },
      create: {
        id: clientId,
        ownerAddress: client.ownerAddress,
        feeAddress: client.feeAddress,
        mintFee: client.mintFee.toString(),
        depositFee: client.depositFee.toString(),
        withdrawFee: client.withdrawFee.toString(),
        authFee: client.authFee.toString(),
        replicationEnabled: replicationEnabled,
        replicationCount: replicationData.length,
        replications: replicationData,
        lastSyncedAt: new Date(),
        lastSyncedBlock: BigInt(currentBlock)
      }
    })

    console.log(`[ChainSync:Clients] Synced client ${clientId}: owner=${client.ownerAddress}, replications=${replicationData.length}`)
    return true
  } catch (err: any) {
    if (err.message?.includes('revert') || err.message?.includes('call revert')) {
      return false
    }
    console.error(`[ChainSync:Clients] Error syncing client ${clientId}:`, err.message)
    return false
  }
}

async function syncAllClients(): Promise<void> {
  console.log('[ChainSync:Clients] Starting sync...')

  let synced = 0
  let consecutiveNotFound = 0
  let clientId = 1
  const MAX_CONSECUTIVE_NOT_FOUND = 10

  while (consecutiveNotFound < MAX_CONSECUTIVE_NOT_FOUND) {
    try {
      const exists = await syncClient(clientId)
      if (exists) {
        synced++
        consecutiveNotFound = 0
      } else {
        consecutiveNotFound++
      }
    } catch (err) {
      consecutiveNotFound++
    }
    clientId++
  }

  console.log(`[ChainSync:Clients] Sync complete: ${synced} clients`)
}

// ============================================================================
// Price Sync
// ============================================================================

async function syncCawPrice(): Promise<void> {
  if (!uniswapRouter) {
    console.log('[ChainSync:Prices] Uniswap router not initialized, skipping CAW price')
    return
  }

  console.log('[ChainSync:Prices] Fetching CAW/ETH price...')

  try {
    // Get price: how much ETH for 1 million CAW (use large amount for precision)
    const cawAmount = BigInt(1_000_000) * BigInt(10 ** 18) // 1M CAW in wei
    const path = [CAW_ADDRESS, WETH_ADDRESS]

    const amounts = await uniswapRouter.getAmountsOut(cawAmount, path)
    const ethOut = BigInt(amounts[1])

    // ethPerCaw = ethOut / 1_000_000 (but we keep it scaled)
    // For 1 CAW (1e18 wei of CAW), how much ETH?
    const ethPerOneCaw = ethOut / BigInt(1_000_000)

    // Reverse: for 1 ETH, how much CAW?
    // cawPerEth = 1e18 * 1e18 / ethPerOneCaw (scaling for precision)
    const oneEth = BigInt(10 ** 18)
    const cawPerOneEth = (oneEth * BigInt(10 ** 18)) / ethPerOneCaw

    cawPriceCache = {
      cawPerEth: cawPerOneEth,
      ethPerCaw: ethPerOneCaw,
      updatedAt: Date.now()
    }

    // Persist to database
    await prisma.chainData.upsert({
      where: { key: 'caw_eth_price' },
      update: {
        value: {
          cawPerEth: cawPerOneEth.toString(),
          ethPerCaw: ethPerOneCaw.toString()
        },
        updatedAt: new Date()
      },
      create: {
        key: 'caw_eth_price',
        value: {
          cawPerEth: cawPerOneEth.toString(),
          ethPerCaw: ethPerOneCaw.toString()
        }
      }
    })

    // Log human-readable prices
    const ethPerCawFloat = Number(ethPerOneCaw) / 1e18
    const cawPerEthFloat = Number(cawPerOneEth) / 1e18
    console.log(`[ChainSync:Prices] 1 CAW = ${ethPerCawFloat.toFixed(12)} ETH`)
    console.log(`[ChainSync:Prices] 1 ETH = ${cawPerEthFloat.toFixed(2)} CAW`)
  } catch (err: any) {
    console.error('[ChainSync:Prices] Failed to fetch CAW price:', err.message)
  }
}

async function syncEthPrice(): Promise<void> {
  if (!uniswapRouter) {
    console.log('[ChainSync:Prices] Uniswap router not initialized, skipping ETH price')
    return
  }

  console.log('[ChainSync:Prices] Fetching ETH/USDT price...')

  try {
    // Get price: how much USDT for 1 ETH
    // USDT has 6 decimals, WETH has 18
    const oneEth = BigInt(10 ** 18)
    const path = [WETH_ADDRESS, USDT_ADDRESS]

    const amounts = await uniswapRouter.getAmountsOut(oneEth, path)
    const usdtOut = BigInt(amounts[1]) // USDT amount (6 decimals)

    // usdPerEth is in USDT units (6 decimals)
    // e.g., if ETH = $2000, usdtOut = 2000_000000 (2000 * 1e6)
    const usdPerEth = usdtOut

    // For ethPerUsd, we need: how much ETH for $1
    // ethPerUsd = 1e18 / (usdPerEth / 1e6) = 1e18 * 1e6 / usdPerEth
    const ethPerUsd = (oneEth * BigInt(10 ** 6)) / usdPerEth

    ethPriceCache = {
      usdPerEth: usdPerEth,
      ethPerUsd: ethPerUsd,
      updatedAt: Date.now()
    }

    // Persist to database
    await prisma.chainData.upsert({
      where: { key: 'eth_usd_price' },
      update: {
        value: {
          usdPerEth: usdPerEth.toString(),
          ethPerUsd: ethPerUsd.toString()
        },
        updatedAt: new Date()
      },
      create: {
        key: 'eth_usd_price',
        value: {
          usdPerEth: usdPerEth.toString(),
          ethPerUsd: ethPerUsd.toString()
        }
      }
    })

    // Log human-readable price
    const usdPerEthFloat = Number(usdPerEth) / 1e6
    console.log(`[ChainSync:Prices] 1 ETH = $${usdPerEthFloat.toFixed(2)} USD`)
  } catch (err: any) {
    console.error('[ChainSync:Prices] Failed to fetch ETH price:', err.message)
  }
}

async function syncPrices(): Promise<void> {
  await syncCawPrice()
  await syncEthPrice()
}

// ============================================================================
// Public API - Price Access
// ============================================================================

/**
 * Get cached CAW to ETH conversion
 * @param cawAmount - Amount of CAW (as raw number, not wei)
 * @returns Amount of ETH in wei, or null if price not cached
 */
export function cawToEthCached(cawAmount: bigint): bigint | null {
  if (!cawPriceCache) return null

  // cawAmount * ethPerCaw (ethPerCaw is already in wei for 1 CAW)
  return cawAmount * cawPriceCache.ethPerCaw
}

/**
 * Get cached ETH to CAW conversion
 * @param ethAmount - Amount of ETH in wei
 * @returns Amount of CAW (as raw number), or null if price not cached
 */
export function ethToCawCached(ethAmount: bigint): bigint | null {
  if (!cawPriceCache) return null

  // ethAmount * cawPerEth / 1e18
  return (ethAmount * cawPriceCache.cawPerEth) / BigInt(10 ** 18)
}

/**
 * Get cached CAW to USD conversion
 * @param cawAmount - Amount of CAW (as raw number, not wei)
 * @returns Amount in USD (scaled by 1e6), or null if price not cached
 */
export function cawToUsdCached(cawAmount: bigint): bigint | null {
  if (!cawPriceCache || !ethPriceCache) return null

  // First convert CAW to ETH, then ETH to USD
  const ethAmount = cawToEthCached(cawAmount)
  if (ethAmount === null) return null

  // ethAmount is in wei (1e18), usdPerEth is scaled by 1e6
  // USD = ethAmount * usdPerEth / 1e18
  return (ethAmount * ethPriceCache.usdPerEth) / BigInt(10 ** 18)
}

/**
 * Get cached USD to CAW conversion
 * @param usdAmount - Amount in USD (scaled by 1e6, e.g., $1.50 = 1500000)
 * @returns Amount of CAW (as raw number), or null if price not cached
 */
export function usdToCawCached(usdAmount: bigint): bigint | null {
  if (!cawPriceCache || !ethPriceCache) return null

  // First convert USD to ETH, then ETH to CAW
  // ethAmount = usdAmount * ethPerUsd / 1e6 (since usdAmount is scaled by 1e6)
  const ethAmount = (usdAmount * ethPriceCache.ethPerUsd) / BigInt(10 ** 6)

  return ethToCawCached(ethAmount)
}

/**
 * Get the cached CAW price data
 */
export function getCawPriceCache(): CachedCawPrice | null {
  return cawPriceCache
}

/**
 * Get the cached ETH price data
 */
export function getEthPriceCache(): CachedEthPrice | null {
  return ethPriceCache
}

/**
 * Check if CAW price cache is fresh (less than maxAge ms old)
 */
export function isCawPriceFresh(maxAgeMs: number = 5 * 60 * 1000): boolean {
  if (!cawPriceCache) return false
  return Date.now() - cawPriceCache.updatedAt < maxAgeMs
}

/**
 * Check if ETH price cache is fresh (less than maxAge ms old)
 */
export function isEthPriceFresh(maxAgeMs: number = 5 * 60 * 1000): boolean {
  if (!ethPriceCache) return false
  return Date.now() - ethPriceCache.updatedAt < maxAgeMs
}

/**
 * Check if all prices are fresh
 */
export function isPriceFresh(maxAgeMs: number = 5 * 60 * 1000): boolean {
  return isCawPriceFresh(maxAgeMs) && isEthPriceFresh(maxAgeMs)
}

/**
 * Load prices from database (for startup)
 */
async function loadPricesFromDb(): Promise<void> {
  try {
    const cawData = await prisma.chainData.findUnique({
      where: { key: 'caw_eth_price' }
    })

    if (cawData?.value) {
      const value = cawData.value as any
      cawPriceCache = {
        cawPerEth: BigInt(value.cawPerEth),
        ethPerCaw: BigInt(value.ethPerCaw),
        updatedAt: cawData.updatedAt.getTime()
      }
      console.log('[ChainSync:Prices] Loaded cached CAW price from database')
    }
  } catch (err: any) {
    console.log('[ChainSync:Prices] No cached CAW price in database')
  }

  try {
    const ethData = await prisma.chainData.findUnique({
      where: { key: 'eth_usd_price' }
    })

    if (ethData?.value) {
      const value = ethData.value as any
      ethPriceCache = {
        usdPerEth: BigInt(value.usdPerEth),
        ethPerUsd: BigInt(value.ethPerUsd),
        updatedAt: ethData.updatedAt.getTime()
      }
      console.log('[ChainSync:Prices] Loaded cached ETH price from database')
    }
  } catch (err: any) {
    console.log('[ChainSync:Prices] No cached ETH price in database')
  }
}

// ============================================================================
// Public API - Client Access
// ============================================================================

/**
 * Force sync a specific client
 */
export async function forceSyncClient(clientId: number, l1RpcUrl: string): Promise<boolean> {
  initializeProviders({ l1RpcUrl })
  return syncClient(clientId)
}

/**
 * Get client from database
 */
export async function getClient(clientId: number) {
  return prisma.client.findUnique({
    where: { id: clientId }
  })
}

/**
 * Get replication count for a client (from cache/db)
 */
export async function getReplicationCount(clientId: number): Promise<number> {
  const client = await getClient(clientId)
  if (!client?.replicationEnabled) return 0
  return client.replicationCount
}

// ============================================================================
// Task Management
// ============================================================================

function registerTask(task: SyncTask) {
  syncTasks.set(task.name, task)
}

function startTask(task: SyncTask) {
  // Run immediately
  task.sync().catch(err => {
    console.error(`[ChainSync:${task.name}] Initial sync failed:`, err.message)
  })

  // Then run on interval
  task.timerId = setInterval(() => {
    task.lastRun = Date.now()
    task.sync().catch(err => {
      console.error(`[ChainSync:${task.name}] Sync failed:`, err.message)
    })
  }, task.interval)
}

function stopTask(task: SyncTask) {
  if (task.timerId) {
    clearInterval(task.timerId)
    task.timerId = undefined
  }
}

// ============================================================================
// Service Export
// ============================================================================

export const chainSyncService = {
  name: 'ChainSyncService',

  validateConfig(cfg: any) {
    const errors: string[] = []
    if (!cfg?.l1RpcUrl) {
      errors.push('l1RpcUrl is required for ChainSyncService')
    }
    return errors
  },

  start(cfg: ChainSyncConfig) {
    console.log('[ChainSync] Starting service...')

    // Initialize providers
    initializeProviders(cfg)

    // Load cached data from DB
    loadPricesFromDb()

    // Register sync tasks
    registerTask({
      name: 'Clients',
      interval: 30 * 60 * 1000, // 30 minutes
      sync: syncAllClients
    })

    // Only register price sync if we have mainnet RPC
    if (cfg.ethMainnetRpcUrl) {
      registerTask({
        name: 'Prices',
        interval: 5 * 60 * 1000, // 5 minutes
        sync: syncPrices
      })
    }

    // Start all tasks
    syncTasks.forEach(task => startTask(task))

    return {
      started: Promise.resolve(),

      async stop() {
        console.log('[ChainSync] Stopping service...')
        syncTasks.forEach(task => stopTask(task))
        syncTasks.clear()
        await prisma.$disconnect()
      },

      stats: async () => {
        const clientCount = await prisma.client.count()
        const replicationEnabledCount = await prisma.client.count({
          where: { replicationEnabled: true }
        })
        const cawPriceAge = cawPriceCache ? Math.floor((Date.now() - cawPriceCache.updatedAt) / 1000) : 'N/A'
        const ethPriceAge = ethPriceCache ? Math.floor((Date.now() - ethPriceCache.updatedAt) / 1000) : 'N/A'
        const ethPrice = ethPriceCache ? `$${(Number(ethPriceCache.usdPerEth) / 1e6).toFixed(2)}` : 'N/A'
        return `Clients: ${clientCount} (${replicationEnabledCount} with replication), ETH: ${ethPrice}, Price ages: CAW ${cawPriceAge}s, ETH ${ethPriceAge}s`
      }
    }
  }
}

// Re-export for backwards compatibility
export { chainSyncService as clientSyncService }
