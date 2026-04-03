import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { Link } from 'react-router-dom'
import { apiFetch } from '~/api/client'

const ADMIN_TOKEN_KEY = 'caw_admin_token'

interface Stats {
  totalUsers: number
  totalPosts: number
  postsToday: number
  newMembersThisWeek: number
  activeUsersThisWeek: number
  pendingTx: number
  failedTx: number
  pendingReports: number
  pendingBugs: number
}

const adminPages = [
  {
    path: '/admin/database',
    title: 'Database',
    description: 'Browse and edit all database tables',
    color: 'from-blue-500/20 to-blue-600/10',
    iconColor: 'text-blue-400',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
        <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
      </svg>
    ),
  },
  {
    path: '/admin/validator',
    title: 'Validator Analytics',
    description: 'Transaction costs, gas tracking, and profit/loss',
    color: 'from-green-500/20 to-green-600/10',
    iconColor: 'text-green-400',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
        <path d="M3 3v18h18" />
        <path d="M7 16l4-6 4 3 5-7" />
      </svg>
    ),
  },
  {
    path: '/admin/validator/settings',
    title: 'Validator Settings',
    description: 'Configure tips, batch sizes, and intervals',
    color: 'from-purple-500/20 to-purple-600/10',
    iconColor: 'text-purple-400',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
  {
    path: '/admin/bugs',
    title: 'Bug Reports',
    description: 'Review and manage user-submitted bug reports',
    color: 'from-yellow-500/20 to-yellow-600/10',
    iconColor: 'text-yellow-400',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
        <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1" />
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a6 6 0 0112 0v3c0 3.3-2.7 6-6 6z" />
        <path d="M12 20v2M6 13H2M22 13h-4M6 17H3.5M20.5 17H18M6 9H4M20 9h-2" />
      </svg>
    ),
  },
  {
    path: '/admin/reports',
    title: 'Content Reports',
    description: 'Review flagged posts and user reports',
    color: 'from-red-500/20 to-red-600/10',
    iconColor: 'text-red-400',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    ),
  },
]

const Admin: React.FC = () => {
  const { isDark } = useTheme()

  const [password, setPassword] = useState('')
  const [, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || '')
  const [authenticated, setAuthenticated] = useState(() => !!localStorage.getItem(ADMIN_TOKEN_KEY))
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)

  const bg = isDark ? 'bg-black' : 'bg-gray-50'
  const card = isDark ? 'bg-gray-950 border-white/10' : 'bg-white border-gray-200'
  const text = isDark ? 'text-white' : 'text-gray-900'
  const muted = isDark ? 'text-white/50' : 'text-gray-500'
  const hover = isDark ? 'hover:bg-white/5 hover:border-white/20' : 'hover:bg-gray-50 hover:border-gray-300'
  const input = isDark
    ? 'bg-black border-white/20 text-white placeholder-white/30'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'

  const adminFetch = useCallback(async (path: string) => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY) || ''
    return apiFetch(path, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
  }, [])

  const login = async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const data = await apiFetch('/api/bug-reports/login', {
        method: 'POST',
        body: JSON.stringify({ password })
      })
      localStorage.setItem(ADMIN_TOKEN_KEY, data.token)
      setToken(data.token)
      setAuthenticated(true)
    } catch {
      setAuthError('Invalid password')
    } finally {
      setAuthLoading(false)
    }
  }

  const logout = () => {
    localStorage.removeItem(ADMIN_TOKEN_KEY)
    setToken('')
    setAuthenticated(false)
  }

  // Fetch stats on auth
  useEffect(() => {
    if (!authenticated) return
    const fetchStats = async () => {
      try {
        const [publicStats, txPending, txFailed, reports, bugs] = await Promise.all([
          apiFetch('/api/stats'),
          adminFetch('/api/admin/db/txQueue?limit=1&filter=' + encodeURIComponent(JSON.stringify({ status: 'pending' }))),
          adminFetch('/api/admin/db/txQueue?limit=1&filter=' + encodeURIComponent(JSON.stringify({ status: 'failed' }))),
          adminFetch('/api/admin/db/report?limit=1&filter=' + encodeURIComponent(JSON.stringify({ status: 'PENDING' }))),
          adminFetch('/api/admin/db/bugReport?limit=1&filter=' + encodeURIComponent(JSON.stringify({ status: 'PENDING' }))),
        ])
        setStats({
          ...publicStats,
          pendingTx: txPending.total || 0,
          failedTx: txFailed.total || 0,
          pendingReports: reports.total || 0,
          pendingBugs: bugs.total || 0,
        })
      } catch (err) {
        console.warn('[Admin] Failed to fetch stats:', err)
      }
    }
    fetchStats()
  }, [authenticated, adminFetch])

  if (!authenticated) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${bg}`}>
        <div className={`p-8 rounded-2xl border max-w-sm w-full ${card}`}>
          <h1 className={`text-xl font-bold mb-4 ${text}`}>Admin</h1>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && login()}
            placeholder="Admin password"
            className={`w-full px-3 py-2 rounded-lg border text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${input}`}
          />
          {authError && <p className="text-red-500 text-xs mb-2">{authError}</p>}
          <button
            onClick={login}
            disabled={authLoading}
            className="w-full py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {authLoading ? 'Logging in...' : 'Login'}
          </button>
        </div>
      </div>
    )
  }

  const statCards = stats ? [
    { label: 'Users', value: stats.totalUsers.toLocaleString() },
    { label: 'Posts', value: stats.totalPosts.toLocaleString() },
    { label: 'Posts Today', value: stats.postsToday.toLocaleString() },
    { label: 'Active This Week', value: stats.activeUsersThisWeek.toLocaleString() },
    { label: 'New This Week', value: stats.newMembersThisWeek.toLocaleString() },
    { label: 'Pending Tx', value: stats.pendingTx.toLocaleString(), alert: stats.pendingTx > 10 },
    { label: 'Failed Tx', value: stats.failedTx.toLocaleString(), alert: stats.failedTx > 0 },
    { label: 'Pending Reports', value: stats.pendingReports.toLocaleString(), alert: stats.pendingReports > 0 },
    { label: 'Pending Bugs', value: stats.pendingBugs.toLocaleString(), alert: stats.pendingBugs > 0 },
  ] : null

  return (
    <div className={`min-h-screen ${bg} p-6`}>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className={`text-2xl font-bold ${text}`}>Admin</h1>
          <button onClick={logout} className={`text-sm ${muted} hover:underline`}>Logout</button>
        </div>

        {/* Quick Stats */}
        {statCards && (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-6">
            {statCards.map(s => (
              <div
                key={s.label}
                className={`px-3 py-2.5 rounded-xl border ${card} ${s.alert ? 'border-red-500/40' : ''}`}
              >
                <div className={`text-lg font-bold ${s.alert ? 'text-red-400' : text}`}>
                  {s.value}
                </div>
                <div className={`text-xs ${muted}`}>{s.label}</div>
              </div>
            ))}
          </div>
        )}
        {!statCards && (
          <div className={`text-sm ${muted} mb-6`}>Loading stats...</div>
        )}

        {/* Page Cards */}
        <div className="grid gap-3">
          {adminPages.map(page => (
            <Link
              key={page.path}
              to={page.path}
              className={`block p-5 rounded-xl border transition-all ${card} ${hover}`}
            >
              <div className="flex items-center gap-4">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center bg-gradient-to-br ${page.color} ${page.iconColor}`}>
                  {page.icon}
                </div>
                <div>
                  <div className={`font-semibold ${text}`}>{page.title}</div>
                  <div className={`text-sm ${muted}`}>{page.description}</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

export default Admin
