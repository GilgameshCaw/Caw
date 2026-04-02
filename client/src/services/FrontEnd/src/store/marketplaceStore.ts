import { create } from 'zustand'

export type ListingType = 'all' | 'FIXED' | 'DUTCH_AUCTION' | 'ENGLISH_AUCTION'
export type PaymentToken = 'all' | 'ETH' | 'CAW' | 'WETH' | 'USDC' | 'USDT'
export type SortOption = 'newest' | 'price_asc' | 'price_desc' | 'length_asc' | 'length_desc'

export interface MarketplaceListing {
  id: number
  listingId: number
  tokenId: number
  seller: string
  listingType: string
  paymentToken: string
  paymentAddress: string
  startPrice: string
  endPrice: string | null
  startTime: string
  endTime: string | null
  status: string
  highestBid: string | null
  highestBidder: string | null
  username: string
  usernameLength: number
  stakedCaw: string | null
  txHash: string | null
  createdAt: string
  bids?: MarketplaceBid[]
  _count?: { bids: number }
  sale?: MarketplaceSale | null
}

export interface MarketplaceBid {
  id: number
  listingId: number
  bidder: string
  amount: string
  txHash: string | null
  status: string
  createdAt: string
  listing?: MarketplaceListing
}

export interface MarketplaceSale {
  id: number
  listingId: number
  buyer: string
  seller: string
  tokenId: number
  price: string
  paymentToken: string
  username: string
  txHash: string | null
  createdAt: string
}

interface MarketplaceFilters {
  listingType: ListingType
  paymentToken: PaymentToken
  minLength: number
  maxLength: number
  sort: SortOption
}

interface MarketplaceStore {
  filters: MarketplaceFilters
  setFilter: <K extends keyof MarketplaceFilters>(key: K, value: MarketplaceFilters[K]) => void
  resetFilters: () => void
  // Create listing modal
  createListingModal: { isOpen: boolean; tokenId: number | null; username: string | null }
  openCreateListing: (tokenId: number, username: string) => void
  closeCreateListing: () => void
  // Buy modal
  buyModal: { isOpen: boolean; listing: MarketplaceListing | null }
  openBuyModal: (listing: MarketplaceListing) => void
  closeBuyModal: () => void
  // Bid modal
  bidModal: { isOpen: boolean; listing: MarketplaceListing | null }
  openBidModal: (listing: MarketplaceListing) => void
  closeBidModal: () => void
  // Refresh trigger — increment to force re-fetch in components
  refreshCounter: number
  triggerRefresh: () => void
}

const DEFAULT_FILTERS: MarketplaceFilters = {
  listingType: 'all',
  paymentToken: 'all',
  minLength: 0,
  maxLength: 999,
  sort: 'newest',
}

export const useMarketplaceStore = create<MarketplaceStore>((set) => ({
  filters: { ...DEFAULT_FILTERS },
  setFilter: (key, value) => set(state => ({
    filters: { ...state.filters, [key]: value },
  })),
  resetFilters: () => set({ filters: { ...DEFAULT_FILTERS } }),

  createListingModal: { isOpen: false, tokenId: null, username: null },
  openCreateListing: (tokenId, username) => set({
    createListingModal: { isOpen: true, tokenId, username },
  }),
  closeCreateListing: () => set({
    createListingModal: { isOpen: false, tokenId: null, username: null },
  }),

  buyModal: { isOpen: false, listing: null },
  openBuyModal: (listing) => set({ buyModal: { isOpen: true, listing } }),
  closeBuyModal: () => set({ buyModal: { isOpen: false, listing: null } }),

  bidModal: { isOpen: false, listing: null },
  openBidModal: (listing) => set({ bidModal: { isOpen: true, listing } }),
  closeBidModal: () => set({ bidModal: { isOpen: false, listing: null } }),

  refreshCounter: 0,
  triggerRefresh: () => set(s => ({ refreshCounter: s.refreshCounter + 1 })),
}))
