// src/api/shared/cawUtils.ts
import { prisma } from '../../prismaClient'

export interface CawRaw {
  id: number
  content: string
  createdAt: Date
  user: { tokenId: number; username: string; image?: string }
  _count?: { likes: number; recaws: number }
  likes?: Array<{ userId: number; pending?: boolean }>
  recaws?: Array<{ id: number }>
  bookmarks?: Array<{ id: number }>
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
  user: { tokenId: number; username: string; image?: string }
  likeCount: number
  viewCount: number
  hasLiked: boolean
  hasRecawed: boolean
  isBookmarked?: boolean
  likePending?: boolean
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
  return {
    id: raw.id.toString(),
    content: raw.content,
    timestamp: raw.createdAt.toISOString(),
    user: raw.user,
    likeCount: raw.likeCount,
    viewCount: raw.viewCount || 0,
    hasLiked: Boolean(userLike),
    likePending: userLike?.pending,
    hasRecawed: Boolean(raw.recaws && raw.recaws.length > 0),
    isBookmarked: Boolean(raw.bookmarks && raw.bookmarks.length > 0),
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
    user: { select: { tokenId: true, username: true, image: true } },
    likes: currentUserId
      ? { where: { userId: currentUserId }, select: { userId: true, pending: true } }
      : false,
    recaws: currentUserId
      ? { where: { userId: currentUserId, action: 'RECAW' }, select: { id: true } }
      : false,
    bookmarks: currentUserId
      ? { where: { userId: currentUserId }, select: { id: true } }
      : false,
    ...(includeHashtags && {
      hashtags: {
        include: { hashtag: { select: { name: true } } }
      }
    }),
    parent: {
      include: {
        user: { select: { tokenId: true, username: true, image: true } },
        ...(includeHashtags && {
          hashtags: {
            include: { hashtag: { select: { name: true } } }
          }
        })
      }
    }
  }
}