import React from 'react'
import { useTheme } from '~/hooks/useTheme'
import { themeTextSecondary, themeBgSubtle, themeBorder, themeInput } from '~/utils/theme'
import { useMarketplaceStore, ListingType, PaymentToken, SortOption } from '~/store/marketplaceStore'
import ThemedListbox from '~/components/forms/ThemedListbox'

const LISTING_TYPES: { value: ListingType; label: string }[] = [
  { value: 'all', label: 'All Types' },
  { value: 'FIXED', label: 'Fixed Price' },
  { value: 'DUTCH_AUCTION', label: 'Dutch Auction' },
  { value: 'ENGLISH_AUCTION', label: 'English Auction' },
]

const PAYMENT_TOKENS: { value: PaymentToken; label: string }[] = [
  { value: 'all', label: 'All Tokens' },
  { value: 'ETH', label: 'ETH' },
  { value: 'CAW', label: 'CAW' },
  { value: 'WETH', label: 'WETH' },
  { value: 'USDC', label: 'USDC' },
  { value: 'USDT', label: 'USDT' },
]

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'price_asc', label: 'Price: Low to High' },
  { value: 'price_desc', label: 'Price: High to Low' },
  { value: 'length_asc', label: 'Name: Shortest' },
  { value: 'length_desc', label: 'Name: Longest' },
]

const ListingFilters: React.FC = () => {
  const { isDark } = useTheme()
  const { filters, setFilter } = useMarketplaceStore()

  const selectClass = `px-3 py-2 rounded-lg text-sm border outline-none transition cursor-pointer ${themeInput(isDark)} ${themeBorder(isDark)}`

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-xl ${themeBgSubtle(isDark)} ${themeBorder(isDark)} border`}>
      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Type</label>
        <ThemedListbox
          isDark={isDark}
          value={filters.listingType}
          onChange={(v: ListingType) => setFilter('listingType', v)}
          options={LISTING_TYPES}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Payment</label>
        <ThemedListbox
          isDark={isDark}
          value={filters.paymentToken}
          onChange={(v: PaymentToken) => setFilter('paymentToken', v)}
          options={PAYMENT_TOKENS}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Length</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={255}
            value={filters.minLength || ''}
            onChange={e => setFilter('minLength', parseInt(e.target.value) || 0)}
            placeholder="Min"
            className={`flex-1 min-w-0 ${selectClass}`}
          />
          <span className={`text-xs ${themeTextSecondary(isDark)}`}>–</span>
          <input
            type="number"
            min={0}
            max={255}
            value={filters.maxLength >= 999 ? '' : filters.maxLength}
            onChange={e => setFilter('maxLength', parseInt(e.target.value) || 999)}
            placeholder="Max"
            className={`flex-1 min-w-0 ${selectClass}`}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Sort</label>
        <ThemedListbox
          isDark={isDark}
          value={filters.sort}
          onChange={(v: SortOption) => setFilter('sort', v)}
          options={SORT_OPTIONS}
        />
      </div>
    </div>
  )
}

export default ListingFilters
