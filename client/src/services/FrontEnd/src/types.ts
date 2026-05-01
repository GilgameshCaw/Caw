import { Address } from "viem";
import TOKENS from "./constants/tokens";

export interface Amount {
  raw: bigint;
  usd: number;
}

export type TokenSymbol = keyof typeof TOKENS;

export interface Token {
  coingeckoId: string;
  symbol: TokenSymbol;
  decimals: number;
  address: Address;
  price: bigint
}

export interface TokenData {
  withdrawable: bigint;
  ownerBalance: bigint;
  stakedAmount: bigint;
  address: Address;
  username: string;
  tokenId: number;
  owner: Address;
  // balance: bigint;
  cawonce: number;
}

export interface User {
  username: string;
  id: number;
  image: string;
}

export type CawItem = {
  id: string
  content: string
  action?: string
  isQuote?: boolean
  timestamp: string
  user: { id: number; tokenId: number; username: string; displayName?: string; image?: string; avatarUrl?: string }
  parent: CawItem
  likeCount: number
  viewCount: number
  hasLiked: boolean
  hasRecawed: boolean
  hasReplied?: boolean // True when current user has replied (confirmed)
  hasTipped?: boolean // True when current user has tipped this post (confirmed)
  tipPending?: boolean // True when tip is pending on-chain confirmation
  tipCount?: number // Total number of tips on this caw
  totalTipAmount?: number // Total CAW tipped on this caw
  likePending?: boolean // True when like is pending on-chain confirmation
  recawPending?: boolean // True when recaw is pending on-chain confirmation
  replyPending?: boolean // True when reply is pending on-chain confirmation
  status?: 'SUCCESS' | 'PENDING' | 'FAILED' | 'HIDDEN' // Transaction status of the caw (HIDDEN = removed by author)
  reason?: string | null // Failure reason if status is FAILED
  isBookmarked?: boolean // True when post is bookmarked by current user
  bookmarkCount?: number
  isPinned?: boolean // True for the single profile-pinned post on its profile feed
  pinnedAt?: string | null // ISO timestamp when the post was pinned (null = not pinned)
  commentCount: number
  recawCount: number
  cawonce: number
  imageData?: string // Base64 image data for on-chain images
  imageUrl?: string  // URL for off-chain images
  hasImage?: boolean // Quick check if caw has any image
  videoData?: string // URLs for off-chain videos
  hasVideo?: boolean // Quick check if caw has any video
  poll?: {
    options: string[]
    totalVotes: number
    optionVoteCounts: number[]
    userVote: { optionIndex: number; pending: boolean } | null
  }
}
