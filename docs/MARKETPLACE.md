# Profile Marketplace

Trustless, non-custodial marketplace for trading CAW profile NFTs. Zero fees — 100% of payment goes to the seller.

## Overview

CAW profiles (ERC-721 username NFTs) can be listed for sale, auctioned, or offered on directly. All settlement happens on-chain via `CawProfileMarketplace.sol` on L1, with automatic L2 sync via LayerZero on transfer.

## Listing Types

### Fixed Price

Straightforward buy-now listing. Seller sets a price, first buyer wins.

```
Seller: createListing(tokenId, FIXED, paymentToken, price, 0, 0)
Buyer:  buy(listingId)  or  buyWithToken(listingId)
```

Seller can cancel anytime.

### Dutch Auction

Price decreases linearly from `startPrice` to `endPrice` over the duration. First buyer at any price point wins.

```
Seller: createListing(tokenId, DUTCH, token, startPrice, endPrice, duration)
Buyer:  buy(listingId)  — pays the current price at time of tx
```

Current price = `startPrice - ((startPrice - endPrice) * elapsed / duration)`

Seller can cancel anytime.

### English Auction

Competitive bidding. Highest bid wins after the deadline.

```
Seller: createListing(tokenId, ENGLISH, token, startPrice, 0, duration)
Bidder: placeBid(listingId)  or  placeBidWithToken(listingId)
Anyone: settleAuction(listingId)  — after deadline passes
```

Rules:
- Minimum bid increment: **5%** above current highest bid
- **Anti-snipe**: bids in the last 10 minutes extend the deadline by 10 minutes
- Seller can only cancel if there are no bids
- Outbid funds are reclaimable via `withdrawBid()` (pull pattern)
- If the seller transfers the token away during an active auction, the highest bidder can call `reclaimBid()` to get their funds back

## Offers

Any user can make an offer on any profile, whether listed or not. Offer funds are escrowed in the contract.

```
Offerer: createOfferETH(tokenId, duration)      — ETH escrowed as msg.value
         createOfferERC20(tokenId, token, amount, duration)  — tokens transferred to contract
Owner:   acceptOffer(offerId)                    — payment sent, NFT transferred
Offerer: cancelOffer(offerId)                    — refund escrowed funds
```

- Duration: 5 minutes to 30 days (set by offerer)
- Accepting an offer auto-cancels any active listing for that token
- Anyone can cancel an expired offer (refunds to offerer)

## Payment Tokens

Supported tokens (configured by contract owner):

| Token | Address |
|-------|---------|
| ETH | Native (address(0)) |
| WETH | Whitelisted ERC-20 |
| CAW | Whitelisted ERC-20 |
| USDC | Whitelisted ERC-20 |
| USDT | Whitelisted ERC-20 |

ERC-20 purchases require a prior `approve()` call to the marketplace contract.

## Fees

- **Marketplace fee: 0%** — per the CAW manifesto
- **Buyer pays LayerZero fee** for L2 sync (~120% of quote, excess refunded)

## L2 Sync

When a profile changes hands (via sale, auction settlement, or offer acceptance), the marketplace calls `CawProfile.transferAndSync()` which transfers the NFT and sends a LayerZero message to update ownership on L2. The buyer/settler pays the LZ fee as part of the transaction's `msg.value`.

## Backend Indexer

`MarketplaceIndexerService` polls L1 every 15 seconds for marketplace events:

| Event | Action |
|-------|--------|
| `Listed` | Creates `MarketplaceListing` record |
| `Sale` | Marks listing `SOLD`, creates `MarketplaceSale` |
| `BidPlaced` | Creates `MarketplaceBid`, marks previous as `OUTBID`, sends notification |
| `BidWithdrawn` | Marks bid `WITHDRAWN` |
| `ListingCancelled` | Marks listing `CANCELLED` |
| `AuctionSettled` | Marks listing `SOLD`, bid as `WON`, sends `AUCTION_WON` notification |
| `OfferCreated` | Creates `MarketplaceOffer` record |
| `OfferAccepted` | Marks offer `ACCEPTED` |
| `OfferCancelled` | Marks offer `CANCELLED` |

The indexer also handles edge cases:
- External transfers of listed tokens → auto-cancels the listing
- Expired offers → marked `EXPIRED` on each poll cycle
- English auctions past deadline with no bids → marked `EXPIRED`

## API Endpoints

### Listings
- `GET /api/marketplace/listings` — Browse active listings (filter by type, name length, payment token, sort)
- `GET /api/marketplace/listings/:id` — Single listing with bid history
- `GET /api/marketplace/listings/token/:tokenId` — Active listing for a token
- `GET /api/marketplace/listings/seller/:address` — All listings by seller

### Sales
- `GET /api/marketplace/sales` — Recent completed sales (paginated)
- `GET /api/marketplace/sales/stats` — Aggregate volume by payment token

### Bids
- `GET /api/marketplace/bids/:address` — All bids by address

### Offers
- `GET /api/marketplace/offers/token/:tokenId` — Active offers for a token
- `GET /api/marketplace/offers/received/:address` — Offers on tokens owned by address
- `GET /api/marketplace/offers/address/:address` — Offers made by address

## Frontend

The marketplace UI has four tabs:

1. **For Sale** — Browse and filter active listings with live price updates (Dutch auctions update every second)
2. **Recent Sales** — Completed sales history
3. **My Profiles** — Tokens owned by the connected wallet (list/delist, view offers)
4. **My Offers** — Incoming offers on owned tokens (with unread badge)

Modals handle the transaction flow: balance checks, ERC-20 approvals, LZ fee quoting, and optimistic UI updates after confirmation.

## Key Files

| Component | Path |
|-----------|------|
| Smart contract | `solidity/contracts/CawProfileMarketplace.sol` |
| Indexer service | `client/src/services/MarketplaceIndexerService/index.ts` |
| API routes | `client/src/api/routes/marketplace.ts` |
| Marketplace page | `client/src/services/FrontEnd/src/pages/Marketplace.tsx` |
| Buy modal | `client/src/services/FrontEnd/src/components/BuyModal.tsx` |
| Bid modal | `client/src/services/FrontEnd/src/components/PlaceBidModal.tsx` |
| Offer modal | `client/src/services/FrontEnd/src/components/MakeOfferModal.tsx` |
| Listing card | `client/src/services/FrontEnd/src/components/ListingCard.tsx` |
