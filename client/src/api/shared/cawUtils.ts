// src/api/shared/cawUtils.ts
import { prisma } from '../../prismaClient'

export interface CawRaw {
  id: number
  content: string
  action?: string
  createdAt: Date
  user: { id: number; tokenId: number; username: string; displayName?: string; image?: string; avatarUrl?: string; address?: string | null; xBadgeVisible?: boolean; xHandle?: string | null; xFollowerBucket?: number | null; preferredLanguage?: string | null }
  _count?: { likes: number; recaws: number }
  likes?: Array<{ userId: number; pending?: boolean }>
  recaws?: Array<{ id: number; status?: 'SUCCESS' | 'PENDING' | 'FAILED'; action?: string; content?: string }>
  repliesOnThis?: Array<{ userId: number; pending?: boolean; replyCawId?: number }>
  tips?: Array<{ senderId: number; pending?: boolean; amount?: number }>
  tipCount?: number
  totalTipAmount?: number
  bookmarks?: Array<{ userId: number }>
  bookmarkCount?: number
  // Set when getCawIncludeConfig pulled the pinnedBy relation. Only
  // the post's author can pin, so this is 0 or 1 entry where
  // userId === raw.userId.
  pinnedBy?: Array<{ userId: number; pending: boolean }>
  userId?: number
  commentCount: number
  recawCount: number
  likeCount: number
  viewCount?: number
  cawonce: number
  parent?: any
  hashtags?: Array<{ hashtag: { name: string } }>
  imageData?: string
  hasImage?: boolean
  sourceLanguage?: string | null
  status?: 'SUCCESS' | 'PENDING' | 'FAILED' | 'HIDDEN'
  reason?: string | null
}

export interface ShapedPoll {
  /** Confirmed-vote total (denormalized on Poll.totalVotes). */
  totalVotes: number
  /** Per-option confirmed vote counts, positional. Same length as `options`. */
  optionVoteCounts: number[]
  /** The poll's options as posted, positional. */
  options: string[]
  /**
   * Optional per-option image URLs, positional, same length as `options`
   * when populated. Slots may be empty strings ("no image for this
   * option"). Off-chain — only populated for polls authored on this
   * instance (or imported via API); polls picked up purely from on-chain
   * mirror events default to empty.
   */
  optionImages: string[]
  /**
   * The current user's vote on this poll, when known. `optionIndex: null`
   * indicates "no vote yet" — distinct from "voted, then unvoted" which
   * deletes the row entirely. `pending` mirrors the same semantics as
   * Like / Tip: optimistic local writes flag pending until the indexer
   * confirms. Null when no currentUserId in the request.
   */
  userVote: { optionIndex: number; pending: boolean } | null
}

export interface ShapedCaw {
  id: string
  content: string
  action?: string
  isQuote?: boolean
  timestamp: string
  user: { id: number; tokenId: number; username: string; displayName?: string; image?: string; avatarUrl?: string; address?: string | null; xBadgeVisible?: boolean; xHandle?: string | null; xFollowerBucket?: number | null; preferredLanguage?: string | null }
  likeCount: number
  viewCount: number
  hasLiked: boolean
  hasRecawed: boolean
  hasReplied: boolean
  hasTipped: boolean
  tipPending?: boolean
  tipCount: number
  totalTipAmount: number
  isBookmarked?: boolean
  bookmarkCount?: number
  // Set on caws the profile owner has pinned (up to 3). The caws.ts
  // profile-feed route prepends the pinned caws to the first page and
  // stamps this flag — clients render the "📌 Pinned" badge above the
  // bubble for any item with isPinned=true.
  isPinned?: boolean
  // True while the corresponding PinnedCaw row is pending — i.e. the
  // pi: tx is in flight or the xpi: tx has flagged the row but the
  // unpin hasn't confirmed yet. UI uses this for spinner / dim state.
  pinPending?: boolean
  likePending?: boolean
  recawPending?: boolean
  replyPending?: boolean
  commentCount: number
  recawCount: number
  cawonce: number
  hashtags?: string[]
  originalCaw?: ShapedCaw
  parent?: ShapedCaw | null
  imageData?: string
  hasImage?: boolean
  /** Detected source language (BCP-47 primary subtag). Null = not yet
   * detected; the FE falls back to always showing the manual Translate
   * button. Populated lazily the first time any viewer translates the
   * caw, so a single user's tap fixes the gating for everyone else. */
  sourceLanguage?: string | null
  status?: 'SUCCESS' | 'PENDING' | 'FAILED' | 'HIDDEN'
  reason?: string | null
  /** Present when the caw text contains a ::poll:...:: marker and the Poll
   * row has been created (either by the API submit or by the indexer). */
  poll?: ShapedPoll
}

