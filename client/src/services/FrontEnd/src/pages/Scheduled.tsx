import React, { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useAccount } from "wagmi"
import { useConnectModal } from "@rainbow-me/rainbowkit"
import { HiOutlineClock, HiOutlineTrash, HiOutlineCheck, HiOutlineXCircle, HiChevronDown, HiChevronRight, HiOutlineInformationCircle, HiOutlineEye, HiOutlinePhotograph, HiOutlineX } from "react-icons/hi"
import { useActiveToken } from '~/store/tokenDataStore'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '~/api/client'
import { useAuthStore } from '~/store/authStore'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import { formatDistanceToNow, format, isPast } from 'date-fns'
import ContentWithHashtags from '~/components/ContentWithHashtags'
import { useT } from '~/i18n/I18nProvider'

interface ScheduledCaw {
  id: number
  userId: number
  content: string
  scheduledAt: string
  status: 'pending' | 'published' | 'failed' | 'cancelled'
  publishedId: number | null
  imageData?: string | null
  hasImage: boolean
  createdAt: string
  threadId: string | null
  threadIndex: number | null
  threadTotal: number | null
  user: {
    tokenId: number
    username: string
    displayName?: string
    avatarUrl?: string
  }
}

// One row in the rendered list — either a single scheduled caw or a thread
// group. For a group, items[] is sorted by threadIndex ascending.
type Row =
  | { kind: 'single'; item: ScheduledCaw }
  | { kind: 'thread'; threadId: string; items: ScheduledCaw[] }

// Minimal media URL detection (mirrors ContentWithHashtags patterns) so the
// Scheduled list can stay compact even when content includes media URLs.
const SHORT_URL_WITH_MEDIA_EXT = /(?:https?:\/\/[^\s]+)?\/s\/[a-zA-Z0-9]+\.(?:gif|jpg|jpeg|png|webp|mp4|webm|mov)\b/gi
const SHORT_URL_WITH_MEDIA_EXT_TEST = /(?:https?:\/\/[^\s]+)?\/s\/[a-zA-Z0-9]+\.(?:gif|jpg|jpeg|png|webp|mp4|webm|mov)\b/i
const DIRECT_IMAGE_URL = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s<>"{}|\\^`\[\]]*)?/gi
const DIRECT_IMAGE_URL_TEST = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s<>"{}|\\^`\[\]]*)?/i

function hasMediaInContent(content: string): boolean {
  return SHORT_URL_WITH_MEDIA_EXT_TEST.test(content) || DIRECT_IMAGE_URL_TEST.test(content)
}

