// src/services/ChainSyncService/index.ts
// Generic service for syncing on-chain data to the database

import { prisma } from '../../prismaClient'
import { JsonRpcProvider, Contract } from 'ethers'
import { makeJsonRpcProvider, getL1HttpRpcUrl, getL2HttpRpcUrl, getEthMainnetHttpRpcUrl, redactRpcUrl } from '../../utils/rpcProvider'
import { cawNetworkManagerAbi } from '../../abi/generated'
import { NETWORK_MANAGER_ADDRESS, CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'

// Mainnet token addresses for price fetching (distinct from testnet contract addresses)
const MAINNET_CAW_ADDRESS = '0xf3b9569F82B18aEf890De263B84189bd33EBe452'
const MAINNET_WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
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
  console.log('[ChainSync] Initializing providers with config:', {
    l1RpcUrl: redactRpcUrl(config.l1RpcUrl),
    l2RpcUrl: redactRpcUrl(config.l2RpcUrl),
    ethMainnetRpcUrl: redactRpcUrl(config.ethMainnetRpcUrl),
  })

  if (!l1Provider && config.l1RpcUrl) {
    const l1Url = getL1HttpRpcUrl(config.l1RpcUrl)
    console.log('[ChainSync] L1 provider URL:', l1Url.slice(0, 40) + '...')
    l1Provider = makeJsonRpcProvider(l1Url, 11155111)
    clientManager = new Contract(NETWORK_MANAGER_ADDRESS, cawNetworkManagerAbi, l1Provider)
  }

  if (!l2Provider && config.l2RpcUrl) {
    const l2Url = getL2HttpRpcUrl(config.l2RpcUrl)
    console.log('[ChainSync] L2 provider URL:', l2Url.slice(0, 40) + '...')
    l2Provider = makeJsonRpcProvider(l2Url, 84532)
  }

  if (!mainnetProvider && config.ethMainnetRpcUrl) {
    console.log('[ChainSync] Mainnet provider URL:', redactRpcUrl(config.ethMainnetRpcUrl))
    mainnetProvider = makeJsonRpcProvider(config.ethMainnetRpcUrl, 1)
    uniswapRouter = new Contract(UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, mainnetProvider)
  }

  console.log('[ChainSync] Providers initialized:', {
    l1: !!l1Provider,
    l2: !!l2Provider,
    mainnet: !!mainnetProvider,
    uniswapRouter: !!uniswapRouter,
  })
}

// ============================================================================
// Network Sync
// ============================================================================

async function syncNetwork(networkId: number): Promise<boolean> {
  if (!clientManager || !l1Provider) {
    console.error('[ChainSync:Clients] Contract not initialized')
    return false
  }

  try {
    // V2: CawNetworkManager exposes getNetwork(); the struct includes 4 ceiling fields.
    const network = await clientManager.getNetwork(networkId)

    if (network.ownerAddress === '0x0000000000000000000000000000000000000000') {
      return false
    }

    const currentBlock = await l1Provider.getBlockNumber()

    await prisma.network.upsert({
      where: { id: networkId },
      update: {
        ownerAddress: network.ownerAddress,
        feeAddress: network.feeAddress,
        mintFee: network.mintFee.toString(),
        depositFee: network.depositFee.toString(),
        withdrawFee: network.withdrawFee.toString(),
        authFee: network.authFee.toString(),
        withdrawFeeCeiling: BigInt(network.withdrawFeeCeiling?.toString() || '0'),
        depositFeeCeiling:  BigInt(network.depositFeeCeiling?.toString()  || '0'),
        authFeeCeiling:     BigInt(network.authFeeCeiling?.toString()     || '0'),
        mintFeeCeiling:     BigInt(network.mintFeeCeiling?.toString()     || '0'),
        lastSyncedAt: new Date(),
        lastSyncedBlock: BigInt(currentBlock),
      },
      create: {
        id: networkId,
        ownerAddress: network.ownerAddress,
        feeAddress: network.feeAddress,
        mintFee: network.mintFee.toString(),
        depositFee: network.depositFee.toString(),
        withdrawFee: network.withdrawFee.toString(),
        authFee: network.authFee.toString(),
        withdrawFeeCeiling: BigInt(network.withdrawFeeCeiling?.toString() || '0'),
        depositFeeCeiling:  BigInt(network.depositFeeCeiling?.toString()  || '0'),
        authFeeCeiling:     BigInt(network.authFeeCeiling?.toString()     || '0'),
        mintFeeCeiling:     BigInt(network.mintFeeCeiling?.toString()     || '0'),
        creationBlock:      network.creationBlock ? BigInt(network.creationBlock.toString()) : null,
        lastSyncedAt: new Date(),
        lastSyncedBlock: BigInt(currentBlock),
      },
    })

    console.log(`[ChainSync:Clients] Synced network ${networkId}: owner=${network.ownerAddress}`)
    return true
  } catch (err: any) {
    if (err.message?.includes('revert') || err.message?.includes('call revert')) {
      return false
    }
    console.error(`[ChainSync:Clients] Error syncing network ${networkId}:`, err.message)
    return false
  }
}

