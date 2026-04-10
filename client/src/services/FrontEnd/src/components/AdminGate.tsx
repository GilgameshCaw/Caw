import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'

/**
 * Wraps admin sub-routes. Verifies the HttpOnly admin session cookie with the
 * backend before rendering. Shows an inline login form if unauthenticated.
 *
 * The admin token lives ONLY in an HttpOnly, SameSite=Strict cookie set by
 * POST /api/bug-reports/login — JS cannot read it, so XSS cannot exfiltrate
 * it. This gate just asks the server "is my cookie still good?" via /me.
 */
export default function AdminGate({ children }: { children: React.ReactNode }) {
  const { isDark } = useTheme()
  const [status, setStatus] = useState<'checking' | 'ok' | 'denied'>('checking')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  const verify = useCallback(async () => {
    try {
      await apiFetch('/api/bug-reports/me', { credentials: 'include' })
      setStatus('ok')
    } catch {
      setStatus('denied')
    }
  }, [])

  useEffect(() => {
    verify()
  }, [verify])

  const login = async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      await apiFetch('/api/bug-reports/login', {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ password }),
      })
      setPassword('')
      setStatus('ok')
    } catch {
      setAuthError('Invalid password')
    } finally {
      setAuthLoading(false)
    }
  }

  if (status === 'checking') return null

  if (status === 'denied') {
    const bg = isDark ? 'bg-black' : 'bg-gray-50'
    const card = isDark ? 'bg-gray-950 border-white/10' : 'bg-white border-gray-200'
    const text = isDark ? 'text-white' : 'text-gray-900'
    const input = isDark
      ? 'bg-black border-white/20 text-white placeholder-white/30'
      : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'

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
            autoFocus
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

  return <>{children}</>
}
