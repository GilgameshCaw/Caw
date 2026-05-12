import React, { useEffect, useState, useCallback } from 'react'
import { Link } from '~/utils/localizedRouter'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'

type Role = 'USER' | 'MODERATOR' | 'ADMIN'

interface ElevatedUser {
  tokenId: number
  username: string
  role: Exclude<Role, 'USER'>
  address: string
}

/**
 * Admin-only page for granting / revoking moderator and admin roles.
 * Posts to POST /api/admin/users/:tokenId/role. Designed to be the
 * one place a (root) admin needs to come to add a person to the team
 * and the one place to demote them when needed.
 */
export default function ModeratorsAdmin() {
  const { isDark } = useTheme()
  const [users, setUsers] = useState<ElevatedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Promotion form state.
  const [target, setTarget] = useState('')
  const [targetRole, setTargetRole] = useState<Exclude<Role, 'USER'>>('MODERATOR')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<{ users: ElevatedUser[] }>('/api/admin/users/elevated', {
        credentials: 'include',
      })
      setUsers(data.users)
    } catch (err: any) {
      setError(err?.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  // Resolve a `target` (digits = tokenId, otherwise treat as username
  // and look it up). Single round-trip path on the username branch.
  const resolveTokenId = async (raw: string): Promise<number | null> => {
    const trimmed = raw.trim().replace(/^@/, '')
    if (!trimmed) return null
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10)
    try {
      const u = await apiFetch<{ tokenId: number }>(`/api/users/${encodeURIComponent(trimmed)}`)
      return u?.tokenId ?? null
    } catch {
      return null
    }
  }

  const submit = async (role: Role) => {
    setSubmitError(null)
    setSubmitting(true)
    try {
      const tokenId = await resolveTokenId(target)
      if (!tokenId) {
        setSubmitError('Could not resolve user. Enter a tokenId or @username.')
        return
      }
      await apiFetch(`/api/admin/users/${tokenId}/role`, {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ role, reason: reason || null }),
      })
      setTarget('')
      setReason('')
      await fetchUsers()
    } catch (err: any) {
      setSubmitError(err?.message || 'Failed to set role')
    } finally {
      setSubmitting(false)
    }
  }

  const demote = async (u: ElevatedUser) => {
    if (!window.confirm(`Demote @${u.username} to USER?`)) return
    try {
      await apiFetch(`/api/admin/users/${u.tokenId}/role`, {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ role: 'USER' }),
      })
      await fetchUsers()
    } catch (err: any) {
      window.alert(err?.message || 'Failed to demote')
    }
  }

  const bg = isDark ? 'bg-black' : 'bg-gray-50'
  const card = isDark ? 'bg-gray-950 border-white/10' : 'bg-white border-gray-200'
  const text = isDark ? 'text-white' : 'text-gray-900'
  const muted = isDark ? 'text-white/60' : 'text-gray-600'
  const input = isDark
    ? 'bg-black border-white/20 text-white placeholder-white/30'
    : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'

  return (
    <div className={`min-h-screen ${bg}`}>
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className={`text-2xl font-bold ${text}`}>Moderators</h1>
          <Link to="/admin" className={`text-sm ${muted} hover:underline`}>← Admin</Link>
        </div>

        <section className={`p-5 rounded-xl border ${card}`}>
          <h2 className={`text-sm font-semibold mb-3 ${text}`}>Assign role</h2>
          <p className={`text-xs mb-3 ${muted}`}>
            Enter a tokenId (e.g. <code>108</code>) or a @username. Promotions and
            demotions are audit-logged.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={target}
              onChange={e => setTarget(e.target.value)}
              placeholder="tokenId or @username"
              className={`flex-1 px-3 py-2 rounded-lg border text-sm ${input}`}
            />
            <select
              value={targetRole}
              onChange={e => setTargetRole(e.target.value as any)}
              className={`px-3 py-2 rounded-lg border text-sm ${input}`}
            >
              <option value="MODERATOR">MODERATOR</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </div>
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Reason (optional, audit-logged)"
            className={`w-full mt-2 px-3 py-2 rounded-lg border text-sm ${input}`}
          />
          {submitError && <p className="text-red-500 text-xs mt-2">{submitError}</p>}
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => submit(targetRole)}
              disabled={submitting || !target.trim()}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : `Set ${targetRole}`}
            </button>
          </div>
        </section>

        <section className={`p-5 rounded-xl border ${card}`}>
          <h2 className={`text-sm font-semibold mb-3 ${text}`}>Current moderators &amp; admins</h2>
          {loading && <p className={`text-sm ${muted}`}>Loading…</p>}
          {error && <p className="text-red-500 text-sm">{error}</p>}
          {!loading && users.length === 0 && (
            <p className={`text-sm ${muted}`}>
              No elevated users yet. Promote one above, or set
              <code> BOOTSTRAP_ADMIN_TOKEN_IDS</code> in .env to bootstrap your first admin.
            </p>
          )}
          {users.length > 0 && (
            <ul className="divide-y divide-gray-200/20">
              {users.map(u => (
                <li key={u.tokenId} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={`text-sm font-medium ${text}`}>
                      @{u.username}{' '}
                      <span className={`text-xs ${u.role === 'ADMIN' ? 'text-amber-500' : 'text-blue-500'}`}>
                        {u.role}
                      </span>
                    </div>
                    <div className={`text-xs font-mono ${muted}`}>
                      tokenId={u.tokenId} · {u.address}
                    </div>
                  </div>
                  <button
                    onClick={() => demote(u)}
                    className="px-3 py-1.5 rounded-lg bg-red-600/80 text-white text-xs font-medium hover:bg-red-600"
                  >
                    Demote
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
