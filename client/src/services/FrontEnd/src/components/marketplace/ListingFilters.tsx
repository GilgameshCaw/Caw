import React from 'react'
import { useTheme } from '~/hooks/useTheme'
import { themeTextSecondary, themeBgSubtle, themeBorder, themeInput } from '~/utils/theme'
import { useMarketplaceStore, ListingType, PaymentToken, SortOption } from '~/store/marketplaceStore'
import ThemedListbox from '~/components/forms/ThemedListbox'
import { useT } from '~/i18n/I18nProvider'

const ListingFilters: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { filters, setFilter } = useMarketplaceStore()

  const LISTING_TYPES: { value: ListingType; label: string }[] = [
    { value: 'all', label: t('marketplace.filter.type.all') },
    { value: 'FIXED', label: t('marketplace.filter.type.fixed') },
    { value: 'DUTCH_AUCTION', label: t('marketplace.filter.type.dutch') },
    { value: 'ENGLISH_AUCTION', label: t('marketplace.filter.type.english') },
  ]

  const PAYMENT_TOKENS: { value: PaymentToken; label: string }[] = [
    { value: 'all', label: t('marketplace.filter.payment.all') },
    { value: 'ETH', label: 'ETH' },
    { value: 'CAW', label: 'CAW' },
    { value: 'WETH', label: 'WETH' },
    { value: 'USDC', label: 'USDC' },
    { value: 'USDT', label: 'USDT' },
  ]

  const SORT_OPTIONS: { value: SortOption; label: string }[] = [
    { value: 'newest', label: t('marketplace.filter.sort.newest') },
    { value: 'price_asc', label: t('marketplace.filter.sort.price_asc') },
    { value: 'price_desc', label: t('marketplace.filter.sort.price_desc') },
    { value: 'length_asc', label: t('marketplace.filter.sort.length_asc') },
    { value: 'length_desc', label: t('marketplace.filter.sort.length_desc') },
  ]

  // Use fixed height to avoid 1-2px drift between input vs listbox across browsers.
  const selectClass = `h-[52px] px-3 rounded-lg text-sm border outline-none transition cursor-pointer ${themeInput(isDark)} ${themeBorder(isDark)}`

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-xl ${themeBgSubtle(isDark)} ${themeBorder(isDark)} border`}>
      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>{t('marketplace.filter.label.type')}</label>
        <ThemedListbox
          isDark={isDark}
          value={filters.listingType}
          onChange={(v: ListingType) => setFilter('listingType', v)}
          options={LISTING_TYPES}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>{t('marketplace.filter.label.payment')}</label>
        <ThemedListbox
          isDark={isDark}
          value={filters.paymentToken}
          onChange={(v: PaymentToken) => setFilter('paymentToken', v)}
          options={PAYMENT_TOKENS}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>{t('marketplace.filter.label.length')}</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={255}
            value={filters.minLength || ''}
            onChange={e => setFilter('minLength', parseInt(e.target.value) || 0)}
            placeholder={t('marketplace.filter.placeholder.min')}
            className={`flex-1 min-w-0 ${selectClass}`}
          />
          <span className={`text-xs ${themeTextSecondary(isDark)}`}>–</span>
          <input
            type="number"
            min={0}
            max={255}
            value={filters.maxLength >= 999 ? '' : filters.maxLength}
            onChange={e => setFilter('maxLength', parseInt(e.target.value) || 999)}
            placeholder={t('marketplace.filter.placeholder.max')}
            className={`flex-1 min-w-0 ${selectClass}`}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>{t('marketplace.filter.label.sort')}</label>
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
