import { useState } from 'react'

type Status = 'idle' | 'checking' | 'failed'
type Allocate = (tokenId: number, count: number) => Promise<number[]>

export function usePostNumberPreparation(allocate: Allocate) {
  const [status, setStatus] = useState<Status>('idle')

  return {
    status,
    clear: () => setStatus('idle'),
    async prepare(tokenId: number, count: number) {
      setStatus('checking')
      try {
        const numbers = await allocate(tokenId, count)
        setStatus('idle')
        return numbers
      } catch {
        setStatus('failed')
        return null
      }
    },
  }
}
