import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { Link } from '~/utils/localizedRouter'
const PAGE_SIZE = 50

interface Report {
  id: number
  reporterId: number
  postId: number
  postAuthorId: number
  reason: string
  details: string | null
  status: string
  reviewedAt: string | null
  reviewedBy: string | null
  resolution: string | null
  createdAt: string
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-yellow-500/20 text-yellow-600',
  REVIEWED: 'bg-blue-500/20 text-blue-600',
  ACTIONED: 'bg-green-500/20 text-green-600',
  DISMISSED: 'bg-gray-500/20 text-gray-500'
}

const REASON_LABELS: Record<string, string> = {
  SPAM: 'Spam',
  HARASSMENT: 'Harassment',
  INAPPROPRIATE: 'Inappropriate',
  EXPLICIT: 'Explicit',
  ILLEGAL_HARMFUL: 'Illegal / Harmful',
  MISINFORMATION: 'Misinformation',
  OTHER: 'Other'
}

const REASON_COLORS: Record<string, string> = {
  EXPLICIT: 'bg-orange-500/10 text-orange-400',
  ILLEGAL_HARMFUL: 'bg-red-600/20 text-red-500',
}

const ReportsAdmin: React.FC = () => {
  const { isDark } = useTheme()
  const [reports, setReports] = useState<Report[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [reasonFilter, setReasonFilter] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // Single-flight fetch. `mode === 'reset'` replaces the list (initial
  // load + filter change). `mode === 'append'` paginates from the
  // current list length. Tracks hasMore via "got fewer than PAGE_SIZE".
  const fetchPage = useCallback(async (mode: 'reset' | 'append') => {
    if (mode === 'reset') setLoading(true)
    else setLoadingMore(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (reasonFilter) params.set('reason', reasonFilter)
      params.set('limit', String(PAGE_SIZE))
      const offset = mode === 'append' ? reports.length : 0
      params.set('offset', String(offset))
      const data = await apiFetch<{ reports: Report[]; total: number }>(`/api/reports?${params}`)
      setReports(prev => (mode === 'append' ? [...prev, ...data.reports] : data.reports))
      setTotal(data.total)
      setHasMore(data.reports.length === PAGE_SIZE)
    } catch {
      setError('Failed to load reports')
    } finally {
      if (mode === 'reset') setLoading(false)
      else setLoadingMore(false)
    }
  }, [statusFilter, reasonFilter, reports.length])

  // Mutations re-fetch from offset 0 to pull in any status changes.
  // Avoids splicing local state and risking drift from server-side
  // reordering.
  const updateStatus = async (id: number, status: string, resolution?: string) => {
    try {
      await apiFetch(`/api/reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, resolution })
      })
      fetchPage('reset')
    } catch {
      setError('Failed to update')
    }
  }

  // Filter change → reset list.
  useEffect(() => {
    setReports([])
    fetchPage('reset')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, reasonFilter])

  // Infinite scroll: observe a sentinel node at the end of the list.
  // 200px rootMargin so we kick off fetching before the user actually
  // hits the bottom. Skip if already loading or known-exhausted.
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    if (!hasMore || loading || loadingMore) return
    const obs = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) fetchPage('append')
      },
      { rootMargin: '200px' }
    )
    obs.observe(node)
    return () => obs.disconnect()
  }, [hasMore, loading, loadingMore, fetchPage])

  const formatDate = (d: string) => new Date(d).toLocaleString()

  return (
    <div className={`min-h-screen p-6 ${isDark ? 'bg-black text-white' : 'bg-gray-50 text-gray-900'}`}>
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link to="/admin" className={`text-sm ${isDark ? 'text-white/40 hover:text-white/60' : 'text-gray-400 hover:text-gray-600'}`}>Admin</Link>
            <span className={isDark ? 'text-white/20' : 'text-gray-300'}>/</span>
            <h1 className="text-2xl font-bold">Post Reports ({total})</h1>
          </div>
          <div className="flex gap-2">
            {['', 'PENDING', 'REVIEWED', 'ACTIONED', 'DISMISSED'].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                  statusFilter === s
                    ? 'bg-blue-500 text-white'
                    : isDark ? 'bg-white/10 text-white/60 hover:bg-white/20' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                }`}
              >
                {s || 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* Reason filter */}
        <div className="flex gap-2 mb-4 flex-wrap">
          {['', 'EXPLICIT', 'ILLEGAL_HARMFUL', 'SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'MISINFORMATION', 'OTHER'].map(r => (
            <button
              key={r}
              onClick={() => setReasonFilter(r)}
              className={`px-3 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                reasonFilter === r
                  ? r === 'EXPLICIT' ? 'bg-orange-500 text-white'
                    : r === 'ILLEGAL_HARMFUL' ? 'bg-red-600 text-white'
                    : 'bg-blue-500 text-white'
                  : isDark ? 'bg-white/10 text-white/60 hover:bg-white/20' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
              }`}
            >
              {REASON_LABELS[r] || 'All Reasons'}
            </button>
          ))}
        </div>

        {loading ? (
          <p className={isDark ? 'text-white/40' : 'text-gray-400'}>Loading...</p>
        ) : reports.length === 0 ? (
          <p className={isDark ? 'text-white/40' : 'text-gray-400'}>No reports found.</p>
        ) : (
          <div className="space-y-3">
            {reports.map(report => (
              <div
                key={report.id}
                className={`rounded-xl border p-4 transition-colors ${
                  isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white'
                }`}
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`text-xs font-mono ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                        #{report.id}
                      </span>
                      <span className={`px-2 py-0.5 text-xs rounded-full ${STATUS_COLORS[report.status] || ''}`}>
                        {report.status}
                      </span>
                      <span className={`px-2 py-0.5 text-xs rounded-full ${REASON_COLORS[report.reason] || 'bg-red-500/10 text-red-400'}`}>
                        {REASON_LABELS[report.reason] || report.reason}
                      </span>
                      <span className={`text-xs ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                        {formatDate(report.createdAt)}
                      </span>
                    </div>

                    {/* Post and user links */}
                    <div className="flex items-center gap-3 mt-1">
                      <Link
                        to={`/caws/${report.postId}`}
                        className="text-sm text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        View Post #{report.postId}
                      </Link>
                      <span className={`text-xs ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                        Author ID: {report.postAuthorId}
                      </span>
                      <span className={`text-xs ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                        Reporter ID: {report.reporterId}
                      </span>
                    </div>

                    {/* Details */}
                    {report.details && (
                      <p className={`text-sm mt-2 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                        {report.details}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => setExpandedId(expandedId === report.id ? null : report.id)}
                    className={`text-xs px-2 py-1 rounded transition-colors cursor-pointer ${
                      isDark ? 'hover:bg-white/10 text-white/40' : 'hover:bg-gray-100 text-gray-400'
                    }`}
                  >
                    {expandedId === report.id ? 'Less' : 'More'}
                  </button>
                </div>

                {/* Actions */}
                <div className="flex gap-2 mt-3 flex-wrap">
                  {report.status !== 'REVIEWED' && (
                    <button
                      onClick={() => updateStatus(report.id, 'REVIEWED')}
                      className="px-3 py-1 text-xs bg-blue-500/20 text-blue-500 rounded-full hover:bg-blue-500/30 transition-colors cursor-pointer"
                    >
                      Mark Reviewed
                    </button>
                  )}
                  {report.status !== 'ACTIONED' && (
                    <button
                      onClick={() => {
                        const note = prompt('Resolution note (optional):')
                        updateStatus(report.id, 'ACTIONED', note || undefined)
                      }}
                      className="px-3 py-1 text-xs bg-green-500/20 text-green-500 rounded-full hover:bg-green-500/30 transition-colors cursor-pointer"
                    >
                      Action
                    </button>
                  )}
                  {report.status !== 'DISMISSED' && (
                    <button
                      onClick={() => updateStatus(report.id, 'DISMISSED')}
                      className="px-3 py-1 text-xs bg-gray-500/20 text-gray-500 rounded-full hover:bg-gray-500/30 transition-colors cursor-pointer"
                    >
                      Dismiss
                    </button>
                  )}
                  {report.status !== 'PENDING' && (
                    <button
                      onClick={() => updateStatus(report.id, 'PENDING')}
                      className="px-3 py-1 text-xs bg-yellow-500/20 text-yellow-500 rounded-full hover:bg-yellow-500/30 transition-colors cursor-pointer"
                    >
                      Reopen
                    </button>
                  )}
                </div>

                {/* Expanded details */}
                {expandedId === report.id && (
                  <div className={`mt-3 pt-3 border-t text-xs space-y-1 ${
                    isDark ? 'border-white/10 text-white/30' : 'border-gray-100 text-gray-400'
                  }`}>
                    {report.resolution && <p>Resolution: {report.resolution}</p>}
                    {report.reviewedBy && <p>Reviewed by: {report.reviewedBy}</p>}
                    {report.reviewedAt && <p>Reviewed: {formatDate(report.reviewedAt)}</p>}
                  </div>
                )}
              </div>
            ))}
            {/* Infinite-scroll sentinel + load-more affordance. */}
            <div ref={sentinelRef} className="h-4" />
            {loadingMore && (
              <p className={`text-center text-sm py-2 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                Loading more…
              </p>
            )}
            {!hasMore && reports.length > 0 && reports.length >= total && (
              <p className={`text-center text-xs py-2 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                End of list ({total} total)
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default ReportsAdmin
