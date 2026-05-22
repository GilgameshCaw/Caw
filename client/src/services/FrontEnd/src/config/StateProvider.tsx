import useTokenDataUpdate from "~/hooks/useTokenDataUpdate";
import { useTokenDataStore } from "~/store/tokenDataStore"
import { useFetchPrices } from "~/hooks/useFetchPrices";
import { useEffect, useRef } from 'react';
import { useAccount } from "wagmi";


interface StateProviderProps {
  children: React.ReactNode;
}

export default function StateProvider({ children }: StateProviderProps) {
  const { address } = useAccount();
  const prevAddress = useRef<string | undefined>(undefined)

  useFetchPrices(),
  useTokenDataUpdate();

  useEffect(() => {
    // Note: the AI provider key (Gemini BYOK) is intentionally NOT cleared
    // on wallet change. It's a human-scoped credential — one person may
    // have several wallets/profiles in CAW, and forcing them to re-enter
    // the Gemini key on every switch would be hostile. Clearing the key
    // is handled by the explicit Disconnect button in AIProviderSettings,
    // and by AccountSettings' "clear all data" path.
    if (address && prevAddress.current && prevAddress.current !== address) {
      useTokenDataStore.getState().removeActiveToken()
    }
    prevAddress.current = address
  }, [address])

  // Refetch token data (balances, staked amounts) when the tab becomes visible again
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const refetch = useTokenDataStore.getState().refetchTokenData
        if (refetch) refetch()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  return children;
}
