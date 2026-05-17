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
  user: { id: number; tokenId: number; username: string; displayName?: string; image?: string; avatarUrl?: string; xHandle?: string | null; xFollowerBucket?: number | null; preferredLanguage?: string | null }
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
  isPinned?: boolean // True for posts in the user's top-3 pinned set on their profile feed
  pinPending?: boolean // True while the corresponding PinnedCaw row is pending an indexer confirmation
  commentCount: number
  recawCount: number
  cawonce: number
  imageData?: string // Base64 image data for on-chain images
  imageUrl?: string  // URL for off-chain images
  hasImage?: boolean // Quick check if caw has any image
  videoData?: string // URLs for off-chain videos
  hasVideo?: boolean // Quick check if caw has any video
  // BCP-47 primary subtag (e.g. "en", "es"). Null = not yet detected; the
  // FE shows the manual Translate button until any viewer translates the
  // caw once and POSTs the gtx-detected source back to the server.
  sourceLanguage?: string | null
  poll?: {
    options: string[]
    /** Per-option image URLs, positional. Same length as `options`. Empty
     * string in slot i = no image for that option. Off-chain only — polls
     * authored on a different mirror node arrive with all entries empty. */
    optionImages: string[]
    totalVotes: number
    optionVoteCounts: number[]
    /** Single-select compat: the user's first (or only) vote row. Multi-
     * select renderers should prefer `userVotes` below for the full set. */
    userVote: { optionIndex: number; pending: boolean } | null
    /** Full set of viewer's votes on this poll. Always an array (possibly
     * empty). Single-select polls have 0 or 1 entries; multi-select polls
     * can have any subset. */
    userVotes?: { optionIndex: number; pending: boolean }[]
    /** ISO timestamp when voting closes. Computed by the indexer from the
     * caw's createdAt + the ::pd:<dur>:: marker duration. Null when the
     * poll has no expiry (legacy polls created before the duration sidecar). */
    endsAt?: string | null
    /** True when the poll's ::pm:: sidecar was present at post time. The
     * renderer uses this to switch between radio (single-select) and
     * checkbox (multi-select) controls. */
    multiSelect?: boolean
  }
}
