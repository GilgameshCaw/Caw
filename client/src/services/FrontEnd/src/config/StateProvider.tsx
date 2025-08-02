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
    console.log("Changed addresss. From:", address, "To:", prevAddress)
    if (address && prevAddress.current && prevAddress.current !== address)
      useTokenDataStore.getState().removeActiveToken()
    prevAddress.current = address
  }, [address])


  return children;
}