export function shapeCaw(raw: CawRaw | any): ShapedCaw {
  const userLike = raw.likes && raw.likes[0]
  // Find recaws or quotes (exclude plain replies which are CAW with content but have a Reply record)
  // A RECAW is always a repost. A CAW with content is a quote IF it has no Reply record.
  // Since repliesOnThis tracks Reply records, we can cross-check.
  const replyIds = new Set((raw.repliesOnThis || []).map((r: any) => r.replyCawId).filter(Boolean))
  const userRecawOrQuote = raw.recaws?.find((r: any) =>
    r.action === 'RECAW' || (r.action === 'CAW' && r.content && !replyIds.has(r.id))
  )
  const userReply = raw.repliesOnThis && raw.repliesOnThis[0]

  const hasRecawed = Boolean(userRecawOrQuote && userRecawOrQuote.status !== 'PENDING' && userRecawOrQuote.status !== 'FAILED')
  const recawPending = userRecawOrQuote?.status === 'PENDING'

  const hasReplied = Boolean(userReply && !userReply.pending)
  const replyPending = userReply?.pending
  const userTip = raw.tips && raw.tips[0]
  const hasTipped = Boolean(userTip && !userTip.pending) // Only true if confirmed
  const tipPending = userTip?.pending


  // Pre-shape the poll. The id stays as a private `_pollId` field so the
  // follow-up enrichWithPollVotes() can find the poll without re-querying;
  // it's stripped before the response is returned to the client.
  let poll: ShapedPoll | undefined
  if (raw.poll) {
    const opts: string[] = raw.poll.options || []
    // Pad / truncate optionImages so it's positional with options. Stored
    // value can drift if a future migration changes shape; clients want a
    // strict "imgs[i] corresponds to options[i]" guarantee.
    const rawImgs: string[] = raw.poll.optionImages || []
    const optionImages = opts.map((_, i) => rawImgs[i] || '')
    poll = {
      options: opts,
      optionImages,
      totalVotes: raw.poll.totalVotes ?? 0,
      optionVoteCounts: [],   // filled by enrichWithPollVotes
      userVote: null,         // filled by enrichWithPollVotes
    }
    ;(poll as any)._pollId = raw.poll.id
  }

  return {
    id: raw.id.toString(),
    content: raw.content,
    action: raw.action,
    // A quote is a RECAW with content. A plain recaw is a RECAW with empty content.
    // A reply is a CAW with a parent.
    isQuote: !!(raw.action === 'RECAW' && raw.content && raw.parent),
    timestamp: raw.createdAt.toISOString(),
    user: raw.user,
    likeCount: raw.likeCount,
    viewCount: raw.viewCount || 0,
    hasLiked: Boolean(userLike && !userLike.pending), // Only true if liked AND not pending
    likePending: userLike?.pending,
    hasRecawed, // Only true if recawed AND confirmed
    recawPending,
    hasReplied, // Only true if replied AND confirmed
    hasTipped,
    tipPending,
    tipCount: raw.tipCount ?? 0,
    totalTipAmount: raw.totalTipAmount ?? 0,
    replyPending,
    isBookmarked: raw.bookmarks ? raw.bookmarks.length > 0 : undefined,
    bookmarkCount: raw.bookmarkCount ?? 0,
    pinPending: (raw.pinnedBy && raw.pinnedBy.length > 0)
      ? !!raw.pinnedBy.find((p: any) => p.userId === raw.userId)?.pending
      : undefined,
    commentCount: raw.commentCount,
    recawCount: raw.recawCount,
    cawonce: raw.cawonce,
    hashtags: raw.hashtags?.map((h: any) => h.hashtag.name) || [],
    originalCaw: raw.parent ? shapeCaw(raw.parent) : undefined,
    parent: raw.parent ? shapeCaw(raw.parent) : null,
    imageData: raw.imageData,
    hasImage: raw.hasImage,
    sourceLanguage: raw.sourceLanguage ?? null,
    status: raw.status || 'SUCCESS',
    reason: raw.reason,
    poll,
  }
}

