import React, { useMemo } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { themeTextSecondary, themeTextMuted } from '~/utils/theme'
import { MarketplaceSale } from '~/store/marketplaceStore'
import { formatEther, formatUnits } from 'viem'
import { usePriceStore } from '~/store/tokenDataStore'
import ProfileCard from './ProfileCard'

function formatPrice(price: string, token: string): string {
  const num = parsePrice(price, token)
  if (token === 'CAW') return num.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (token === 'USDC' || token === 'USDT') return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function parsePrice(price: string, token: string): number {
  if (token === 'USDC' || token === 'USDT') {
    return parseFloat(formatUnits(BigInt(price), 6))
  }
  return parseFloat(formatEther(BigInt(price)))
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const SaleCard: React.FC<{ sale: MarketplaceSale }> = ({ sale }) => {
  const { isDark } = useTheme()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  const displayPrice = useMemo(() => formatPrice(sale.price, sale.paymentToken), [sale.price, sale.paymentToken])

  const usdDisplay = useMemo(() => {
    const token = sale.paymentToken
    if (token === 'USDC' || token === 'USDT') return null
    const num = parsePrice(sale.price, token)
    let rate = 0
    if (token === 'ETH' || token === 'WETH') rate = ethPrice
    else if (token === 'CAW') rate = cawPrice
    if (!rate) return null
    const usd = num * rate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [sale.price, sale.paymentToken, ethPrice, cawPrice])

  return (
    <ProfileCard username={sale.username}>
      <div className="space-y-2">
        {/* Sold badge and time */}
        <div className="flex items-center justify-between">
          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-500/20 text-red-400">
            Sold
          </span>
          <span className={`text-xs ${themeTextMuted(isDark)}`}>
            {timeAgo(sale.createdAt)}
          </span>
        </div>

        {/* Final price */}
        <div className="text-center">
          <div className="flex items-baseline justify-center gap-1.5">
            <span className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {displayPrice}
            </span>
            <span className={`text-sm ${themeTextSecondary(isDark)}`}>
              {sale.paymentToken}
            </span>
          </div>
          {usdDisplay && (
            <div className={`text-xs ${themeTextMuted(isDark)}`}>
              {usdDisplay}
            </div>
          )}
        </div>
      </div>
    </ProfileCard>
  )
}

export default SaleCard
