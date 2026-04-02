import React, { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { Link } from 'react-router-dom'
import { apiFetch } from '~/api/client'

const ADMIN_TOKEN_KEY = 'caw_admin_token'

const adminPages = [
  {
    path: '/admin/database',
    title: 'Database',
    description: 'Browse and edit all database tables',
    icon: '[ ]',
  },
  {
    path: '/admin/validator',
    title: 'Validator Analytics',
    description: 'Transaction costs, gas tracking, and profit/loss',
    icon: '/ \\',
  },
  {
    path: '/admin/validator/settings',
    title: 'Validator Settings',
    description: 'Configure tips, batch sizes, and intervals',
    icon: '{ }',
  },
  {
    path: '/admin/bugs',
    title: 'Bug Reports',
    description: 'Review and manage user-submitted bug reports',
    icon: '(!) ',
  },
  {
    path: '/admin/reports',
    title: 'Content Reports',
    description: 'Review flagged posts and user reports',
    icon: '/!\\',
  },
]

const Admin: React.FC = () => {
  const { isDark } = useTheme()

  const [password, setPassword] = useState('')
  const [, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || '')
  const [authenticated, setAuthenticated] = useState(() => !!localStorage.getItem(ADMIN_TOKEN_KEY))
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  const bg = isDark ? 'bg-black' : 'bg-gray-50'
  const card = isDark ? 'bg-gray-950 border-white/10' : 'bg-white border-gray-200'
  const text = isDark ? 'text-white' : 'text-gray-900'
  const muted = isDark ? 'text-white/50' : 'text-gray-500'
  const hover = isDark ? 'hover:bg-white/5 hover:border-white/20' : 'hover:bg-gray-50 hover:border-gray-300'
  const input = isDark
    ? 'bg-black border-white/20 text-white placeholder-white/30'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'

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

  return (
    <div className={`min-h-screen ${bg} p-6`}>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className={`text-2xl font-bold ${text}`}>Admin</h1>
          <button onClick={logout} className={`text-sm ${muted} hover:underline`}>Logout</button>
        </div>

        <div className="grid gap-3">
          {adminPages.map(page => (
            <Link
              key={page.path}
              to={page.path}
              className={`block p-5 rounded-xl border transition-all ${card} ${hover}`}
            >
              <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-mono text-xs font-bold ${
                  isDark ? 'bg-white/10 text-white/60' : 'bg-gray-100 text-gray-500'
                }`}>
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