export interface PaginationResult<T> {
  items: T[]
  nextCursor?: number
}

export function handlePagination<T>(items: T[], limit: number, getId: (item: T) => number): PaginationResult<T> {
  let nextCursor: number | undefined
  if (items.length > limit) {
    const last = items.pop()!
    nextCursor = getId(last)
  }
  return { items, nextCursor }
}

export interface CawQueryOptions {
  currentUserId?: number
  includeHashtags?: boolean
}

// Shared user-select shape for caw author + parent author. The X badge
// fields (xHandle / xFollowerBucket) live on WalletXLink keyed by wallet
// address, not on User — they're injected post-shape via
// enrichWithXBadges() so we don't pay an N+1 join through Prisma.
// We do select `address` (needed for the join key) and `xBadgeVisible`
// (per-profile opt-out) so the enrichment can gate badge rendering.
const cawUserSelect = {
  id: true, tokenId: true, username: true, displayName: true,
  image: true, avatarUrl: true, defaultAvatarId: true,
  address: true, xBadgeVisible: true, preferredLanguage: true,
} as const

export function getCawIncludeConfig(options: CawQueryOptions = {}) {
  const { currentUserId, includeHashtags = false } = options

  return {
    user: { select: cawUserSelect },
    likes: currentUserId
      ? { where: { userId: currentUserId }, select: { userId: true, pending: true } }
      : false,
    recaws: currentUserId
      ? { where: { userId: currentUserId }, select: { id: true, status: true, action: true, content: true } }
      : false,
    repliesOnThis: currentUserId
      ? { where: { userId: currentUserId }, select: { userId: true, pending: true, replyCawId: true } }
      : false,
    tips: currentUserId
      ? { where: { senderId: currentUserId }, select: { senderId: true, pending: true }, take: 1 }
      : false,
    _count: { select: { tips: true } },
    bookmarks: currentUserId
      ? { where: { userId: currentUserId }, select: { userId: true }, take: 1 }
      : false,
    // Pin row(s) for this caw. Only the post's author can pin, so this
    // is 0 or 1 row. We don't filter by userId here because we don't
    // have the post's userId at include-time; shapeCaw matches the row
    // (if any) against raw.userId and surfaces pinPending.
    pinnedBy: { select: { userId: true, pending: true } },
    // Poll core (options + totalVotes). Per-option vote counts and the
    // viewer's own vote come from a follow-up enrichWithPollVotes() call —
    // groupBy + targeted findMany is cheaper than fanning aggregates out
    // through Prisma's nested includes for every list endpoint.
    poll: { select: { id: true, options: true, optionImages: true, totalVotes: true } },
    ...(includeHashtags && {
      hashtags: {
        include: { hashtag: { select: { name: true } } }
      }
    }),
    parent: {
      include: {
        user: { select: cawUserSelect },
        likes: currentUserId
          ? { where: { userId: currentUserId }, select: { userId: true, pending: true } }
          : false,
        recaws: currentUserId
          ? { where: { userId: currentUserId }, select: { id: true, status: true, action: true, content: true } }
          : false,
        repliesOnThis: currentUserId
          ? { where: { userId: currentUserId }, select: { userId: true, pending: true, replyCawId: true } }
          : false,
        tips: currentUserId
          ? { where: { senderId: currentUserId }, select: { senderId: true, pending: true }, take: 1 }
          : false,
        bookmarks: currentUserId
          ? { where: { userId: currentUserId }, select: { userId: true }, take: 1 }
          : false,
        poll: { select: { id: true, options: true, optionImages: true, totalVotes: true } },
        ...(includeHashtags && {
          hashtags: {
            include: { hashtag: { select: { name: true } } }
          }
        })
      }
    }
  }
}

/**
 * Decorate records (already shaped or raw) with per-option poll vote counts
 * and the current user's vote — both data points that aren't expressible as
 * a Prisma include without a custom aggregate. One groupBy + at most one
 * findMany per page; capped naturally by the page size.
 *
 * Operates IN PLACE on the records' existing `poll` field, attaching
 * `optionVoteCounts` and `userVote`. Callers pass the already-shaped output
 * of shapeCaw (where `poll` was built from the included relation).
 */
