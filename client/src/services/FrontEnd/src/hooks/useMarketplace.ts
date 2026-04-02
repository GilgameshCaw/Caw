import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '~/api/client'
import { useMarketplaceStore, MarketplaceListing, MarketplaceSale } from '~/store/marketplaceStore'

export function useMarketplaceListings() {
  const filters = useMarketplaceStore(s => s.filters)
  const refreshCounter = useMarketplaceStore(s => s.refreshCounter)
  const [listings, setListings] = useState<MarketplaceListing[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)
  const limit = 24

  const fetchListings = useCallback(async (reset = false) => {
    setLoading(true)
    try {
      const off = reset ? 0 : offset
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(off),
        type: filters.listingType,
        paymentToken: filters.paymentToken,
        minLength: String(filters.minLength),
        maxLength: String(filters.maxLength),
        sort: filters.sort,
        status: 'ACTIVE',
      })
      const data = await apiFetch<{ listings: MarketplaceListing[]; total: number }>(
        `/api/marketplace/listings?${params}`
      )
      if (reset) {
        setListings(data.listings)
        setOffset(data.listings.length)
      } else {
        setListings(prev => [...prev, ...data.listings])
        setOffset(off + data.listings.length)
      }
      setTotal(data.total)
    } catch (err) {
      console.error('[useMarketplace] fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [filters, offset])

  // Re-fetch when filters change
  useEffect(() => {
    fetchListings(true)
  }, [filters.listingType, filters.paymentToken, filters.minLength, filters.maxLength, filters.sort, refreshCounter])

  const loadMore = useCallback(() => fetchListings(false), [fetchListings])
  const refresh = useCallback(() => fetchListings(true), [fetchListings])

  return { listings, total, loading, loadMore, refresh, hasMore: listings.length < total }
}

export function useMarketplaceSales() {
  const [sales, setSales] = useState<MarketplaceSale[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchSales = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<{ sales: MarketplaceSale[]; total: number }>(
        '/api/marketplace/sales?limit=50'
      )
      setSales(data.sales)
      setTotal(data.total)
    } catch (err) {
      console.error('[useMarketplace] sales error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSales() }, [fetchSales])

  return { sales, total, loading, refresh: fetchSales }
}

export function useListingDetail(listingId: number | null) {
  const [listing, setListing] = useState<MarketplaceListing | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (listingId === null) { setListing(null); return }
    setLoading(true)
    apiFetch<MarketplaceListing>(`/api/marketplace/listings/${listingId}`)
      .then(setListing)
      .catch(err => console.error('[useMarketplace] detail error:', err))
      .finally(() => setLoading(false))
  }, [listingId])

  return { listing, loading }
}