function stripMediaFromContent(content: string): string {
  // Remove media URLs (keep other links as-is).
  const withoutMedia = content
    .replace(SHORT_URL_WITH_MEDIA_EXT, '')
    .replace(DIRECT_IMAGE_URL, (m) => (m.includes('/s/') ? m : ''))
  return withoutMedia
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function ScheduledMedia({ imageData }: { imageData?: string | null }) {
  if (!imageData) return null

  const renderGrid = (urls: string[], kind: 'url' | 'base64') => {
    const count = urls.length
    if (count <= 0) return null

    const gridClass =
      count === 1
        ? 'w-full'
        : count === 2
          ? 'grid grid-cols-2 gap-1.5 aspect-video rounded-lg overflow-hidden'
          : 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden'

    const cellClass = (i: number) => (count === 3 && i === 0 ? 'row-span-2 w-full h-full' : 'w-full h-full')

    if (count === 1) {
      const src = kind === 'base64' ? `data:image/jpeg;base64,${urls[0]}` : urls[0]
      return (
        <div className="w-full rounded-lg overflow-hidden">
          <img src={src} alt="Scheduled media" className="block w-full max-h-96 h-auto object-contain" />
        </div>
      )
    }

    return (
      <div className={gridClass}>
        {urls.slice(0, 4).map((u, idx) => {
          const src = kind === 'base64' ? `data:image/jpeg;base64,${u}` : u
          return (
            <div key={idx} className={`relative w-full h-full overflow-hidden ${cellClass(idx)}`}>
              <img src={src} alt={`Scheduled media ${idx + 1}`} className="block w-full h-full object-cover" />
              {urls.length > 4 && idx === 3 && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-xl font-semibold pointer-events-none">
                  +{urls.length - 4}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  if (imageData.startsWith('urls:')) {
    const urls = imageData.replace('urls:', '').split('|||').filter(Boolean)
    return <div className="mb-3">{renderGrid(urls, 'url')}</div>
  }

  const images = imageData.split('|||').filter(Boolean)
  return <div className="mb-3">{renderGrid(images, 'base64')}</div>
}

// Bucket the API response into rows: single posts stay as-is; chunks sharing a
// threadId collapse into one thread row anchored on chunk 0's scheduled time.
function groupIntoRows(items: ScheduledCaw[]): Row[] {
  const threads = new Map<string, ScheduledCaw[]>()
  const rows: Row[] = []
  for (const it of items) {
    if (it.threadId) {
      const arr = threads.get(it.threadId) ?? []
      arr.push(it)
      threads.set(it.threadId, arr)
    } else {
      rows.push({ kind: 'single', item: it })
    }
  }
  for (const [threadId, arr] of threads) {
    arr.sort((a, b) => (a.threadIndex ?? 0) - (b.threadIndex ?? 0))
    rows.push({ kind: 'thread', threadId, items: arr })
  }
  // Order rows by their representative scheduledAt (chunk 0 for threads).
  rows.sort((a, b) => {
    const at = a.kind === 'single' ? a.item.scheduledAt : a.items[0].scheduledAt
    const bt = b.kind === 'single' ? b.item.scheduledAt : b.items[0].scheduledAt
    return new Date(at).getTime() - new Date(bt).getTime()
  })
  return rows
}

const ScheduledPage: React.FC = () => {
  const t = useT()
  const { isDark } = useTheme()
  const [activeTab, setActiveTab] = useState<'pending' | 'published' | 'failed'>('pending')
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set())
  const [previewRow, setPreviewRow] = useState<Row | null>(null)
  const toggleThread = (threadId: string) => {
    setExpandedThreads(prev => {
      const next = new Set(prev)
      if (next.has(threadId)) next.delete(threadId)
      else next.add(threadId)
      return next
    })
  }
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const activeToken = useActiveToken()
  const queryClient = useQueryClient()
  const authorizedTokenIds = useAuthStore(s => s.authorizedTokenIds)
  const { verify, isVerifying, error: verifyError } = useVerifyWallet()
  const isAuthorized = activeToken?.tokenId !== undefined && authorizedTokenIds.includes(activeToken.tokenId)

  const { data: scheduledData, isLoading } = useQuery({
    queryKey: ['scheduled', activeToken?.tokenId, activeTab],
    queryFn: async () => {
      if (!activeToken?.tokenId) return { items: [] }
      const response = await apiFetch(`/api/scheduled?status=${activeTab}`, {
        headers: { 'x-user-id': activeToken.tokenId.toString() }
      })
      return response as { items: ScheduledCaw[], nextCursor?: number }
    },
    enabled: !!activeToken?.tokenId,
    refetchInterval: 30000, // Refresh every 30 seconds
  })

  const rows: Row[] = useMemo(
    () => groupIntoRows(scheduledData?.items ?? []),
    [scheduledData]
  )

  const cancelMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiFetch(`/api/scheduled/${id}`, {
        method: 'DELETE',
        headers: { 'x-user-id': activeToken!.tokenId.toString() }
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] })
    }
  })

  const tabs = [
    { id: 'pending' as const, label: t('scheduled.tab.pending'), count: 0 },
    { id: 'published' as const, label: t('scheduled.tab.published'), count: 0 },
    { id: 'failed' as const, label: t('scheduled.tab.failed'), count: 0 },
  ]

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return <HiOutlineClock className="w-4 h-4 text-yellow-500" />
      case 'published':
        return <HiOutlineCheck className="w-4 h-4 text-green-500" />
      case 'failed':
        return <HiOutlineXCircle className="w-4 h-4 text-red-500" />
      default:
        return null
    }
  }

  const getStatusText = (item: ScheduledCaw) => {
    const scheduledDate = new Date(item.scheduledAt)

    switch (item.status) {
      case 'pending':
        if (isPast(scheduledDate)) {
          return t('scheduled.status.processing')
        }
        return t('scheduled.status.scheduled_for', { date: format(scheduledDate, 'MMM d, yyyy h:mm a') })
      case 'published':
        return t('scheduled.status.published_ago', { ago: formatDistanceToNow(scheduledDate, { addSuffix: true }) })
      case 'failed':
        return t('scheduled.status.failed')
      case 'cancelled':
        return t('scheduled.status.cancelled')
      default:
        return ''
    }
  }

  // Show sign-in prompt only when there's no active profile at all.
  // If activeToken exists (e.g. via Quick Sign session), the user is "logged in"
  // even if the wallet isn't currently connected — fall through to the page.
  if (!activeToken) {
    return (
      <MainLayout>
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className={`text-center py-16 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            <HiOutlineClock className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <h2 className={`text-xl font-semibold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
              {t('scheduled.title')}
            </h2>
            <p className="mb-4">{t('scheduled.signin_prompt')}</p>
            <button
              onClick={openConnectModal}
              className="px-6 py-2 bg-yellow-500 hover:bg-yellow-400 text-black font-medium rounded-full transition-colors cursor-pointer"
            >
              {t('common.sign_in')}
            </button>
          </div>
        </div>
      </MainLayout>
    )
  }

  if (!isAuthorized) {
    return (
      <MainLayout>
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className={`text-center py-16 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            <HiOutlineClock className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <h2 className={`text-xl font-semibold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
              {t('scheduled.verify.title')}
            </h2>
            <p className="mb-4">{t('scheduled.verify.description')}</p>
            {verifyError && (
              <p className="mb-4 text-red-500 text-sm">{verifyError}</p>
            )}
            <button
              onClick={verify}
              disabled={isVerifying}
              className={`px-6 py-2 bg-yellow-500 hover:bg-yellow-400 text-black font-medium rounded-full transition-colors cursor-pointer ${
                isVerifying ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {isVerifying ? t('messages.signin.signing') : t('scheduled.verify.button')}
            </button>
          </div>
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Page Header */}
        <div className="mb-6">
          <h1 className={`text-2xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {t('scheduled.title')}
          </h1>
          <div className={`flex items-center gap-2 mt-2 text-sm ${
            isDark ? 'text-gray-400' : 'text-gray-500'
          }`}>
            <HiOutlineInformationCircle className="w-4 h-4 flex-shrink-0" />
            <span>{t('scheduled.subtitle')}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className={`flex border-b mb-4 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-4 py-3 font-medium text-sm transition-colors relative cursor-pointer ${
                activeTab === tab.id
                  ? isDark ? 'text-white' : 'text-black'
                  : isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yellow-500" />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        {isLoading ? (
          <div className={`text-center py-8 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('common.loading')}
          </div>
        ) : !scheduledData?.items?.length ? (
          <div className="text-center py-12">
            <HiOutlineClock className={`w-12 h-12 mx-auto mb-4 opacity-30 ${
              isDark ? 'text-white' : 'text-black'
            }`} />
            <h3 className={`text-lg font-semibold mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {activeTab === 'pending' && t('scheduled.empty.pending')}
              {activeTab === 'published' && t('scheduled.empty.published')}
              {activeTab === 'failed' && t('scheduled.empty.failed')}
            </h3>
            <p className={`transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              {activeTab === 'pending' && t('scheduled.empty.pending_hint')}
              {activeTab === 'published' && t('scheduled.empty.published_hint')}
              {activeTab === 'failed' && t('scheduled.empty.failed_hint')}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {rows.map((row) => {
              const cardClass = `p-4 rounded-xl border transition-colors ${
                isDark
                  ? 'bg-white/5 border-white/10 hover:bg-white/10'
                  : 'bg-white border-gray-200 hover:bg-gray-50'
              }`
              if (row.kind === 'single') {
                const item = row.item
                const hasMedia = item.hasImage || !!item.imageData || hasMediaInContent(item.content)
                const displayText = stripMediaFromContent(item.content)
                return (
                  <div key={item.id} className={cardClass}>
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className={`min-w-0 flex-1 text-sm leading-snug whitespace-pre-wrap break-words line-clamp-3 ${isDark ? 'text-white' : 'text-black'}`}>
                        {displayText || <span className={isDark ? 'text-white/50' : 'text-black/50'}>(no text)</span>}
                      </div>
                      {hasMedia && (
                        <div className={`mt-0.5 flex-shrink-0 ${isDark ? 'text-white/50' : 'text-black/40'}`} title="Has media">
                          <HiOutlinePhotograph className="w-5 h-5" />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(item.status)}
                        <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                          {getStatusText(item)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {(item.status === 'pending' || item.status === 'failed') && (
                          <button
                            type="button"
                            onClick={() => setPreviewRow({ kind: 'single', item })}
                            className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm transition-colors cursor-pointer ${
                              isDark ? 'text-gray-200 hover:bg-white/10' : 'text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            <HiOutlineEye className="w-4 h-4" />
                            View
                          </button>
                        )}
                        {item.status === 'pending' && (
                          <button
                            type="button"
                            onClick={() => cancelMutation.mutate(item.id)}
                            disabled={cancelMutation.isPending}
                            className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm transition-colors ${
                              isDark ? 'text-red-400 hover:bg-red-500/20' : 'text-red-600 hover:bg-red-50'
                            } ${cancelMutation.isPending ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                          >
                            <HiOutlineTrash className="w-4 h-4" />
                            Cancel
                          </button>
                        )}
                        {item.status === 'published' && item.publishedId && (
                          <Link
                            to={`/caws/${item.publishedId}`}
                            className={`text-sm px-3 py-1.5 rounded-full transition-colors ${
                              isDark ? 'text-yellow-400 hover:bg-yellow-500/20' : 'text-yellow-600 hover:bg-yellow-50'
                            }`}
                          >
                            View Post
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                )
              }

              // Thread row — collapsed by default, shows chunk 0 as preview;
              // expanding reveals the remaining chunks. Cancel acts on chunk 0
              // (the API cascade-cancels every still-pending chunk by threadId).
              const expanded = expandedThreads.has(row.threadId)
              const head = row.items[0]
              const threadHasMedia = row.items.some(it => it.hasImage || !!it.imageData || hasMediaInContent(it.content))
              const headDisplayText = stripMediaFromContent(head.content)
              const total = head.threadTotal ?? row.items.length
              // Status to display for the thread as a whole: any failed → failed,
              // else any pending → pending, else any cancelled → cancelled, else published.
              const aggregateStatus: ScheduledCaw['status'] =
                row.items.find(i => i.status === 'failed')?.status ??
                row.items.find(i => i.status === 'pending')?.status ??
                row.items.find(i => i.status === 'cancelled')?.status ??
                'published'
              const headForStatus: ScheduledCaw = { ...head, status: aggregateStatus }
              return (
                <div key={`thread-${row.threadId}`} className={cardClass}>
                  <button
                    type="button"
                    onClick={() => toggleThread(row.threadId)}
                    className={`flex items-center gap-2 mb-2 text-xs font-medium ${
                      isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {expanded ? <HiChevronDown className="w-4 h-4" /> : <HiChevronRight className="w-4 h-4" />}
                    Thread ({total} posts)
                  </button>

                  <div className={`mb-3 ${isDark ? 'text-white' : 'text-black'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className={`min-w-0 flex-1 text-sm leading-snug whitespace-pre-wrap break-words line-clamp-3 ${isDark ? 'text-white' : 'text-black'}`}>
                        {headDisplayText || <span className={isDark ? 'text-white/50' : 'text-black/50'}>(no text)</span>}
                      </div>
                      {threadHasMedia && (
                        <div className={`mt-0.5 flex-shrink-0 ${isDark ? 'text-white/50' : 'text-black/40'}`} title="Has media">
                          <HiOutlinePhotograph className="w-5 h-5" />
                        </div>
                      )}
                    </div>
                  </div>

                  {expanded && row.items.slice(1).map((chunk, idx) => {
                    const chunkDisplayText = stripMediaFromContent(chunk.content)
                    return (
                    <div
                      key={chunk.id}
                      className={`mt-3 pt-3 border-t ${isDark ? 'border-white/10 text-white' : 'border-gray-200 text-black'}`}
                    >
                      <div className={`text-[11px] mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {idx + 2} / {total}
                      </div>
                      <div className={`text-sm leading-snug whitespace-pre-wrap break-words line-clamp-3 ${isDark ? 'text-white' : 'text-black'}`}>
                        {chunkDisplayText || <span className={isDark ? 'text-white/50' : 'text-black/50'}>(no text)</span>}
                      </div>
                    </div>
                  )})}

                  <div className="flex items-center justify-between mt-3">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(aggregateStatus)}
                      <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                        {getStatusText(headForStatus)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {(aggregateStatus === 'pending' || aggregateStatus === 'failed') && (
                        <button
                          type="button"
                          onClick={() => setPreviewRow({ kind: 'thread', threadId: row.threadId, items: row.items })}
                          className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm transition-colors cursor-pointer ${
                            isDark ? 'text-gray-200 hover:bg-white/10' : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          <HiOutlineEye className="w-4 h-4" />
                          View
                        </button>
                      )}
                      {aggregateStatus === 'pending' && (
                        <button
                          type="button"
                          onClick={() => cancelMutation.mutate(head.id)}
                          disabled={cancelMutation.isPending}
                          className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm transition-colors ${
                            isDark ? 'text-red-400 hover:bg-red-500/20' : 'text-red-600 hover:bg-red-50'
                          } ${cancelMutation.isPending ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                          Cancel thread
                        </button>
                      )}
                      {aggregateStatus === 'published' && head.publishedId && (
                        <Link
                          to={`/caws/${head.publishedId}`}
                          className={`text-sm px-3 py-1.5 rounded-full transition-colors ${
                            isDark ? 'text-yellow-400 hover:bg-yellow-500/20' : 'text-yellow-600 hover:bg-yellow-50'
                          }`}
                        >
                          View Thread
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {previewRow && (
          <div className="fixed inset-0 z-[80]">
            <div className="absolute inset-0 bg-black/60" />

            {/* Align to the app's 3-column shell (sidebar/main/trending) so the modal
                doesn't feel off-center on wide desktops. */}
            <div
              className="absolute inset-0 flex items-center justify-center"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setPreviewRow(null)
              }}
              onTouchStart={(e) => {
                if (e.target === e.currentTarget) setPreviewRow(null)
              }}
            >
              <div className="w-full max-w-[1050px] mx-auto px-6 flex">
                <div className="hidden md:block w-[200px]" />
                <div className="flex-1 flex justify-center">
                  <div
                    className={`relative z-10 w-full max-w-lg rounded-2xl border shadow-xl ${
                      isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'
                    }`}
                  >
                    <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'border-gray-200'} flex items-center justify-between`}>
                <div>
                  <div className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    Preview
                  </div>
                  <div className={`text-xs mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {previewRow.kind === 'single'
                      ? getStatusText(previewRow.item)
                      : `Thread (${previewRow.items[0].threadTotal ?? previewRow.items.length} posts) • ${getStatusText({ ...previewRow.items[0], status: previewRow.items.find(i => i.status === 'failed')?.status ?? previewRow.items.find(i => i.status === 'pending')?.status ?? previewRow.items.find(i => i.status === 'cancelled')?.status ?? 'published' })}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewRow(null)}
                  aria-label="Close preview"
                  className={`p-2 rounded-full transition-colors cursor-pointer ${
                    isDark ? 'text-white/70 hover:bg-white/10' : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <HiOutlineX className="w-5 h-5" />
                </button>
                    </div>

                    <div className="p-4 max-h-[70vh] overflow-y-auto">
                      {previewRow.kind === 'single' ? (
                        <div className={isDark ? 'text-white' : 'text-black'}>
                          <ScheduledMedia imageData={previewRow.item.imageData} />
                          <ContentWithHashtags
                            content={previewRow.item.content}
                            renderMedia={!previewRow.item.imageData}
                          />
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {previewRow.items.map((chunk, idx) => (
                            <div key={chunk.id}>
                              <div className={`text-[11px] mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                {idx + 1} / {previewRow.items[0].threadTotal ?? previewRow.items.length}
                              </div>
                              <div className={isDark ? 'text-white' : 'text-black'}>
                                <ScheduledMedia imageData={chunk.imageData} />
                                <ContentWithHashtags
                                  content={chunk.content}
                                  renderMedia={!chunk.imageData}
                                />
                              </div>
                              {idx !== previewRow.items.length - 1 && (
                                <div className={`mt-4 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`} />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="hidden lg:block w-[280px]" />
              </div>
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default ScheduledPage