export async function enrichWithPollVotes(
  records: ShapedCaw[],
  currentUserId?: number,
): Promise<void> {
  // Collect every poll referenced — including parent caws (quotes' parents
  // can themselves carry polls). Skip records with no poll attached.
  const pollIds = new Set<number>()
  const collect = (caw: ShapedCaw | null | undefined) => {
    if (!caw?.poll) return
    const pid = (caw.poll as any)._pollId
    if (pid) pollIds.add(pid)
  }
  for (const r of records) {
    collect(r)
    collect(r.parent)
    collect(r.originalCaw)
  }
  if (pollIds.size === 0) return

  const ids = Array.from(pollIds)
  // Per-option vote counts — confirmed votes only. groupBy is the cheapest
  // way to get this without N round trips.
  const counts = await prisma.vote.groupBy({
    by: ['pollId', 'optionIndex'],
    where: { pollId: { in: ids }, pending: false },
    _count: { _all: true },
  })
  const countsByPoll = new Map<number, Map<number, number>>()
  for (const row of counts) {
    let inner = countsByPoll.get(row.pollId)
    if (!inner) { inner = new Map(); countsByPoll.set(row.pollId, inner) }
    inner.set(row.optionIndex, row._count._all)
  }

  // Viewer's votes — one row per poll at most (unique constraint).
  const userVotes = currentUserId
    ? await prisma.vote.findMany({
        where: { pollId: { in: ids }, voterId: currentUserId },
        select: { pollId: true, optionIndex: true, pending: true },
      })
    : []
  const myVoteByPoll = new Map<number, { optionIndex: number; pending: boolean }>()
  for (const v of userVotes) {
    myVoteByPoll.set(v.pollId, { optionIndex: v.optionIndex, pending: v.pending })
  }

  const decorate = (caw: ShapedCaw | null | undefined) => {
    if (!caw?.poll) return
    const pid = (caw.poll as any)._pollId
    if (!pid) return
    const inner = countsByPoll.get(pid) || new Map()
    const optionsLen = caw.poll.options.length
    const optionVoteCounts: number[] = []
    for (let i = 0; i < optionsLen; i++) optionVoteCounts.push(inner.get(i) || 0)
    caw.poll.optionVoteCounts = optionVoteCounts
    caw.poll.userVote = myVoteByPoll.get(pid) || null
    // Strip the internal id so it doesn't leak into responses.
    delete (caw.poll as any)._pollId
  }
  for (const r of records) {
    decorate(r)
    decorate(r.parent)
    decorate(r.originalCaw)
  }
}

/**
 * Decorate shaped caws with X badge fields (xHandle + xFollowerBucket)
 * looked up from WalletXLink by the user's wallet address. Same shape
 * as enrichWithPollVotes — collect all unique addresses across the page,
 * one batched findMany, mutate in place.
 *
 * Per-profile visibility: a user can opt OUT of showing the X badge on
 * a given profile via xBadgeVisible=false. We honor that here by leaving
 * xHandle/xFollowerBucket undefined on the user object even when their
 * wallet has a link. The "active user looking at their own settings"
 * surface area is /api/me, not the feed — that endpoint reads the link
 * directly and surfaces both visible and hidden state.
 *
 * The address field on each user is left in place — it's already returned
 * by /api/users/by-token et al. and isn't sensitive (it's the public NFT
 * owner address from chain).
 */
export async function enrichWithXBadges(records: ShapedCaw[]): Promise<void> {
  const addresses = new Set<string>()
  const collect = (caw: ShapedCaw | null | undefined) => {
    if (!caw?.user?.address || caw.user.xBadgeVisible === false) return
    addresses.add(caw.user.address.toLowerCase())
  }
  for (const r of records) {
    collect(r)
    collect(r.parent)
    collect(r.originalCaw)
  }
  if (addresses.size === 0) return

  const links = await prisma.walletXLink.findMany({
    where:  { address: { in: Array.from(addresses) } },
    select: { address: true, xHandle: true, xFollowerBucket: true },
  })
  const byAddress = new Map(links.map(l => [l.address.toLowerCase(), l]))

  const decorate = (caw: ShapedCaw | null | undefined) => {
    if (!caw?.user?.address || caw.user.xBadgeVisible === false) return
    const link = byAddress.get(caw.user.address.toLowerCase())
    if (!link) return
    caw.user.xHandle         = link.xHandle
    caw.user.xFollowerBucket = link.xFollowerBucket ?? null
  }
  for (const r of records) {
    decorate(r)
    decorate(r.parent)
    decorate(r.originalCaw)
  }
}