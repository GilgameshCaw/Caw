import { useEffect, useState } from 'react'
import ModalWrapper from '~/components/modals/ModalWrapper'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'
import { UserAvatar } from '~/components/Avatar'

type SearchUser = {
  tokenId: number
  username: string
  displayName?: string
  avatarUrl?: string
  defaultAvatarId?: number | null
  hasDmIdentity?: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  currentUserId: number
  onCreate: (params: { memberUserIds: number[]; name?: string }) => Promise<any>
}

const MIN_OTHERS = 2  // 3 members total, including self
const MAX_OTHERS = 9  // 10 cap

export default function CreateGroupModal({ isOpen, onClose, currentUserId, onCreate }: Props) {
  const { isDark } = useTheme()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchUser[]>([])
  const [picked, setPicked] = useState<SearchUser[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) {
      setName('')
      setQuery('')
      setResults([])
      setPicked([])
      setError(null)
      setSubmitting(false)
    }
  }, [isOpen])

  // Debounced search.
  useEffect(() => {
    if (!isOpen) return
    if (!query.trim()) { setResults([]); return }
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch<{ users: SearchUser[] }>(`/api/search?type=users&q=${encodeURIComponent(query)}&limit=20`)
        const filtered = (r.users || []).filter((u: SearchUser) => u.tokenId !== currentUserId && !picked.some(p => p.tokenId === u.tokenId))
        if (filtered.length === 0) { setResults([]); return }
        const ids = filtered.map((u: SearchUser) => u.tokenId).join(',')
        const batch = await apiFetch<{ identities: Record<number, { hasIdentity: boolean }> }>(`/api/dm/identity/batch?userIds=${ids}`)
        setResults(filtered.map((u: SearchUser) => ({ ...u, hasDmIdentity: !!batch.identities[u.tokenId]?.hasIdentity })))
      } catch {
        setResults([])
      }
    }, 250)
    return () => clearTimeout(t)
  }, [query, isOpen, currentUserId, picked])

  const togglePicked = (u: SearchUser) => {
    setPicked(prev => prev.some(p => p.tokenId === u.tokenId)
      ? prev.filter(p => p.tokenId !== u.tokenId)
      : prev.length >= MAX_OTHERS ? prev : [...prev, u])
    setQuery('')
    setResults([])
  }

  const canSubmit = picked.length >= MIN_OTHERS && picked.length <= MAX_OTHERS && !submitting

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onCreate({
        memberUserIds: picked.map(p => p.tokenId),
        name: name.trim() || undefined,
      })
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Failed to create group')
    } finally {
      setSubmitting(false)
    }
  }

  const inputBase = isDark ? 'bg-zinc-900 text-white border-zinc-700' : 'bg-white text-zinc-900 border-zinc-300'
  const muted = isDark ? 'text-zinc-400' : 'text-zinc-600'
  const chip = isDark ? 'bg-zinc-700 text-white' : 'bg-zinc-200 text-zinc-900'

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-lg" usePortal>
      <div className="p-5 space-y-4">
        <h2 className="text-lg font-semibold">New group chat</h2>

        <div>
          <label className={`block text-sm mb-1 ${muted}`}>Group name (optional)</label>
          <input
            value={name}
            onChange={e => setName(e.target.value.slice(0, 50))}
            placeholder="Squad chat"
            className={`w-full rounded-md border px-3 py-2 text-sm ${inputBase}`}
          />
        </div>

        <div>
          <label className={`block text-sm mb-1 ${muted}`}>Members ({picked.length}/{MAX_OTHERS})</label>
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {picked.map(p => (
                <button
                  key={p.tokenId}
                  onClick={() => togglePicked(p)}
                  className={`text-xs px-2 py-1 rounded-full ${chip}`}
                  type="button"
                >
                  @{p.username} ✕
                </button>
              ))}
            </div>
          )}
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search users to add"
            className={`w-full rounded-md border px-3 py-2 text-sm ${inputBase}`}
          />
          {results.length > 0 && (
            <div className={`mt-1 rounded-md border ${isDark ? 'border-zinc-700' : 'border-zinc-300'} max-h-56 overflow-y-auto`}>
              {results.map(u => (
                <button
                  key={u.tokenId}
                  type="button"
                  onClick={() => u.hasDmIdentity && togglePicked(u)}
                  disabled={!u.hasDmIdentity}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100'} ${u.hasDmIdentity ? '' : 'opacity-50 cursor-not-allowed'}`}
                >
                  <UserAvatar user={u} className="w-7 h-7 rounded-full" size="small" />
                  <div className="flex-1">
                    <div>{u.displayName || u.username}</div>
                    <div className={`text-xs ${muted}`}>@{u.username}{!u.hasDmIdentity ? ' — DMs not enabled' : ''}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <div className="text-sm text-red-500">{error}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`px-3 py-1.5 rounded-md text-sm ${isDark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100'}`}
          >Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className={`px-3 py-1.5 rounded-md text-sm font-medium ${canSubmit ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-zinc-500 text-white opacity-50 cursor-not-allowed'}`}
          >{submitting ? 'Creating…' : 'Create group'}</button>
        </div>
      </div>
    </ModalWrapper>
  )
}
