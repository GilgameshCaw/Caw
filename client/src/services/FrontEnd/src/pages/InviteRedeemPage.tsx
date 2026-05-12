import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useNavigate } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useDmClient } from '~/hooks/useDm'
import { useActiveToken } from '~/store/tokenDataStore'

export default function InviteRedeemPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const tokenId = activeToken?.id

  const dm = useDmClient(tokenId, activeToken?.username)
  const { previewInvite, redeemInvite } = dm

  const [preview, setPreview] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!token) return
    previewInvite(token).then(setPreview).catch((e: any) => setError(e?.message || 'Invite not found'))
  }, [token, previewInvite])

  const handleJoin = async () => {
    if (!token) return
    setSubmitting(true); setError(null)
    try {
      const out = await redeemInvite(token)
      if (out?.conversation?.id) {
        navigate(`/messages?c=${out.conversation.id}`)
      } else {
        navigate('/messages')
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to join')
    } finally { setSubmitting(false) }
  }

  const muted = isDark ? 'text-zinc-400' : 'text-zinc-600'
  const surface = isDark ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-900'

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <div className={`rounded-lg p-6 ${surface} shadow`}>
        <h1 className="text-xl font-semibold mb-3">Group invite</h1>
        {error && <div className="text-sm text-red-500 mb-3">{error}</div>}
        {preview && (
          <>
            <div className="mb-3">
              <div className="text-2xl font-semibold">{preview.conversation?.name || 'Unnamed group'}</div>
              <div className={`text-sm ${muted}`}>{preview.memberCount} member{preview.memberCount === 1 ? '' : 's'}</div>
              <div className={`text-xs ${muted} mt-1`}>
                Expires {new Date(preview.expiresAt).toLocaleString()} · {preview.useCount}/{preview.maxUses} used
              </div>
            </div>
            <button
              onClick={handleJoin}
              disabled={submitting || !tokenId}
              className="px-4 py-2 rounded-md text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            >{submitting ? 'Joining…' : 'Join group'}</button>
          </>
        )}
        {!preview && !error && <div className={muted}>Loading…</div>}
      </div>
    </div>
  )
}
