// src/services/MarketplaceIndexerService/index.ts
import 'dotenv/config'
import { z } from 'zod'
import { ethers } from 'ethers'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../../utils/rpcProvider'
import { Service } from '../../Service'
import { prisma } from '../../prismaClient'
import { CAW_NAME_MARKETPLACE_ADDRESS, CAW_NAMES_ADDRESS } from '../../abi/addresses'

const Config = z.object({
  l1RpcUrl:            z.string().optional(),
  marketplaceAddress:  z.string().optional(),
  cawProfileAddress:      z.string().optional(),
  pollIntervalMs:      z.number().int().positive().default(60000),
})

type Config = z.infer<typeof Config>

// Minimal ABI for the events we care about
const MARKETPLACE_ABI = [
  'event Listed(uint256 indexed listingId, uint32 indexed tokenId, address seller, uint8 listingType, address paymentToken, uint256 startPrice)',
  'event Sale(uint256 indexed listingId, uint32 indexed tokenId, address buyer, uint256 price, address paymentToken)',
  'event BidPlaced(uint256 indexed listingId, address bidder, uint256 amount)',
  'event BidWithdrawn(uint256 indexed listingId, address bidder, uint256 amount)',
  'event BidReclaimed(uint256 indexed listingId, address bidder, uint256 amount)',
  'event ListingCancelled(uint256 indexed listingId)',
  'event AuctionSettled(uint256 indexed listingId, address winner, uint256 price)',
  'event OfferCreated(uint256 indexed offerId, uint32 indexed tokenId, address offerer, address paymentToken, uint256 amount, uint64 expiry)',
  'event OfferAccepted(uint256 indexed offerId, uint32 indexed tokenId, address seller, address buyer, uint256 price, address paymentToken)',
  'event OfferCancelled(uint256 indexed offerId)',
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

  start(configParam: unknown, ctx: import('../../Service').HeartbeatContext) {
    const cfg = Config.parse(configParam)
    ctx.declareLoop('poll', Math.max((cfg as any).pollIntervalMs * 3, 120_000))
    const rpcUrl = getL1HttpRpcUrl(cfg.l1RpcUrl)
    const marketplaceAddress = cfg.marketplaceAddress || CAW_NAME_MARKETPLACE_ADDRESS
    const cawProfileAddress = cfg.cawProfileAddress || CAW_NAMES_ADDRESS
    const { pollIntervalMs } = cfg

    let alive = true
    let pollTimer: ReturnType<typeof setTimeout> | null = null

    const started = (async () => {
      if (!rpcUrl) throw new Error('[MarketplaceIndexer] No L1 RPC URL configured (set L1_RPC_URL env var)')
      await prisma.$connect()
      console.log(`[MarketplaceIndexer] Started — marketplace=${marketplaceAddress}, cawProfile=${cawProfileAddress}, rpc=${rpcUrl.substring(0, 40)}...`)

      const provider = makeJsonRpcProvider(rpcUrl, 11155111)
      const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider)
      const cawProfile = new ethers.Contract(cawProfileAddress, CAWNAME_TRANSFER_ABI, provider)

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
          const bidReclaimedFilter = marketplace.filters.BidReclaimed()
          const cancelledFilter = marketplace.filters.ListingCancelled()
          const settledFilter = marketplace.filters.AuctionSettled()
          const offerCreatedFilter = marketplace.filters.OfferCreated()
          const offerAcceptedFilter = marketplace.filters.OfferAccepted()
          const offerCancelledFilter = marketplace.filters.OfferCancelled()

          console.log(`[MarketplaceIndexer] Polling blocks ${fromBlock}–${toBlock}`)

          // Sequential queryFilters — Promise.all lets ethers batch them
          // into a single JSON-RPC request, and when one member 429s the
          // partial-batch failure surfaces as a confusing "missing response"
          // error. Sequential calls play nicer with the global throttle.
          const listed = await marketplace.queryFilter(listedFilter, fromBlock, toBlock)
          const sales = await marketplace.queryFilter(saleFilter, fromBlock, toBlock)
          const bids = await marketplace.queryFilter(bidFilter, fromBlock, toBlock)
          const bidWithdrawals = await marketplace.queryFilter(bidWithdrawnFilter, fromBlock, toBlock)
          const bidReclaimed = await marketplace.queryFilter(bidReclaimedFilter, fromBlock, toBlock)
          const cancelled = await marketplace.queryFilter(cancelledFilter, fromBlock, toBlock)
          const settled = await marketplace.queryFilter(settledFilter, fromBlock, toBlock)
          const offersCreated = await marketplace.queryFilter(offerCreatedFilter, fromBlock, toBlock)
          const offersAccepted = await marketplace.queryFilter(offerAcceptedFilter, fromBlock, toBlock)
          const offersCancelled = await marketplace.queryFilter(offerCancelledFilter, fromBlock, toBlock)

          if (listed.length || sales.length || bids.length || bidWithdrawals.length || bidReclaimed.length || cancelled.length || settled.length || offersCreated.length || offersAccepted.length || offersCancelled.length) {
            console.log(`[MarketplaceIndexer] Found events: ${listed.length} listed, ${sales.length} sales, ${bids.length} bids, ${bidWithdrawals.length} bid-withdrawn, ${bidReclaimed.length} bid-reclaimed, ${cancelled.length} cancelled, ${settled.length} settled, ${offersCreated.length} offers created, ${offersAccepted.length} offers accepted, ${offersCancelled.length} offers cancelled`)
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
              const previousBidder = listing.highestBidder

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

              // Notify the previous highest bidder that they've been outbid
              if (previousBidder && previousBidder.toLowerCase() !== bidder.toLowerCase()) {
                try {
                  // Find any profile owned by the outbid wallet
                  const outbidUser = await prisma.user.findFirst({
                    where: { address: { equals: previousBidder, mode: 'insensitive' } },
                    select: { tokenId: true },
                  })
                  // Find any profile owned by the new bidder (for actorId)
                  const newBidderUser = await prisma.user.findFirst({
                    where: { address: { equals: bidder, mode: 'insensitive' } },
                    select: { tokenId: true },
                  })
                  if (outbidUser) {
                    await prisma.notification.create({
                      data: {
                        userId: outbidUser.tokenId,
                        actorId: newBidderUser?.tokenId ?? outbidUser.tokenId,
                        type: 'OUTBID',
                        actionPayload: {
                          listingId: listing.listingId,
                          username: listing.username,
                          tokenId: listing.tokenId,
                          newBidAmount: amount,
                          previousBidAmount: listing.highestBid,
                        },
                      },
                    })
                    console.log(`[Marketplace] Sent OUTBID notification to tokenId=${outbidUser.tokenId} for listing ${listing.listingId}`)
                  }
                } catch (err) {
                  console.warn('[Marketplace] Failed to create OUTBID notification:', err)
                }
              }
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

          // Process BidReclaimed events. The contract emits this when an English
          // auction is cancelled by the seller or reclaimed by anyone after the
          // seller transferred the NFT away — in both cases the highest bidder's
          // funds are credited via the pull-pattern (see CawProfileMarketplace
          // pendingReturns) and become claimable via withdrawBid. Mark the bid
          // as OUTBID so it shows up in the user's claimable-refunds list,
          // which is the same UX as a bid that was outbid by a higher one.
          for (const event of bidReclaimed) {
            const ev = event as ethers.EventLog
            const args = ev.args
            const onChainListingId = Number(args[0])
            const bidder = args[1].toLowerCase()

            const listing = await prisma.marketplaceListing.findUnique({ where: { listingId: onChainListingId } })
            if (listing) {
              await prisma.marketplaceBid.updateMany({
                where: { listingId: listing.id, bidder, status: 'ACTIVE' },
                data: { status: 'OUTBID' },
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

              // Notify the auction winner
              try {
                const winnerUser = await prisma.user.findFirst({
                  where: { address: { equals: winner, mode: 'insensitive' } },
                  select: { tokenId: true },
                })
                // Find seller's profile for actorId
                const sellerUser = await prisma.user.findFirst({
                  where: { address: { equals: listing.seller, mode: 'insensitive' } },
                  select: { tokenId: true },
                })
                if (winnerUser) {
                  await prisma.notification.create({
                    data: {
                      userId: winnerUser.tokenId,
                      actorId: sellerUser?.tokenId ?? winnerUser.tokenId,
                      type: 'AUCTION_WON',
                      actionPayload: {
                        listingId: listing.listingId,
                        username: listing.username,
                        tokenId: listing.tokenId,
                        winningBid: price,
                        paymentToken: listing.paymentToken,
                      },
                    },
                  })
                  console.log(`[Marketplace] Sent AUCTION_WON notification to tokenId=${winnerUser.tokenId} for listing ${listing.listingId}`)
                }
              } catch (err) {
                console.warn('[Marketplace] Failed to create AUCTION_WON notification:', err)
              }
            }
          }

          // Process OfferCreated events
          for (const event of offersCreated) {
            const ev = event as ethers.EventLog
            const args = ev.args
            const onChainOfferId = Number(args[0])
            const tokenId = Number(args[1])
            const offerer = args[2].toLowerCase()
            const paymentToken = args[3]
            const amount = args[4].toString()
            const expiry = Number(args[5])

            const user = await prisma.user.findUnique({ where: { tokenId } })
            const username = user?.username || `#${tokenId}`

            await prisma.marketplaceOffer.upsert({
              where: { offerId: onChainOfferId },
              update: { status: 'ACTIVE' },
              create: {
                offerId: onChainOfferId,
                tokenId,
                offerer,
                paymentToken: getPaymentLabel(paymentToken),
                paymentAddress: paymentToken.toLowerCase(),
                amount,
                expiry: new Date(expiry * 1000),
                username,
                txHash: ev.transactionHash,
              },
            })
            // Notification is created via the authenticated POST /api/marketplace/offers/notify endpoint
          }

          // Process OfferAccepted events
          for (const event of offersAccepted) {
            const ev = event as ethers.EventLog
            const onChainOfferId = Number(ev.args[0])
            await prisma.marketplaceOffer.updateMany({
              where: { offerId: onChainOfferId, status: 'ACTIVE' },
              data: { status: 'ACCEPTED' },
            })
          }

          // Process OfferCancelled events
          for (const event of offersCancelled) {
            const ev = event as ethers.EventLog
            const onChainOfferId = Number(ev.args[0])
            await prisma.marketplaceOffer.updateMany({
              where: { offerId: onChainOfferId, status: 'ACTIVE' },
              data: { status: 'CANCELLED' },
            })
          }

          // Mark expired offers
          await prisma.marketplaceOffer.updateMany({
            where: {
              status: 'ACTIVE',
              expiry: { lt: new Date() },
            },
            data: { status: 'EXPIRED' },
          })

          // Check for CawProfile transfers that invalidate listings
          const transferFilter = cawProfile.filters.Transfer()
          const transfers = await cawProfile.queryFilter(transferFilter, fromBlock, toBlock)

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
          ctx.heartbeat('poll')
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
