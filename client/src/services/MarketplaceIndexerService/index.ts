// src/services/MarketplaceIndexerService/index.ts
import 'dotenv/config'
import { z } from 'zod'
import { ethers } from 'ethers'
import { Service } from '../../Service'
import { prisma } from '../../prismaClient'
import { CAW_NAME_MARKETPLACE_ADDRESS, CAW_NAMES_ADDRESS } from '../../abi/addresses'

const Config = z.object({
  l1RpcUrl:            z.string().optional(),
  marketplaceAddress:  z.string().optional(),
  cawNameAddress:      z.string().optional(),
  pollIntervalMs:      z.number().int().positive().default(15000),
})

type Config = z.infer<typeof Config>

// Minimal ABI for the events we care about
const MARKETPLACE_ABI = [
  'event Listed(uint256 indexed listingId, uint32 indexed tokenId, address seller, uint8 listingType, address paymentToken, uint256 startPrice)',
  'event Sale(uint256 indexed listingId, uint32 indexed tokenId, address buyer, uint256 price, address paymentToken)',
  'event BidPlaced(uint256 indexed listingId, address bidder, uint256 amount)',
  'event BidWithdrawn(uint256 indexed listingId, address bidder, uint256 amount)',
  'event ListingCancelled(uint256 indexed listingId)',
  'event AuctionSettled(uint256 indexed listingId, address winner, uint256 price)',
  // Read functions
  'function listings(uint256) view returns (uint32 tokenId, address seller, address paymentToken, uint8 listingType, uint256 startPrice, uint256 endPrice, uint64 startTime, uint64 endTime, uint256 highestBid, address highestBidder, bool active)',
]

const CAWNAME_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]

const LISTING_TYPE_MAP: Record<number, string> = {
  0: 'FIXED',
  1: 'DUTCH_AUCTION',
  2: 'ENGLISH_AUCTION',
}

const PAYMENT_TOKEN_LABELS: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0x56817dc696448135203c0556f702c6a953260411': 'CAW',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
}

function getPaymentLabel(address: string): string {
  return PAYMENT_TOKEN_LABELS[address.toLowerCase()] || address
}

