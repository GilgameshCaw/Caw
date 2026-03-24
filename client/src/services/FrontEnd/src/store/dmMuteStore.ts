import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface DmMuteState {
  /** Set of muted conversation IDs */
  mutedConversations: string[]

  muteConversation: (conversationId: string) => void
  unmuteConversation: (conversationId: string) => void
  isMuted: (conversationId: string) => boolean
}

export const useDmMuteStore = create<DmMuteState>()(
  persist(
    (set, get) => ({
      mutedConversations: [],

      muteConversation: (conversationId) => set(state => ({
        mutedConversations: state.mutedConversations.includes(conversationId)
          ? state.mutedConversations
          : [...state.mutedConversations, conversationId]
      })),

      unmuteConversation: (conversationId) => set(state => ({
        mutedConversations: state.mutedConversations.filter(id => id !== conversationId)
      })),

      isMuted: (conversationId) => get().mutedConversations.includes(conversationId),
    }),
    { name: 'caw-dm-muted' }
  )
)
