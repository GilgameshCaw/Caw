// src/api/shared/cawUtils.ts
import { prisma } from '../../prismaClient'

export interface CawRaw {
  id: number
  content: string
  createdAt: Date
  user: { tokenId: number; username: string; displayName?: string; image?: string; avatarUrl?: string }
  _count?: { likes: number; recaws: number }
  likes?: Array<{ userId: number; pending?: boolean }>
  recaws?: Array<{ id: number; status?: 'SUCCESS' | 'PENDING' | 'FAILED' }>
  repliesOnThis?: Array<{ userId: number; pending?: boolean }>
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
}

export interface ShapedCaw {
  id: string
  content: string
  timestamp: string
  user: { tokenId: number; username: string; displayName?: string; image?: string; avatarUrl?: string }
  likeCount: number
  viewCount: number
  hasLiked: boolean
  hasRecawed: boolean
  hasReplied: boolean
  isBookmarked?: boolean
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
}

export function shapeCaw(raw: CawRaw): ShapedCaw {
  const userLike = raw.likes && raw.likes[0]
  const userRecaw = raw.recaws && raw.recaws[0]
  const userReply = raw.repliesOnThis && raw.repliesOnThis[0]

  const hasRecawed = Boolean(userRecaw && userRecaw.status !== 'PENDING' && userRecaw.status !== 'FAILED')
  const recawPending = userRecaw?.status === 'PENDING'

  const hasReplied = Boolean(userReply && !userReply.pending)
  const replyPending = userReply?.pending

  console.log(`[shapeCaw ${raw.id}] userRecaw:`, userRecaw, 'hasRecawed:', hasRecawed, 'recawPending:', recawPending, 'recawCount:', raw.recawCount)

  return {
    id: raw.id.toString(),
    content: raw.content,
    timestamp: raw.createdAt.toISOString(),
    user: raw.user,
    likeCount: raw.likeCount,
    viewCount: raw.viewCount || 0,
    hasLiked: Boolean(userLike && !userLike.pending), // Only true if liked AND not pending
    likePending: userLike?.pending,
    hasRecawed, // Only true if recawed AND confirmed
    recawPending,
    hasReplied, // Only true if replied AND confirmed
    replyPending,
    // isBookmarked is now handled client-side (localStorage)
    commentCount: raw.commentCount,
    recawCount: raw.recawCount,
    cawonce: raw.cawonce,
    hashtags: raw.hashtags?.map(h => h.hashtag.name) || [],
    originalCaw: raw.parent ? shapeCaw(raw.parent) : undefined,
    parent: raw.parent ? shapeCaw(raw.parent) : null,
    imageData: raw.imageData,
    hasImage: raw.hasImage,
    status: raw.status || 'SUCCESS',
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
    user: { select: { tokenId: true, username: true, displayName: true, image: true, avatarUrl: true } },
    likes: currentUserId
      ? { where: { userId: currentUserId }, select: { userId: true, pending: true } }
      : false,
    recaws: currentUserId
      ? { where: { userId: currentUserId, action: 'RECAW' }, select: { id: true, status: true } }
      : false,
    repliesOnThis: currentUserId
      ? { where: { userId: currentUserId }, select: { userId: true, pending: true } }
      : false,
    // bookmarks are now handled client-side (localStorage)
    ...(includeHashtags && {
      hashtags: {
        include: { hashtag: { select: { name: true } } }
      }
    }),
    parent: {
      include: {
        user: { select: { tokenId: true, username: true, displayName: true, image: true, avatarUrl: true } },
        ...(includeHashtags && {
          hashtags: {
            include: { hashtag: { select: { name: true } } }
          }
        })
      }
    }
  }
}