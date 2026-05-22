import { useEffect, useState } from 'react'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'

/**
 * Wraps admin-only routes. Asks /api/me/role with the current wallet
 * session and only renders children when role is ADMIN.
 * Falls back to a "you don't have access" message — admins are
 * assigned server-side, not self-served via a password form.
 */
export default function AdminGate({ children }: { children: React.ReactNode }) {
  const { isDark } = useTheme()
  const [status, setStatus] = useState<'checking' | 'ok' | 'denied'>('checking')

  useEffect(() => {
    let cancelled = false
    apiFetch<{ role: 'USER' | 'MODERATOR' | 'ADMIN' }>('/api/me/role')
      .then(r => {
        if (cancelled) return
        setStatus(r.role === 'ADMIN' ? 'ok' : 'denied')
      })
      .catch(() => {
        if (!cancelled) setStatus('denied')
      })
    return () => { cancelled = true }
  }, [])

  if (status === 'checking') return null

  if (status === 'denied') {
    const bg = isDark ? 'bg-black' : 'bg-gray-50'
    const card = isDark ? 'bg-gray-950 border-white/10' : 'bg-white border-gray-200'
    const text = isDark ? 'text-white' : 'text-gray-900'
    const muted = isDark ? 'text-white/60' : 'text-gray-500'
    return (
      <div className={`min-h-screen flex items-center justify-center ${bg}`}>
        <div className={`p-8 rounded-2xl border max-w-sm w-full text-center ${card}`}>
          <h1 className={`text-xl font-bold mb-2 ${text}`}>Admin access required</h1>
          <p className={`text-sm ${muted}`}>
            Admin access required. Your wallet is not in the admin list.
          </p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