export const marketplaceIndexerService: Service = {
  name: 'MarketplaceIndexer',

  validateConfig(cfg: unknown) {
    const result = Config.safeParse(cfg)
    return result.success
      ? []
      : result.error.errors.map(e => new Error(`ZodError: ${e.message}`))
  },

  start(configParam: unknown) {
    const cfg = Config.parse(configParam)
    const rpcUrl = (process.env.L1_RPC_URL || cfg.l1RpcUrl || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace('/ws/', '/')
    const marketplaceAddress = cfg.marketplaceAddress || CAW_NAME_MARKETPLACE_ADDRESS
    const cawNameAddress = cfg.cawNameAddress || CAW_NAMES_ADDRESS
    const { pollIntervalMs } = cfg

    let alive = true
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const started = (async () => {
      if (!rpcUrl) throw new Error('[MarketplaceIndexer] No L1 RPC URL configured (set L1_RPC_URL env var)')
      await prisma.$connect()
      console.log(`[MarketplaceIndexer] Started — marketplace=${marketplaceAddress}, cawName=${cawNameAddress}, rpc=${rpcUrl.substring(0, 40)}...`)

      const provider = new ethers.JsonRpcProvider(rpcUrl)
      const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider)
      const cawName = new ethers.Contract(cawNameAddress, CAWNAME_TRANSFER_ABI, provider)

      // Track last processed block
      let lastBlock = await getLastProcessedBlock()
      if (lastBlock === 0) {
        // On first run, look back 10000 blocks to catch any existing listings
        const currentBlock = await provider.getBlockNumber()
        lastBlock = Math.max(0, currentBlock - 10000)
        console.log(`[MarketplaceIndexer] First run, scanning from block ${lastBlock} (current: ${currentBlock})`)
      }

      async function poll() {
        if (!alive) return
        try {
          const currentBlock = await provider.getBlockNumber()
          if (currentBlock <= lastBlock) return

          const fromBlock = lastBlock + 1
          const toBlock = Math.min(currentBlock, fromBlock + 2000) // Max 2000 blocks per poll

          // Fetch marketplace events
          const listedFilter = marketplace.filters.Listed()
          const saleFilter = marketplace.filters.Sale()
          const bidFilter = marketplace.filters.BidPlaced()
          const bidWithdrawnFilter = marketplace.filters.BidWithdrawn()
          const cancelledFilter = marketplace.filters.ListingCancelled()
          const settledFilter = marketplace.filters.AuctionSettled()

          console.log(`[MarketplaceIndexer] Polling blocks ${fromBlock}–${toBlock}`)

          const [listed, sales, bids, bidWithdrawals, cancelled, settled] = await Promise.all([
            marketplace.queryFilter(listedFilter, fromBlock, toBlock),
            marketplace.queryFilter(saleFilter, fromBlock, toBlock),
            marketplace.queryFilter(bidFilter, fromBlock, toBlock),
            marketplace.queryFilter(bidWithdrawnFilter, fromBlock, toBlock),
            marketplace.queryFilter(cancelledFilter, fromBlock, toBlock),
            marketplace.queryFilter(settledFilter, fromBlock, toBlock),
          ])

          if (listed.length || sales.length || bids.length || cancelled.length || settled.length) {
            console.log(`[MarketplaceIndexer] Found events: ${listed.length} listed, ${sales.length} sales, ${bids.length} bids, ${cancelled.length} cancelled, ${settled.length} settled`)
          }

          // Process Listed events
          for (const event of listed) {
            const ev = event as ethers.EventLog
            const args = ev.args
            const listingId = Number(args[0])
            const tokenId = Number(args[1])
            const seller = args[2].toLowerCase()
            const listingType = LISTING_TYPE_MAP[Number(args[3])] || 'FIXED'
            const paymentToken = args[4]
            const startPrice = args[5].toString()

            // Read full listing from contract for endPrice, endTime, etc.
            const onChain = await marketplace.listings(listingId)

            // Look up username from our DB
            const user = await prisma.user.findUnique({ where: { tokenId } })
            const username = user?.username || `#${tokenId}`

            await prisma.marketplaceListing.upsert({
              where: { listingId },
              update: {
                status: 'ACTIVE',
                highestBid: onChain.highestBid.toString(),
                highestBidder: onChain.highestBidder === ethers.ZeroAddress ? null : onChain.highestBidder.toLowerCase(),
              },
              create: {
                listingId,
                tokenId,
                seller,
                listingType: listingType as any,
                paymentToken: getPaymentLabel(paymentToken),
                paymentAddress: paymentToken.toLowerCase(),
                startPrice,
                endPrice: onChain.endPrice > 0n ? onChain.endPrice.toString() : null,
                startTime: new Date(Number(onChain.startTime) * 1000),
                endTime: onChain.endTime > 0n ? new Date(Number(onChain.endTime) * 1000) : null,
                username,
                usernameLength: username.startsWith('#') ? 0 : username.length,
                txHash: ev.transactionHash,
              },
            })
          }

          // Process Sale events
          for (const event of sales) {
            const ev = event as ethers.EventLog
            const args = ev.args
            const listingId = Number(args[0])
            const tokenId = Number(args[1])
            const buyerAddr = args[2].toLowerCase()
            const price = args[3].toString()
            const paymentToken = args[4]

            const listing = await prisma.marketplaceListing.findUnique({ where: { listingId } })
            if (listing) {
              await prisma.marketplaceListing.update({
                where: { listingId },
                data: { status: 'SOLD' },
              })

              await prisma.marketplaceSale.upsert({
                where: { listingId: listing.id },
                update: {},
                create: {
                  listingId: listing.id,
                  buyer: buyerAddr,
                  seller: listing.seller,
                  tokenId,
                  price,
                  paymentToken: getPaymentLabel(paymentToken),
                  username: listing.username,
                  txHash: ev.transactionHash,
                },
              })
            }
          }

          // Process BidPlaced events
          for (const event of bids) {
            const ev = event as ethers.EventLog
            const args = ev.args
            const listingId = Number(args[0])
            const bidder = args[1].toLowerCase()
            const amount = args[2].toString()

            const listing = await prisma.marketplaceListing.findUnique({ where: { listingId } })
            if (listing) {
              // Mark previous highest bid as outbid
              await prisma.marketplaceBid.updateMany({
                where: { listingId: listing.id, status: 'ACTIVE' },
                data: { status: 'OUTBID' },
              })

              await prisma.marketplaceBid.create({
                data: {
                  listingId: listing.id,
                  bidder,
                  amount,
                  txHash: ev.transactionHash,
                  status: 'ACTIVE',
                },
              })

              await prisma.marketplaceListing.update({
                where: { listingId },
                data: {
                  highestBid: amount,
                  highestBidder: bidder,
                },
              })
            }
          }

          // Process BidWithdrawn events
          for (const event of bidWithdrawals) {
            const ev = event as ethers.EventLog
            const args = ev.args
            const onChainListingId = Number(args[0])
            const bidder = args[1].toLowerCase()

            const listing = await prisma.marketplaceListing.findUnique({ where: { listingId: onChainListingId } })
            if (listing) {
              await prisma.marketplaceBid.updateMany({
                where: { listingId: listing.id, bidder, status: 'OUTBID' },
                data: { status: 'WITHDRAWN' },
              })
            }
          }

          // Process ListingCancelled events
          for (const event of cancelled) {
            const ev = event as ethers.EventLog
            const onChainListingId = Number(ev.args[0])
            await prisma.marketplaceListing.updateMany({
              where: { listingId: onChainListingId, status: 'ACTIVE' },
              data: { status: 'CANCELLED' },
            })
          }

          // Process AuctionSettled events
          for (const event of settled) {
            const ev = event as ethers.EventLog
            const args = ev.args
            const onChainListingId = Number(args[0])
            const winner = args[1].toLowerCase()
            const price = args[2].toString()

            const listing = await prisma.marketplaceListing.findUnique({ where: { listingId: onChainListingId } })
            if (listing) {
              await prisma.marketplaceListing.update({
                where: { listingId: onChainListingId },
                data: { status: 'SOLD' },
              })

              // Mark winning bid
              await prisma.marketplaceBid.updateMany({
                where: { listingId: listing.id, status: 'ACTIVE' },
                data: { status: 'WON' },
              })

              await prisma.marketplaceSale.upsert({
                where: { listingId: listing.id },
                update: {},
                create: {
                  listingId: listing.id,
                  buyer: winner,
                  seller: listing.seller,
                  tokenId: listing.tokenId,
                  price,
                  paymentToken: listing.paymentToken,
                  username: listing.username,
                  txHash: ev.transactionHash,
                },
              })
            }
          }

          // Check for CawName transfers that invalidate listings
          const transferFilter = cawName.filters.Transfer()
          const transfers = await cawName.queryFilter(transferFilter, fromBlock, toBlock)

          for (const event of transfers) {
            const ev = event as ethers.EventLog
            const tokenId = Number(ev.args[2])
            const to = ev.args[1].toLowerCase()

            // If a listed token is transferred outside the marketplace, mark listing as cancelled
            if (to.toLowerCase() !== marketplaceAddress.toLowerCase()) {
              const activeListing = await prisma.marketplaceListing.findFirst({
                where: { tokenId, status: 'ACTIVE' },
              })
              if (activeListing) {
                const onChainOwner = to
                if (onChainOwner !== activeListing.seller.toLowerCase()) {
                  await prisma.marketplaceListing.update({
                    where: { id: activeListing.id },
                    data: { status: 'CANCELLED' },
                  })
                  console.log(`[MarketplaceIndexer] Token ${tokenId} transferred externally, listing ${activeListing.listingId} cancelled`)
                }
              }
            }
          }

          // Mark expired auctions
          await prisma.marketplaceListing.updateMany({
            where: {
              status: 'ACTIVE',
              listingType: 'ENGLISH_AUCTION',
              endTime: { lt: new Date() },
              highestBidder: null, // No bids — just expired
            },
            data: { status: 'EXPIRED' },
          })

          lastBlock = toBlock
          await saveLastProcessedBlock(toBlock)

        } catch (err) {
          console.error('[MarketplaceIndexer] Poll error:', err)
        } finally {
          if (alive) {
            pollTimer = setTimeout(poll, pollIntervalMs)
          }
        }
      }

      // Start polling
      poll()
    })()

    return {
      started,
      stop: async () => {
        alive = false
        if (pollTimer) clearTimeout(pollTimer)
      },
      stats: async () => {
        const activeListings = await prisma.marketplaceListing.count({ where: { status: 'ACTIVE' } })
        const totalSales = await prisma.marketplaceSale.count()
        return { activeListings, totalSales }
      },
    }
  },
}

async function getLastProcessedBlock(): Promise<number> {
  const data = await prisma.chainData.findUnique({ where: { key: 'marketplace_last_block' } })
  return data ? Number((data.value as any).block || 0) : 0
}

async function saveLastProcessedBlock(block: number): Promise<void> {
  await prisma.chainData.upsert({
    where: { key: 'marketplace_last_block' },
    update: { value: { block } },
    create: { key: 'marketplace_last_block', value: { block } },
  })
}
