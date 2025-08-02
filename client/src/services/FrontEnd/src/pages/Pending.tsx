import MainLayout from '~/layouts/MainLayout'
import { useState, useEffect } from 'react'
import { formatUnitsCompact } from '~/utils'
import { useTokenDataStore }   from '~/store/tokenDataStore'
import { apiFetch }            from '../api/client'

type RawAction = {
  id:            number
  status:        string
  createdAt:     string
  actionType:    number
  senderId:      number
  receiverId?:   number
  receiverCawonce?: number
  recipients?:   number[]
  amounts?:      number[]
  text?:         string
}

type User = {
  id:       number
  username: string | null
  address:  string
}

type ApiResponse = {
  pendingActionIds: number[]
  actions: RawAction[]
  users:   User[]
}

export const PendingPage: React.FC = () => {
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const [actions, setActions] = useState<RawAction[]>([])
  const [users,   setUsers]   = useState<User[]>([])
  const [loading, setLoad]    = useState(true)

  useEffect(() => {
    if (!activeTokenId) return
    setLoad(true)

    apiFetch<ApiResponse>(`/api/txs?senderId=${activeTokenId}`)
      .then(({ actions, users }) => {
        setActions(actions)
        setUsers(users)
      })
      .catch(console.error)
      .finally(() => setLoad(false))
  }, [activeTokenId])

  if (loading) return <MainLayout>Loading…</MainLayout>
  if (actions.length === 0)
    return <MainLayout>No pending transactions</MainLayout>

  // build a lookup for users
  const userById = new Map(users.map(u => [u.id, u]))

  return (
    <MainLayout>
      <ul className="space-y-4">
        {actions.map(a => {
          const sender = userById.get(a.senderId)
          const who    = sender?.username || sender?.address

          let description = ''
          let relatedText = ''

          switch (a.actionType) {
            case 0: // CAW
              description = `@${who} posted a caw`
              relatedText = a.text || ''
              break
            case 1: // LIKE
              {
                const targetId = a.receiverId!
                const target   = userById.get(targetId)
                const whom     = target?.username || target?.address
                description = `@${who} liked a post by @${whom}`
              }
              break
            case 6: // WITHDRAW
              {
                const amount = formatUnitsCompact(BigInt(a.amounts![0]), 18)
                description = `@${who} sent request to withdraw ${amount} CAW`
              }
              break
            // …other cases…
            default:
              description = `@${who}: action ${a.actionType}`
          }

          return (
            <li key={a.id} className={`m-3 px-4 py-2 ${a.status != 'pending' ? 'opacity-40' : ''} border rounded`}>
              <div className="font-semibold">{description}</div>
              {relatedText && (
                <div className="mt-1 text-sm text-gray-300">“{relatedText}”</div>
              )}
              <div className="flex place-content-between">
                <div className="mt-1 text-xs text-gray-500">
                  {new Date(a.createdAt).toLocaleString()}
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {a.status}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </MainLayout>
  )
}

