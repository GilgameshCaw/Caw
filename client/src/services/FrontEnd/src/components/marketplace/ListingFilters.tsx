import React from 'react'
import { useTheme } from '~/hooks/useTheme'
import { themeTextSecondary, themeBgSubtle, themeBorder, themeInput } from '~/utils/theme'
import { useMarketplaceStore, ListingType, PaymentToken, SortOption } from '~/store/marketplaceStore'

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
    <div className={`flex flex-wrap gap-3 p-4 rounded-xl ${themeBgSubtle(isDark)} ${themeBorder(isDark)} border`}>
      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Type</label>
        <select
          value={filters.listingType}
          onChange={e => setFilter('listingType', e.target.value as ListingType)}
          className={selectClass}
        >
          {LISTING_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Payment</label>
        <select
          value={filters.paymentToken}
          onChange={e => setFilter('paymentToken', e.target.value as PaymentToken)}
          className={selectClass}
        >
          {PAYMENT_TOKENS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Min Length</label>
        <input
          type="number"
          min={0}
          max={255}
          value={filters.minLength || ''}
          onChange={e => setFilter('minLength', parseInt(e.target.value) || 0)}
          placeholder="1"
          className={`w-20 ${selectClass}`}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Max Length</label>
        <input
          type="number"
          min={0}
          max={255}
          value={filters.maxLength >= 999 ? '' : filters.maxLength}
          onChange={e => setFilter('maxLength', parseInt(e.target.value) || 999)}
          placeholder="Any"
          className={`w-20 ${selectClass}`}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>Sort</label>
        <select
          value={filters.sort}
          onChange={e => setFilter('sort', e.target.value as SortOption)}
          className={selectClass}
        >
          {SORT_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
    </div>
  )
}

export default ListingFilters
