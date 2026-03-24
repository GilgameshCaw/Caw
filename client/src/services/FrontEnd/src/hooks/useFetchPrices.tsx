import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { usePriceStore } from "~/store/tokenDataStore"
import { apiFetch } from "~/api/client"

interface PriceResponse {
  usdPerCaw: number | null
  cawPerUsd: number | null
  usdPerEth: number | null
  updatedAt: number | null
}

export function useFetchPrices() {
  const setPriceMap = usePriceStore(s => s.setPriceMap)

  const query = useQuery({
    queryKey: ["tokenPrices"],
    queryFn: async () => {
      console.log('[useFetchPrices] Fetching prices from /api/prices...')
      try {
        const data = await apiFetch<PriceResponse>('/api/prices')
        console.log('[useFetchPrices] Response:', data)
        const prices: Record<string, number> = {}
        if (data.usdPerEth) prices['ethereum'] = data.usdPerEth
        if (data.usdPerCaw) prices['a-hunters-dream'] = data.usdPerCaw
        return prices
      } catch (err) {
        console.error('[useFetchPrices] Failed:', err)
        throw err
      }
    },
    refetchInterval: 300_000,
    retry: 3,
    retryDelay: 5000,
  })

  useEffect(() => {
    console.log('[useFetchPrices] Query state:', { status: query.status, data: query.data, error: query.error?.message })
    if (query.data && Object.keys(query.data).length > 0) {
      setPriceMap(query.data)
    }
  }, [query.data, query.status, query.error, setPriceMap])

  return query
}
