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
    if (!activeTokenId) {
      setLoad(false)
      return
    }
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
  if (!activeTokenId) 
    return <MainLayout>
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold mb-4">No Active Token</h2>
        <p className="text-gray-400">Please connect your wallet and select a CawName to view pending transactions.</p>
      </div>
    </MainLayout>
  if (actions.length === 0)
    return <MainLayout>
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold mb-4">No Pending Transactions</h2>
        <p className="text-gray-400">You don't have any pending transactions at the moment.</p>
      </div>
    </MainLayout>

  // build a lookup for users
  const userById = new Map(users.map(u => [u.id, u]))

  return (
    <MainLayout>
      <ul className="space-y-4 p-3">
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
                // Amounts in action struct are whole CAW units (not wei) due to uint64 limitation
                const amount = Number(a.amounts![0]).toLocaleString()
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

