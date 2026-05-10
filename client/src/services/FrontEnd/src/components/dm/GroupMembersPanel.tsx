import { useEffect, useState } from 'react'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'
import type { UiParticipant } from '~/hooks/useDm'
import { UserAvatar } from '~/components/Avatar'

type Invite = {
  id: string
  token: string
  expiresAt: string
  maxUses: number
  useCount: number
  revokedAt?: string | null
}

interface Props {
  isOpen: boolean
  onClose: () => void
  conversationId: string
  conversationName?: string | null
  members: UiParticipant[]
  currentUserId: number
  myRole?: 'OWNER' | 'MEMBER'
  onAddMembers: (conversationId: string, ids: number[]) => Promise<any>
  onRemoveMember: (conversationId: string, id: number) => Promise<any>
  onLeaveGroup: (conversationId: string) => Promise<any>
  onRenameGroup: (conversationId: string, name: string) => Promise<any>
  onMintInvite: (conversationId: string, params: { expiresAt: string; maxUses: number }) => Promise<Invite>
  onRevokeInvite: (conversationId: string, inviteId: string) => Promise<any>
  onListInvites: (conversationId: string) => Promise<{ invites: Invite[] }>
}

export default function GroupMembersPanel(props: Props) {
  const {
    isOpen, onClose, conversationId, conversationName, members, currentUserId, myRole,
    onAddMembers, onRemoveMember, onLeaveGroup, onRenameGroup, onMintInvite, onRevokeInvite, onListInvites,
  } = props
  const { isDark } = useTheme()
  const isOwner = myRole === 'OWNER'

  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(conversationName || '')
  const [adding, setAdding] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [addResults, setAddResults] = useState<Array<{ tokenId: number; username: string; displayName?: string; avatarUrl?: string; defaultAvatarId?: number | null; hasDmIdentity?: boolean }>>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [inviteExpiryHours, setInviteExpiryHours] = useState(24)
  const [inviteMaxUses, setInviteMaxUses] = useState(5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setNameDraft(conversationName || '') }, [conversationName])

  useEffect(() => {
    if (!isOpen || !isOwner) return
    onListInvites(conversationId).then(r => setInvites(r.invites || [])).catch(() => {})
  }, [isOpen, conversationId, isOwner, onListInvites])

  useEffect(() => {
    if (!addQuery.trim()) { setAddResults([]); return }
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch<{ users: any[] }>(`/api/search?type=users&q=${encodeURIComponent(addQuery)}&limit=10`)
        const filtered = (r.users || []).filter((u: any) => u.tokenId !== currentUserId && !members.some(m => m.userId === u.tokenId))
        if (filtered.length === 0) { setAddResults([]); return }
        const ids = filtered.map((u: any) => u.tokenId).join(',')
        const batch = await apiFetch<{ identities: Record<number, { hasIdentity: boolean }> }>(`/api/dm/identity/batch?userIds=${ids}`)
        setAddResults(filtered.map((u: any) => ({ ...u, hasDmIdentity: !!batch.identities[u.tokenId]?.hasIdentity })))
      } catch {}
    }, 250)
    return () => clearTimeout(t)
  }, [addQuery, currentUserId, members])

  if (!isOpen) return null

  const handleRename = async () => {
    if (!nameDraft.trim()) return
    setBusy(true); setError(null)
    try {
      await onRenameGroup(conversationId, nameDraft.trim())
      setRenaming(false)
    } catch (e: any) {
      setError(e?.message || 'Rename failed')
    } finally { setBusy(false) }
  }

  const handleAdd = async (id: number) => {
    setBusy(true); setError(null)
    try {
      await onAddMembers(conversationId, [id])
      setAddQuery(''); setAddResults([])
    } catch (e: any) {
      setError(e?.message || 'Add failed')
    } finally { setBusy(false) }
  }

  const handleRemove = async (id: number) => {
    setBusy(true); setError(null)
    try { await onRemoveMember(conversationId, id) }
    catch (e: any) { setError(e?.message || 'Remove failed') }
    finally { setBusy(false) }
  }

  const handleLeave = async () => {
    if (!confirm('Leave this group?')) return
    setBusy(true); setError(null)
    try {
      await onLeaveGroup(conversationId)
      onClose()
    } catch (e: any) { setError(e?.message || 'Leave failed') }
    finally { setBusy(false) }
  }

  const handleMint = async () => {
    setBusy(true); setError(null)
    try {
      const expiresAt = new Date(Date.now() + inviteExpiryHours * 3600 * 1000).toISOString()
      const inv = await onMintInvite(conversationId, { expiresAt, maxUses: inviteMaxUses })
      setInvites(prev => [inv, ...prev])
    } catch (e: any) { setError(e?.message || 'Mint failed') }
    finally { setBusy(false) }
  }

  const handleRevoke = async (inviteId: string) => {
    setBusy(true); setError(null)
    try {
      await onRevokeInvite(conversationId, inviteId)
      setInvites(prev => prev.filter(i => i.id !== inviteId))
    } catch (e: any) { setError(e?.message || 'Revoke failed') }
    finally { setBusy(false) }
  }

  const inviteUrl = (token: string) => `${window.location.origin}/dm/invite/${token}`

  const muted = isDark ? 'text-zinc-400' : 'text-zinc-600'
  const inputBase = isDark ? 'bg-zinc-900 text-white border-zinc-700' : 'bg-white text-zinc-900 border-zinc-300'
  const surface = isDark ? 'bg-zinc-900 text-zinc-100' : 'bg-white text-zinc-900'

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <aside className={`w-full max-w-md h-full overflow-y-auto p-5 ${surface} shadow-xl`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Group members</h2>
          <button onClick={onClose} className="text-sm">✕</button>
        </div>

        {/* Name */}
        <div className="mb-5">
          {renaming ? (
            <div className="flex gap-2">
              <input
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value.slice(0, 50))}
                className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${inputBase}`}
              />
              <button onClick={handleRename} disabled={busy} className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white">Save</button>
              <button onClick={() => { setRenaming(false); setNameDraft(conversationName || '') }} className="px-3 py-1.5 text-sm rounded-md">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide ${muted}">Name</div>
                <div>{conversationName || <span className={muted}>Unnamed</span>}</div>
              </div>
              {isOwner && (
                <button onClick={() => setRenaming(true)} className={`text-xs ${muted}`}>Rename</button>
              )}
            </div>
          )}
        </div>

        {/* Members */}
        <ul className="space-y-2 mb-6">
          {members.map(m => (
            <li key={m.userId} className="flex items-center gap-2">
              <UserAvatar user={m.identity.user} className="w-8 h-8 rounded-full" size="small" />
              <div className="flex-1">
                <div className="text-sm">{m.identity.user.displayName || m.identity.user.username}</div>
                <div className={`text-xs ${muted}`}>@{m.identity.user.username}{m.role === 'OWNER' ? ' • owner' : ''}</div>
              </div>
              {isOwner && m.userId !== currentUserId && (
                <button onClick={() => handleRemove(m.userId)} disabled={busy} className="text-xs text-red-500">Remove</button>
              )}
            </li>
          ))}
        </ul>

        {isOwner && (
          <div className="mb-6">
            <button onClick={() => setAdding(v => !v)} className={`text-sm ${muted} mb-1`}>
              {adding ? 'Cancel adding' : '+ Add member'}
            </button>
            {adding && (
              <div>
                <input
                  value={addQuery}
                  onChange={e => setAddQuery(e.target.value)}
                  placeholder="Search users"
                  className={`w-full rounded-md border px-3 py-1.5 text-sm ${inputBase}`}
                />
                {addResults.length > 0 && (
                  <div className={`mt-1 rounded-md border ${isDark ? 'border-zinc-700' : 'border-zinc-300'} max-h-48 overflow-y-auto`}>
                    {addResults.map(u => (
                      <button
                        key={u.tokenId}
                        onClick={() => u.hasDmIdentity && handleAdd(u.tokenId)}
                        disabled={!u.hasDmIdentity || busy}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${u.hasDmIdentity ? (isDark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100') : 'opacity-50 cursor-not-allowed'}`}
                      >
                        <UserAvatar user={u} className="w-7 h-7 rounded-full" size="small" />
                        <span>@{u.username}{!u.hasDmIdentity ? ' (no DMs)' : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Invites */}
        {isOwner && (
          <div className="mb-6">
            <h3 className="text-sm font-semibold mb-2">Invite links</h3>
            <div className="flex gap-2 mb-2">
              <label className={`text-xs ${muted} flex items-center gap-1`}>
                Hours
                <input
                  type="number"
                  value={inviteExpiryHours}
                  onChange={e => setInviteExpiryHours(Math.max(1, Number(e.target.value) || 1))}
                  className={`w-16 rounded-md border px-2 py-1 text-xs ${inputBase}`}
                />
              </label>
              <label className={`text-xs ${muted} flex items-center gap-1`}>
                Max uses
                <input
                  type="number"
                  value={inviteMaxUses}
                  onChange={e => setInviteMaxUses(Math.max(1, Number(e.target.value) || 1))}
                  className={`w-16 rounded-md border px-2 py-1 text-xs ${inputBase}`}
                />
              </label>
              <button onClick={handleMint} disabled={busy} className="text-xs px-2 py-1 rounded-md bg-emerald-600 text-white">Mint</button>
            </div>
            <ul className="space-y-2">
              {invites.map(inv => (
                <li key={inv.id} className="text-xs flex items-center gap-2">
                  <input
                    readOnly
                    value={inviteUrl(inv.token)}
                    onClick={e => (e.target as HTMLInputElement).select()}
                    className={`flex-1 rounded-md border px-2 py-1 ${inputBase}`}
                  />
                  <button
                    onClick={() => navigator.clipboard.writeText(inviteUrl(inv.token))}
                    className={muted}
                  >Copy</button>
                  <button onClick={() => handleRevoke(inv.id)} className="text-red-500">Revoke</button>
                </li>
              ))}
              {invites.length === 0 && <li className={`text-xs ${muted}`}>No active invites.</li>}
            </ul>
          </div>
        )}

        {error && <div className="text-sm text-red-500 mb-3">{error}</div>}

        <button onClick={handleLeave} disabled={busy} className="w-full px-3 py-2 rounded-md text-sm bg-red-600 text-white">
          Leave group
        </button>
      </aside>
    </div>
  )
}
