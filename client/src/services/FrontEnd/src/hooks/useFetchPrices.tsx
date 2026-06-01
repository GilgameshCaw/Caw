import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { usePriceStore, usePriceSourceStore } from "~/store/tokenDataStore"
import { apiFetch } from "~/api/client"

interface PriceResponse {
  usdPerCaw: number | null
  cawPerUsd: number | null
  usdPerEth: number | null
  usdPerCawSepolia: number | null
  cawPerUsdSepolia: number | null
  updatedAt: number | null
}

export function useFetchPrices() {
  const setPriceMap = usePriceStore(s => s.setPriceMap)
  const priceSource = usePriceSourceStore(s => s.source)

  const query = useQuery({
    queryKey: ["tokenPrices"],
    queryFn: async () => {
      console.log('[useFetchPrices] Fetching prices from /api/prices...')
      try {
        const data = await apiFetch<PriceResponse>('/api/prices')
        console.log('[useFetchPrices] Response:', data)
        return data
      } catch (err) {
        console.error('[useFetchPrices] Failed:', err)
        throw err
      }
    },
    refetchInterval: 300_000,
    retry: 3,
    retryDelay: 5000,
  })

  // Re-derive the priceMap whenever the data OR the user's preferred source
  // changes. Mirroring the active source into priceMap['a-hunters-dream']
  // (the legacy key consumed by ~10 components) lets the toggle flip every
  // display site at once without per-callsite changes.
  useEffect(() => {
    const data = query.data
    if (!data) return
    const prices: Record<string, number> = {}
    if (data.usdPerEth) prices['ethereum'] = data.usdPerEth
    if (data.usdPerCaw) prices['a-hunters-dream-mainnet'] = data.usdPerCaw
    if (data.usdPerCawSepolia) prices['a-hunters-dream-sepolia'] = data.usdPerCawSepolia
    // Effective key — what existing consumers read.
    const effective = priceSource === 'sepolia'
      ? (data.usdPerCawSepolia ?? data.usdPerCaw)
      : (data.usdPerCaw ?? data.usdPerCawSepolia)
    if (effective != null) prices['a-hunters-dream'] = effective
    setPriceMap(prices)
  }, [query.data, priceSource, setPriceMap])

  return query
}
