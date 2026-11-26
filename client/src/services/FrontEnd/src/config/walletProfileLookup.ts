import { createContext, useContext } from 'react'

export type WalletProfileLookupStatus = 'checking' | 'unavailable' | 'empty' | 'found'

export const WalletProfileLookupContext = createContext<{
  status: WalletProfileLookupStatus
  retry: () => void
}>({ status: 'checking', retry: () => {} })

export const useWalletProfileLookup = () => useContext(WalletProfileLookupContext)
