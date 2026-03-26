import { create } from 'zustand'

interface ActionErrorState {
  isOpen: boolean
  title: string
  message: string
  show: (title: string, message: string) => void
  close: () => void
}

export const useActionErrorStore = create<ActionErrorState>()((set) => ({
  isOpen: false,
  title: '',
  message: '',
  show: (title: string, message: string) => set({ isOpen: true, title, message }),
  close: () => set({ isOpen: false, title: '', message: '' })
}))
