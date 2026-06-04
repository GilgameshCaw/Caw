import { create } from 'zustand'
import type { CawItem } from '~/types'
import { parsePoll } from '~/../../../tools/pollMarker'

interface PendingPost extends Partial<CawItem> {
  tempId: string
  content: string
  timestamp: string
  status: 'PENDING' | 'FAILED' | 'SUCCESS'
  isPending: boolean
  isFailed?: boolean // Track if the post failed to submit
  txQueueId?: number // Track the associated txQueue ID
  replyToId?: string
}

interface PendingPostsStore {
  pendingPosts: PendingPost[]
  addPendingPost: (post: { content: string; username: string; tokenId: number; displayName?: string; image?: string; avatarUrl?: string; replyToId?: string; parent?: CawItem; cawonce?: number; isQuote?: boolean; action?: string; pollOptionImages?: string[]; commentCount?: number }) => string
  updatePostWithTxQueueId: (tempId: string, txQueueId: number) => void
  /** Update a pending post's id once the real caw ID is known */
  updatePostId: (cawonce: number, userId: number, realId: string) => void
  /**
   * Bump the like/reply/recaw counter (and matching hasX flag) on a pending
   * caw when the current user acts against it. Match by (userId, cawonce) —
   * stable across the pending→confirmed swap. Without this, navigating away
   * from the home feed loses the per-FeedItem optimistic overrides; the
   * pending caw on profile renders with the frozen-at-creation zeros.
   */
  bumpCounterOnPending: (targetUserId: number, targetCawonce: number, kind: 'like' | 'reply' | 'recaw', delta: 1 | -1) => void
  markPostAsFailed: (txQueueId: number) => void
  markPostAsConfirmed: (txQueueId: number) => void
  removePendingPost: (tempId: string) => void
  removePendingPostByTxQueueId: (txQueueId: number) => void
  clearPendingPosts: () => void
}

export const usePendingPostsStore = create<PendingPostsStore>((set) => ({
  pendingPosts: [],

  addPendingPost: (post) => {
    const tempId = `pending-${Date.now()}-${Math.random()}`

    // If the content carries a ::poll:...:: marker, synthesize a poll
    // shape locally so PollDisplay can render the empty 0-vote state
    // immediately. The real Poll row gets created by either the API
    // submit path (optimistic) or the indexer; once it confirms and the
    // pending post is replaced by the indexed CawItem, the server-side
    // poll shape (with optionVoteCounts + userVote) takes over.
    const parsedPoll = parsePoll(post.content)
    const synthesizedPoll = parsedPoll
      ? {
          options: parsedPoll.options,
          // Mirror the same positional-pad-to-options-length the server
          // applies in shapeCaw. Caller passes an explicit array when
          // images were uploaded; we pad/truncate so an out-of-sync
          // length never lets the UI miss a thumbnail or render a stray.
          optionImages: parsedPoll.options.map((_, i) =>
            (post.pollOptionImages?.[i]) || ''
          ),
          totalVotes: 0,
          optionVoteCounts: parsedPoll.options.map(() => 0),
          userVote: null,
        }
      : undefined

    const pendingPost: PendingPost = {
      tempId,
      id: tempId,
      content: post.content,
      timestamp: new Date().toISOString(),
      status: 'PENDING',
      user: {
        tokenId: post.tokenId,
        username: post.username,
        displayName: post.displayName,
        image: post.image,
        avatarUrl: post.avatarUrl,
        id: post.tokenId
      },
      likeCount: 0,
      // Thread first-post: caller passes commentCount = chunks.length - 1 so
      // the feed badge reflects the in-flight replies that are also being
      // optimistically created. Indexer overwrites this on confirm.
      commentCount: post.commentCount ?? 0,
      recawCount: 0,
      viewCount: 0,
      hasLiked: false,
      hasRecawed: false,
      // Thread first-post: the same user is posting the reply chunks, so
      // hasReplied should already be true optimistically. Indexer confirms
      // it (matches the post-confirm state). Inferred from commentCount > 0
      // — only set by the thread-submit path on the first chunk.
      hasReplied: (post.commentCount ?? 0) > 0,
      cawonce: post.cawonce || 0,
      isPending: true,
      replyToId: post.replyToId,
      parent: post.parent,
      isQuote: post.isQuote,
      action: post.action,
      poll: synthesizedPoll,
    }

    set((state) => ({
      pendingPosts: [pendingPost, ...state.pendingPosts]
    }))

    // Auto-remove after 30 seconds if still pending and not tracked by TxQueueMonitor
    setTimeout(() => {
      set((state) => ({
        pendingPosts: state.pendingPosts.filter(p => p.tempId !== tempId || p.txQueueId)
      }))
    }, 30000)

    return tempId
  },

  updatePostWithTxQueueId: (tempId, txQueueId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.map(post =>
        post.tempId === tempId ? { ...post, txQueueId } : post
      )
    }))
  },

  updatePostId: (cawonce, userId, realId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.map(post =>
        post.cawonce === cawonce && post.user?.tokenId === userId
          ? { ...post, id: realId }
          : post
      )
    }))
  },

  bumpCounterOnPending: (targetUserId, targetCawonce, kind, delta) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.map(post => {
        if (post.user?.tokenId !== targetUserId || post.cawonce !== targetCawonce) return post
        const next = { ...post }
        if (kind === 'like') {
          next.likeCount = Math.max(0, (post.likeCount ?? 0) + delta)
          next.hasLiked = delta > 0
        } else if (kind === 'reply') {
          next.commentCount = Math.max(0, (post.commentCount ?? 0) + delta)
          next.hasReplied = delta > 0
        } else if (kind === 'recaw') {
          next.recawCount = Math.max(0, (post.recawCount ?? 0) + delta)
          next.hasRecawed = delta > 0
        }
        return next
      })
    }))
  },

  markPostAsFailed: (txQueueId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.map(post =>
        post.txQueueId === txQueueId ? { ...post, isFailed: true } : post
      )
    }))
  },

  markPostAsConfirmed: (txQueueId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.map(post =>
        post.txQueueId === txQueueId
          ? { ...post, status: 'SUCCESS' as const, isPending: false }
          : post
      )
    }))
  },

  removePendingPostByTxQueueId: (txQueueId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.filter(p => p.txQueueId !== txQueueId)
    }))
  },

  removePendingPost: (tempId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.filter(p => p.tempId !== tempId)
    }))
  },

  clearPendingPosts: () => {
    set({ pendingPosts: [] })
  }
}))