async function syncAllNetworks(): Promise<void> {
  if (!clientManager || !l1Provider) {
    console.log('[ChainSync:Clients] Skipping — L1 provider not available')
    return
  }

  // Quick check: verify the contract exists at this address on the connected chain
  try {
    const code = await l1Provider.getCode(NETWORK_MANAGER_ADDRESS)
    if (!code || code === '0x') {
      console.log('[ChainSync:Clients] Skipping — CawNetworkManager not deployed on this chain')
      return
    }
  } catch {
    console.log('[ChainSync:Clients] Skipping — unable to verify contract')
    return
  }

  console.log('[ChainSync:Clients] Starting sync...')

  let synced = 0
  let consecutiveNotFound = 0
  let networkId = 1
  const MAX_CONSECUTIVE_NOT_FOUND = 10

  while (consecutiveNotFound < MAX_CONSECUTIVE_NOT_FOUND) {
    try {
      const exists = await syncNetwork(networkId)
      if (exists) {
        synced++
        consecutiveNotFound = 0
      } else {
        consecutiveNotFound++
      }
    } catch (err) {
      consecutiveNotFound++
    }
    networkId++
  }

  console.log(`[ChainSync:Clients] Sync complete: ${synced} networks`)
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
    const path = [MAINNET_CAW_ADDRESS, MAINNET_WETH_ADDRESS]

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
    const path = [MAINNET_WETH_ADDRESS, USDT_ADDRESS]

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

  // Store price snapshots for historical tracking
  if (cawPriceCache && ethPriceCache) {
    try {
      const ethPerCaw = Number(cawPriceCache.ethPerCaw) / 1e18
      const usdPerEth = Number(ethPriceCache.usdPerEth) / 1e6
      const usdPerCaw = ethPerCaw * usdPerEth

      await prisma.priceSnapshot.createMany({
        data: [
          { token: 'caw', usdPrice: usdPerCaw, ethPrice: ethPerCaw },
          { token: 'eth', usdPrice: usdPerEth },
        ]
      })
    } catch (err) {
      console.warn('[ChainSync] Failed to save price snapshot:', err)
    }
  }
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
 * Force sync a specific network (V2: reads CawNetworkManager.getNetwork)
 */
export async function forceSyncNetwork(networkId: number, l1RpcUrl: string): Promise<boolean> {
  initializeProviders({ l1RpcUrl })
  return syncNetwork(networkId)
}

/** @deprecated Use forceSyncNetwork */
export async function forceSyncClient(clientId: number, l1RpcUrl: string): Promise<boolean> {
  return forceSyncNetwork(clientId, l1RpcUrl)
}

/**
 * Get network from database
 */
export async function getNetwork(networkId: number) {
  return prisma.network.findUnique({
    where: { id: networkId }
  })
}

/** @deprecated Use getNetwork */
export async function getClient(networkId: number) {
  return getNetwork(networkId)
}

// ============================================================================
// L2 Event Indexing (SessionKey + NetworkAuth)
// ============================================================================

// CawProfileL2 ABI fragments for event indexing
const CAW_NAME_L2_EVENT_ABI = [
  'event SessionCreated(address indexed owner, address indexed sessionKey, uint64 expiry, uint8 scopeBitmap, uint256 spendLimit, uint64 perActionTipRate)',
  'event SessionRevoked(address indexed owner, address indexed sessionKey)',
  'event Authenticated(uint32 cawClientId, uint32 tokenId)',
] as const

// Key used in the ChainData table to track the last L2 block we indexed up through
const L2_SYNC_BLOCK_KEY = 'l2_events_last_synced_block'
const L2_EVENT_CHUNK_SIZE = 2000 // blocks per getLogs call
const L2_EVENT_BOOTSTRAP_LOOKBACK = 10000 // if no cursor exists, start this many blocks back

async function getLastSyncedL2Block(): Promise<number | null> {
  try {
    const row = await prisma.chainData.findUnique({ where: { key: L2_SYNC_BLOCK_KEY } })
    const value = row?.value as any
    return typeof value?.block === 'number' ? value.block : null
  } catch {
    return null
  }
}

async function setLastSyncedL2Block(block: number): Promise<void> {
  await prisma.chainData.upsert({
    where: { key: L2_SYNC_BLOCK_KEY },
    update: { value: { block } },
    create: { key: L2_SYNC_BLOCK_KEY, value: { block } },
  })
}

async function handleSessionCreated(args: any) {
  const owner = String(args.owner).toLowerCase()
  const sessionAddress = String(args.sessionKey).toLowerCase()
  const expiry = BigInt(args.expiry?.toString() || '0')
  const scopeBitmap = Number(args.scopeBitmap)
  const spendLimit = String(args.spendLimit?.toString() || '0')
  const perActionTipRate = String(args.perActionTipRate?.toString() || '0')

  try {
    await prisma.sessionKey.upsert({
      where: { ownerAddress_sessionAddress: { ownerAddress: owner, sessionAddress } },
      update: {
        expiry,
        scopeBitmap,
        spendLimit,
        perActionTipRate,
        revokedAt: null,      // re-creating a session clears any prior revocation
        spent: '0',           // new session starts with zero spent
        lastSyncedAt: new Date(),
      },
      create: {
        ownerAddress: owner,
        sessionAddress,
        expiry,
        scopeBitmap,
        spendLimit,
        perActionTipRate,
        lastSyncedAt: new Date(),
      },
    })

    // Clear any TxQueue rows held on `pendingQuickSignTxHash` for this
    // (owner, sessionKey) pair: the session has now landed on L2 and the
    // validator can simulate them on the next tick. Mirror of how the
    // PendingMintDeposit watcher clears `pendingDepositTxHash`. Since
    // TxQueue has no owner-address column, key off the matched SessionKey
    // row's tokenId chain (User.address → User.tokenId → TxQueue.senderId).
    try {
      const user = await prisma.user.findFirst({
        where: { address: owner },
        select: { tokenId: true },
      })
      if (user?.tokenId) {
        const cleared = await prisma.txQueue.updateMany({
          where: {
            senderId: user.tokenId,
            pendingQuickSignTxHash: { not: null },
          },
          data: {
            pendingQuickSignTxHash: null,
            // If the row is sitting in waiting_for_deposit purely because of the
            // session leg, promote it back so the validator picks it up.
            // (Rows held for both deposit + session will keep the deposit hold;
            // we only null the session-side flag here.)
          },
        })
        if (cleared.count > 0) {
          console.log(`[ChainSync:L2Events] Cleared pendingQuickSignTxHash on ${cleared.count} TxQueue rows for senderId=${user.tokenId}`)
        }
        // If any of those rows are still in waiting_for_deposit but have no
        // pendingDepositTxHash (i.e. they were held for session only), promote
        // them back to pending now.
        const promoted = await prisma.txQueue.updateMany({
          where: {
            senderId: user.tokenId,
            status: 'waiting_for_deposit',
            pendingDepositTxHash: null,
            pendingQuickSignTxHash: null,
          },
          data: { status: 'pending', reason: null },
        })
        if (promoted.count > 0) {
          console.log(`[ChainSync:L2Events] Promoted ${promoted.count} session-held rows back to pending for senderId=${user.tokenId}`)
        }
      }
    } catch (err: any) {
      console.error(`[ChainSync:L2Events] Failed to clear pendingQuickSignTxHash for ${owner}:`, err.message)
    }
  } catch (err: any) {
    console.error(`[ChainSync:L2Events] Failed to upsert SessionKey for ${owner}/${sessionAddress}:`, err.message)
  }
}

async function handleSessionRevoked(args: any) {
  const owner = String(args.owner).toLowerCase()
  const sessionAddress = String(args.sessionKey).toLowerCase()
  try {
    await prisma.sessionKey.updateMany({
      where: { ownerAddress: owner, sessionAddress, revokedAt: null },
      data: { revokedAt: new Date(), lastSyncedAt: new Date() },
    })
  } catch (err: any) {
    console.error(`[ChainSync:L2Events] Failed to revoke SessionKey for ${owner}/${sessionAddress}:`, err.message)
  }
}

async function handleAuthenticated(args: any) {
  // V2: event field is cawClientId (kept for compatibility); maps to networkId
  const networkId = Number(args.cawClientId ?? args.networkId)
  const tokenId = Number(args.tokenId)
  try {
    await prisma.networkAuth.upsert({
      where: { networkId_tokenId: { networkId, tokenId } },
      update: { authenticated: true, lastSyncedAt: new Date() },
      create: { networkId, tokenId, authenticated: true, lastSyncedAt: new Date() },
    })
  } catch (err: any) {
    console.error(`[ChainSync:L2Events] Failed to upsert NetworkAuth for ${networkId}/${tokenId}:`, err.message)
  }
}

async function syncL2Events(): Promise<void> {
  if (!l2Provider) {
    console.log('[ChainSync:L2Events] Skipping — L2 provider not available')
    return
  }

  const contract = new Contract(CAW_NAMES_L2_ADDRESS, CAW_NAME_L2_EVENT_ABI as any, l2Provider)

  // Determine starting block
  let fromBlock = await getLastSyncedL2Block()
  const latestBlock = await l2Provider.getBlockNumber()

  if (fromBlock === null) {
    fromBlock = Math.max(0, latestBlock - L2_EVENT_BOOTSTRAP_LOOKBACK)
    console.log(`[ChainSync:L2Events] Bootstrapping from block ${fromBlock}`)
  }

  if (fromBlock >= latestBlock) return

  // Scan in chunks — public RPCs often reject getLogs with ranges > 2-5k blocks
  let cursor = fromBlock + 1
  let totalEvents = 0
  while (cursor <= latestBlock) {
    const toBlock = Math.min(cursor + L2_EVENT_CHUNK_SIZE - 1, latestBlock)

    try {
      // Sequential to avoid ethers' RPC batching — see MarketplaceIndexer
      // comment for rationale. Batched member-failures on rate limit are
      // far more painful than a 300ms serial latency hit.
      const created = await contract.queryFilter(contract.filters.SessionCreated(), cursor, toBlock)
      const revoked = await contract.queryFilter(contract.filters.SessionRevoked(), cursor, toBlock)
      const authed = await contract.queryFilter(contract.filters.Authenticated(), cursor, toBlock)

      // Process in block/logIndex order to handle a revoke+create in the same block correctly
      const combined = [
        ...created.map(e => ({ ev: e, kind: 'created' as const })),
        ...revoked.map(e => ({ ev: e, kind: 'revoked' as const })),
        ...authed.map(e => ({ ev: e, kind: 'authed' as const })),
      ].sort((a, b) => {
        if (a.ev.blockNumber !== b.ev.blockNumber) return a.ev.blockNumber - b.ev.blockNumber
        return (a.ev as any).logIndex - (b.ev as any).logIndex
      })

      for (const { ev, kind } of combined) {
        const args = (ev as any).args
        if (!args) continue
        if (kind === 'created') await handleSessionCreated(args)
        else if (kind === 'revoked') await handleSessionRevoked(args)
        else if (kind === 'authed') await handleAuthenticated(args)
      }

      totalEvents += combined.length
      await setLastSyncedL2Block(toBlock)
    } catch (err: any) {
      console.error(`[ChainSync:L2Events] getLogs failed for range ${cursor}-${toBlock}:`, err.message?.slice(0, 200))
      // Break out — next tick will retry from the current cursor
      return
    }

    cursor = toBlock + 1
  }

  if (totalEvents > 0) {
    console.log(`[ChainSync:L2Events] Indexed ${totalEvents} events through block ${latestBlock}`)
  }
}

// ============================================================================
// L1 NetworkManager Fee Event Indexing (V2: NetworkFeeUpdated + ceiling events)
// ============================================================================

// Minimal ABI fragments for the V2 events on CawNetworkManager.
// The full generated ABI is already bound to `clientManager`; we keep a
// separate minimal ABI here so the Contract instance can be created without
// importing the entire generated artifact again.
const NETWORK_FEE_EVENT_ABI = [
  // NetworkCreated carries the full CawNetwork struct (id, storageChainEid, name,
  // feeAddress, ownerAddress, withdrawFee, depositFee, mintFee, authFee,
  // creationBlock, withdrawFeeCeiling, depositFeeCeiling, authFeeCeiling, mintFeeCeiling)
  'event NetworkCreated(uint32 indexed networkId, tuple(uint32 id, uint32 storageChainEid, string name, address feeAddress, address ownerAddress, uint256 withdrawFee, uint256 depositFee, uint256 mintFee, uint256 authFee, uint256 creationBlock, uint256 withdrawFeeCeiling, uint256 depositFeeCeiling, uint256 authFeeCeiling, uint256 mintFeeCeiling) network)',
  'event NetworkFeeUpdated(uint32 indexed networkId, string feeType, uint256 newFee)',
  'event WithdrawFeeCeilingLowered(uint32 indexed networkId, uint256 oldCeiling, uint256 newCeiling)',
  'event DepositFeeCeilingLowered(uint32 indexed networkId, uint256 oldCeiling, uint256 newCeiling)',
  'event AuthFeeCeilingLowered(uint32 indexed networkId, uint256 oldCeiling, uint256 newCeiling)',
  'event MintFeeCeilingLowered(uint32 indexed networkId, uint256 oldCeiling, uint256 newCeiling)',
] as const

const L1_FEE_SYNC_BLOCK_KEY = 'l1_fee_events_last_synced_block'
const L1_FEE_EVENT_CHUNK_SIZE = 2000   // blocks per getLogs call (stays under free-tier 50 K cap)
const L1_FEE_EVENT_BOOTSTRAP_LOOKBACK = 50000 // if no cursor, start this many L1 blocks back

async function getLastSyncedL1FeeBlock(): Promise<number | null> {
  try {
    const row = await prisma.chainData.findUnique({ where: { key: L1_FEE_SYNC_BLOCK_KEY } })
    const value = row?.value as any
    return typeof value?.block === 'number' ? value.block : null
  } catch {
    return null
  }
}

async function setLastSyncedL1FeeBlock(block: number): Promise<void> {
  await prisma.chainData.upsert({
    where: { key: L1_FEE_SYNC_BLOCK_KEY },
    update: { value: { block } },
    create: { key: L1_FEE_SYNC_BLOCK_KEY, value: { block } },
  })
}

// ── Fee-field mapping ─────────────────────────────────────────────────────────
// CawNetworkManager.NetworkFeeUpdated emits feeType as a plain string.
// Map it to the Prisma Network column name.
const FEE_TYPE_TO_COLUMN: Record<string, 'withdrawFee' | 'depositFee' | 'authFee' | 'mintFee'> = {
  withdraw: 'withdrawFee',
  deposit:  'depositFee',
  auth:     'authFee',
  mint:     'mintFee',
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleNetworkCreated(args: any, txHash: string): Promise<void> {
  const networkId = Number(args.networkId)
  const n = args.network
  if (!n) {
    console.warn(`[ChainSync:L1FeeEvents] NetworkCreated: missing network struct for id=${networkId}`)
    return
  }
  try {
    await prisma.network.upsert({
      where: { id: networkId },
      update: {
        ownerAddress:      String(n.ownerAddress).toLowerCase(),
        feeAddress:        String(n.feeAddress).toLowerCase(),
        mintFee:           BigInt(n.mintFee?.toString()    || '0').toString(),
        depositFee:        BigInt(n.depositFee?.toString() || '0').toString(),
        withdrawFee:       BigInt(n.withdrawFee?.toString()|| '0').toString(),
        authFee:           BigInt(n.authFee?.toString()    || '0').toString(),
        withdrawFeeCeiling: BigInt(n.withdrawFeeCeiling?.toString() || '0'),
        depositFeeCeiling:  BigInt(n.depositFeeCeiling?.toString()  || '0'),
        authFeeCeiling:     BigInt(n.authFeeCeiling?.toString()     || '0'),
        mintFeeCeiling:     BigInt(n.mintFeeCeiling?.toString()     || '0'),
        creationBlock:      n.creationBlock ? BigInt(n.creationBlock.toString()) : undefined,
        lastSyncedAt: new Date(),
      },
      create: {
        id:                networkId,
        ownerAddress:      String(n.ownerAddress).toLowerCase(),
        feeAddress:        String(n.feeAddress).toLowerCase(),
        mintFee:           BigInt(n.mintFee?.toString()    || '0').toString(),
        depositFee:        BigInt(n.depositFee?.toString() || '0').toString(),
        withdrawFee:       BigInt(n.withdrawFee?.toString()|| '0').toString(),
        authFee:           BigInt(n.authFee?.toString()    || '0').toString(),
        withdrawFeeCeiling: BigInt(n.withdrawFeeCeiling?.toString() || '0'),
        depositFeeCeiling:  BigInt(n.depositFeeCeiling?.toString()  || '0'),
        authFeeCeiling:     BigInt(n.authFeeCeiling?.toString()     || '0'),
        mintFeeCeiling:     BigInt(n.mintFeeCeiling?.toString()     || '0'),
        creationBlock:      n.creationBlock ? BigInt(n.creationBlock.toString()) : null,
        lastSyncedAt: new Date(),
      },
    })
    console.log(`[ChainSync:L1FeeEvents] NetworkCreated: upserted networkId=${networkId} tx=${txHash.slice(0, 10)}...`)
  } catch (err: any) {
    console.error(`[ChainSync:L1FeeEvents] Failed to upsert NetworkCreated for ${networkId}:`, err.message)
  }
}

async function handleNetworkFeeUpdated(args: any): Promise<void> {
  const networkId = Number(args.networkId)
  const feeType   = String(args.feeType).toLowerCase()
  const newFee    = BigInt(args.newFee?.toString() || '0')
  const column    = FEE_TYPE_TO_COLUMN[feeType]

  if (!column) {
    console.warn(`[ChainSync:L1FeeEvents] NetworkFeeUpdated: unknown feeType="${feeType}" for networkId=${networkId}`)
    return
  }

  try {
    await prisma.network.update({
      where: { id: networkId },
      data:  { [column]: newFee.toString(), lastSyncedAt: new Date() },
    })
    console.log(`[ChainSync:L1FeeEvents] NetworkFeeUpdated: networkId=${networkId} ${column}=${newFee.toString()}`)
  } catch (err: any) {
    if (err.code === 'P2025') {
      // Network row doesn't exist yet — the NetworkCreated event was missed or
      // is in the same chunk after this one. syncAllNetworks() will fill it in.
      console.warn(`[ChainSync:L1FeeEvents] NetworkFeeUpdated: networkId=${networkId} not in DB yet; fee update will be applied on next full sync`)
    } else {
      console.error(`[ChainSync:L1FeeEvents] Failed to update ${column} for networkId=${networkId}:`, err.message)
    }
  }
}

async function handleFeeCeilingLowered(
  args: any,
  ceilingColumn: 'withdrawFeeCeiling' | 'depositFeeCeiling' | 'authFeeCeiling' | 'mintFeeCeiling',
): Promise<void> {
  const networkId  = Number(args.networkId)
  const newCeiling = BigInt(args.newCeiling?.toString() || '0')
  const oldCeiling = BigInt(args.oldCeiling?.toString() || '0')

  try {
    await prisma.network.update({
      where: { id: networkId },
      data:  { [ceilingColumn]: newCeiling, lastSyncedAt: new Date() },
    })
    console.log(`[ChainSync:L1FeeEvents] ${ceilingColumn}: networkId=${networkId}, ${oldCeiling} → ${newCeiling}`)
  } catch (err: any) {
    if (err.code === 'P2025') {
      console.warn(`[ChainSync:L1FeeEvents] ${ceilingColumn}: networkId=${networkId} not in DB yet; ceiling update will be applied on next full sync`)
    } else {
      console.error(`[ChainSync:L1FeeEvents] Failed to update ${ceilingColumn} for networkId=${networkId}:`, err.message)
    }
  }
}

async function syncL1FeeEvents(): Promise<void> {
  if (!l1Provider || !NETWORK_MANAGER_ADDRESS) {
    console.log('[ChainSync:L1FeeEvents] Skipping — L1 provider not available')
    return
  }

  const contract = new Contract(NETWORK_MANAGER_ADDRESS, NETWORK_FEE_EVENT_ABI as any, l1Provider)

  let fromBlock = await getLastSyncedL1FeeBlock()
  const latestBlock = await l1Provider.getBlockNumber()

  if (fromBlock === null) {
    fromBlock = Math.max(0, latestBlock - L1_FEE_EVENT_BOOTSTRAP_LOOKBACK)
    console.log(`[ChainSync:L1FeeEvents] Bootstrapping from block ${fromBlock}`)
  }

  if (fromBlock >= latestBlock) return

  let cursor = fromBlock + 1
  let totalEvents = 0

  while (cursor <= latestBlock) {
    const toBlock = Math.min(cursor + L1_FEE_EVENT_CHUNK_SIZE - 1, latestBlock)

    try {
      const networkCreated  = await contract.queryFilter(contract.filters.NetworkCreated(), cursor, toBlock)
      const feeUpdated      = await contract.queryFilter(contract.filters.NetworkFeeUpdated(), cursor, toBlock)
      const withdrawCeiling = await contract.queryFilter(contract.filters.WithdrawFeeCeilingLowered(), cursor, toBlock)
      const depositCeiling  = await contract.queryFilter(contract.filters.DepositFeeCeilingLowered(), cursor, toBlock)
      const authCeiling     = await contract.queryFilter(contract.filters.AuthFeeCeilingLowered(), cursor, toBlock)
      const mintCeiling     = await contract.queryFilter(contract.filters.MintFeeCeilingLowered(), cursor, toBlock)

      const combined = [
        ...networkCreated.map(e  => ({ ev: e, kind: 'NetworkCreated'           as const })),
        ...feeUpdated.map(e      => ({ ev: e, kind: 'NetworkFeeUpdated'         as const })),
        ...withdrawCeiling.map(e => ({ ev: e, kind: 'WithdrawFeeCeilingLowered' as const })),
        ...depositCeiling.map(e  => ({ ev: e, kind: 'DepositFeeCeilingLowered'  as const })),
        ...authCeiling.map(e     => ({ ev: e, kind: 'AuthFeeCeilingLowered'     as const })),
        ...mintCeiling.map(e     => ({ ev: e, kind: 'MintFeeCeilingLowered'     as const })),
      ].sort((a, b) => {
        if (a.ev.blockNumber !== b.ev.blockNumber) return a.ev.blockNumber - b.ev.blockNumber
        return (a.ev as any).logIndex - (b.ev as any).logIndex
      })

      for (const { ev, kind } of combined) {
        const args = (ev as any).args
        if (!args) continue

        if (kind === 'NetworkCreated') {
          await handleNetworkCreated(args, (ev as any).transactionHash || '')
        } else if (kind === 'NetworkFeeUpdated') {
          await handleNetworkFeeUpdated(args)
        } else if (kind === 'WithdrawFeeCeilingLowered') {
          await handleFeeCeilingLowered(args, 'withdrawFeeCeiling')
        } else if (kind === 'DepositFeeCeilingLowered') {
          await handleFeeCeilingLowered(args, 'depositFeeCeiling')
        } else if (kind === 'AuthFeeCeilingLowered') {
          await handleFeeCeilingLowered(args, 'authFeeCeiling')
        } else if (kind === 'MintFeeCeilingLowered') {
          await handleFeeCeilingLowered(args, 'mintFeeCeiling')
        }
      }

      totalEvents += combined.length
      await setLastSyncedL1FeeBlock(toBlock)
    } catch (err: any) {
      console.error(`[ChainSync:L1FeeEvents] getLogs failed for range ${cursor}-${toBlock}:`, err.message?.slice(0, 200))
      // Break out — next tick will retry from the current cursor
      return
    }

    cursor = toBlock + 1
  }

  if (totalEvents > 0) {
    console.log(`[ChainSync:L1FeeEvents] Indexed ${totalEvents} fee events through block ${latestBlock}`)
  }
}

// ============================================================================
// Task Management
// ============================================================================

function registerTask(task: SyncTask) {
  syncTasks.set(task.name, task)
}

function startTask(task: SyncTask, heartbeat: (loopName?: string) => void) {
  const loopName = `ChainSync:${task.name}`

  // Run immediately
  task.sync().then(() => heartbeat(loopName)).catch(err => {
    console.error(`[ChainSync:${task.name}] Initial sync failed:`, err.message)
  })

  // Then run on interval
  task.timerId = setInterval(() => {
    task.lastRun = Date.now()
    task.sync().then(() => heartbeat(loopName)).catch(err => {
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

  validateConfig() {
    return []
  },

  start(cfg: ChainSyncConfig, ctx: import('../../Service').HeartbeatContext) {
    console.log('[ChainSync] Starting service...')

    // Resolve env vars — config.json may contain "${VAR}" literals.
    // Helpers also wrap the URL with the optional Basic Auth secret when
    // <RPC>_SECRET is set, so backend traffic can bypass an Infura origin
    // allowlist that's locked down for the frontend bundle's safety.
    const resolvedCfg: ChainSyncConfig = {
      // L1 RPC is Sepolia (where CawNetworkManager lives) — NOT mainnet
      l1RpcUrl: getL1HttpRpcUrl() || cfg.l1RpcUrl,
      l2RpcUrl: getL2HttpRpcUrl() || cfg.l2RpcUrl,
      ethMainnetRpcUrl: getEthMainnetHttpRpcUrl(cfg.ethMainnetRpcUrl) || '',
    }

    // Guard against unresolved template strings
    if (resolvedCfg.l1RpcUrl?.includes('${')) resolvedCfg.l1RpcUrl = ''
    if (resolvedCfg.l2RpcUrl?.includes('${')) resolvedCfg.l2RpcUrl = undefined
    if (resolvedCfg.ethMainnetRpcUrl?.includes('${')) resolvedCfg.ethMainnetRpcUrl = undefined

    console.log('[ChainSync] Resolved config:', {
      l1RpcUrl: redactRpcUrl(resolvedCfg.l1RpcUrl),
      l2RpcUrl: redactRpcUrl(resolvedCfg.l2RpcUrl),
      ethMainnetRpcUrl: redactRpcUrl(resolvedCfg.ethMainnetRpcUrl),
    })

    // Initialize providers
    initializeProviders(resolvedCfg)

    // Load cached data from DB
    loadPricesFromDb()

    // Register sync tasks
    registerTask({
      name: 'Clients',
      interval: 30 * 60 * 1000, // 30 minutes
      sync: syncAllNetworks,
    })
    ctx.declareLoop('ChainSync:Clients', 90 * 60_000) // 3× interval

    // V2: poll for NetworkFeeUpdated + *FeeCeilingLowered events from
    // CawNetworkManager on L1. Logs at INFO only for now; cache invalidation
    // is a follow-up. Runs every 5 minutes — fee changes are rare and the
    // L2_EVENT_CHUNK_SIZE cap keeps each call well under the free-tier 50K
    // block getLogs ceiling.
    if (resolvedCfg.l1RpcUrl) {
      registerTask({
        name: 'L1FeeEvents',
        interval: 5 * 60 * 1000, // 5 minutes
        sync: syncL1FeeEvents,
      })
      ctx.declareLoop('ChainSync:L1FeeEvents', 15 * 60_000) // 3× interval
    }

    // Only register price sync if we have mainnet RPC
    if (resolvedCfg.ethMainnetRpcUrl) {
      registerTask({
        name: 'Prices',
        interval: 5 * 60 * 1000, // 5 minutes
        sync: syncPrices
      })
      ctx.declareLoop('ChainSync:Prices', 15 * 60_000) // 3× interval
    }

    // L2 event indexing (SessionKey + ClientAuth) — drives action-submission
    // validation off-chain. Needs to be fresh so users see session creation
    // / revocation reflected quickly.
    if (resolvedCfg.l2RpcUrl) {
      registerTask({
        name: 'L2Events',
        interval: 60 * 1000, // 60 seconds (was 15s — too aggressive for Infura rate limits)
        sync: syncL2Events,
      })
      ctx.declareLoop('ChainSync:L2Events', 4 * 60 * 1000) // 4× interval (240s)
    }

    // Start all tasks
    syncTasks.forEach(task => startTask(task, ctx.heartbeat))

    return {
      started: Promise.resolve(),

      async stop() {
        console.log('[ChainSync] Stopping service...')
        syncTasks.forEach(task => stopTask(task))
        syncTasks.clear()
        await prisma.$disconnect()
      },

      stats: async () => {
        const networkCount = await prisma.network.count()
        const cawPriceAge = cawPriceCache ? Math.floor((Date.now() - cawPriceCache.updatedAt) / 1000) : 'N/A'
        const ethPriceAge = ethPriceCache ? Math.floor((Date.now() - ethPriceCache.updatedAt) / 1000) : 'N/A'
        const ethPrice = ethPriceCache ? `$${(Number(ethPriceCache.usdPerEth) / 1e6).toFixed(2)}` : 'N/A'
        return `Networks: ${networkCount}, ETH: ${ethPrice}, Price ages: CAW ${cawPriceAge}s, ETH ${ethPriceAge}s`
      }
    }
  }
}

// Re-export for backwards compatibility
export { chainSyncService as clientSyncService }
