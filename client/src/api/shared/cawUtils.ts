// src/api/shared/cawUtils.ts
import { prisma } from '../../prismaClient'

export interface CawRaw {
  id: number
  content: string
  createdAt: Date
  user: { id: number; tokenId: number; username: string; displayName?: string; image?: string; avatarUrl?: string }
  _count?: { likes: number; recaws: number }
  likes?: Array<{ userId: number; pending?: boolean }>
  recaws?: Array<{ id: number; status?: 'SUCCESS' | 'PENDING' | 'FAILED'; action?: string; content?: string }>
  repliesOnThis?: Array<{ userId: number; pending?: boolean; replyCawId?: number }>
  tips?: Array<{ senderId: number; pending?: boolean; amount?: number }>
  tipCount?: number
  totalTipAmount?: number
  bookmarks?: Array<{ userId: number }>
  bookmarkCount?: number
  commentCount: number
  recawCount: number
  likeCount: number
  viewCount?: number
  cawonce: number
  parent?: any
  hashtags?: Array<{ hashtag: { name: string } }>
  imageData?: string
  hasImage?: boolean
  status?: 'SUCCESS' | 'PENDING' | 'FAILED'
  reason?: string | null
}

export interface ShapedCaw {
  id: string
  content: string
  timestamp: string
  user: { id: number; tokenId: number; username: string; displayName?: string; image?: string; avatarUrl?: string }
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
  status?: 'SUCCESS' | 'PENDING' | 'FAILED'
  reason?: string | null
}

export function shapeCaw(raw: CawRaw): ShapedCaw {
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

  console.log(`[shapeCaw ${raw.id}] userRecawOrQuote:`, userRecawOrQuote, 'hasRecawed:', hasRecawed, 'recawPending:', recawPending, 'recawCount:', raw.recawCount)

  return {
    id: raw.id.toString(),
    content: raw.content,
    action: raw.action,
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
    commentCount: raw.commentCount,
    recawCount: raw.recawCount,
    cawonce: raw.cawonce,
    hashtags: raw.hashtags?.map(h => h.hashtag.name) || [],
    originalCaw: raw.parent ? shapeCaw(raw.parent) : undefined,
    parent: raw.parent ? shapeCaw(raw.parent) : null,
    imageData: raw.imageData,
    hasImage: raw.hasImage,
    status: raw.status || 'SUCCESS',
    reason: raw.reason,
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

export function getCawIncludeConfig(options: CawQueryOptions = {}) {
  const { currentUserId, includeHashtags = false } = options

  return {
    user: { select: { id: true, tokenId: true, username: true, displayName: true, image: true, avatarUrl: true } },
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
    ...(includeHashtags && {
      hashtags: {
        include: { hashtag: { select: { name: true } } }
      }
    }),
    parent: {
      include: {
        user: { select: { id: true, tokenId: true, username: true, displayName: true, image: true, avatarUrl: true } },
        ...(includeHashtags && {
          hashtags: {
            include: { hashtag: { select: { name: true } } }
          }
        })
      }
    }
  }
}