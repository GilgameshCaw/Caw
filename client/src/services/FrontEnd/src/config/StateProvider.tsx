import useTokenDataUpdate from "~/hooks/useTokenDataUpdate";
import { useTokenDataStore } from "~/store/tokenDataStore"
import { useAIProviderStore } from "~/store/aiProviderStore"
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
    if (address && prevAddress.current && prevAddress.current !== address) {
      useTokenDataStore.getState().removeActiveToken()
      useAIProviderStore.getState().disconnect()
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
