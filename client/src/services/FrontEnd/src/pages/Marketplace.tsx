import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { HiOutlineSearch, HiOutlineInformationCircle, HiOutlineCurrencyDollar, HiOutlineTag } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { themeText, themeTextMuted, themeTextSecondary, themeBorder, themeBgSubtle } from '~/utils/theme'
import { useMarketplaceListings, useMarketplaceSales } from '~/hooks/useMarketplace'
import { apiFetch } from '~/api/client'
import { useTokenDataStore, usePriceStore, useActiveToken, refetchTokenDataUntilChanged } from '~/store/tokenDataStore'
import { useMarketplaceStore, MarketplaceListing, MarketplaceOffer } from '~/store/marketplaceStore'
import ListingCard from '~/components/marketplace/ListingCard'
import ListingFilters from '~/components/marketplace/ListingFilters'
import SaleCard from '~/components/marketplace/SaleCard'
import { useSearchParams, useLocation } from 'react-router-dom'
import { Link, useNavigate } from '~/utils/localizedRouter'
import { formatAddress } from '~/utils'
import ProfileCard from '~/components/marketplace/ProfileCard'
import RefundsBanner from '~/components/marketplace/RefundsBanner'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { readContract } from '@wagmi/core'
import { wagmiConfig } from '~/config/Web3Provider'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { formatEther, formatUnits } from 'viem'
import { CAW_NAME_MARKETPLACE_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi, cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'
import UsernameSvg from '~/components/UsernameSvg'
import { useT } from '~/i18n/I18nProvider'
import { useOffersUnreadStore } from '~/store/offersUnreadStore'
import { useSalesUnreadStore } from '~/store/salesUnreadStore'

type Tab = 'listings' | 'sales' | 'mine' | 'offers'

function formatBurned(raw: string): string {
  const n = Number(raw)
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toLocaleString()
}

const VALID_TABS: Tab[] = ['listings', 'sales', 'mine', 'offers']

const Marketplace: React.FC = () => {
  const t = useT()
  const { isDark } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation() as any
  const tabParam = searchParams.get('tab') as Tab | null
  const [activeTab, setActiveTab] = useState<Tab>(
    tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'listings'
  )
  const activeToken = useActiveToken()
  const offersUnreadCount = useOffersUnreadStore(s => s.unreadCount)
  const salesUnreadCount = useSalesUnreadStore(s => s.unreadCount)
  const setSalesUnreadCount = useSalesUnreadStore(s => s.setUnreadCount)
  const [stats, setStats] = useState<{ totalUsers: number; activeListings: number; totalCawBurned: string } | null>(null)
  const navigate = useNavigate()

  // Clear the sales badge whenever the user lands on the sales tab —
  // covers both the click handler AND deep-link / refresh on ?tab=sales.
  useEffect(() => {
    if (activeTab !== 'sales') return
    if (salesUnreadCount === 0 || !activeToken?.tokenId) return
    setSalesUnreadCount(0)
    apiFetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: activeToken.tokenId,
        types: ['SALE_SOLD', 'SALE_BOUGHT'],
      }),
    }).catch(() => {})
  }, [activeTab, salesUnreadCount, activeToken?.tokenId])

  // Sync tab to URL
  useEffect(() => {
    const currentTab = searchParams.get('tab')
    if (currentTab !== activeTab) {
      if (activeTab === 'listings') {
        searchParams.delete('tab')
      } else {
        searchParams.set('tab', activeTab)
      }
      setSearchParams(searchParams, { replace: true })
    }
  }, [activeTab])

  // If we navigated here from ProfileChooser "Manage my profiles",
  // scroll the user down to the tabs (otherwise leave scroll untouched).
  useEffect(() => {
    const shouldScroll = location?.state?.scrollTo === 'my-profiles'
    if (!shouldScroll) return
    if (activeTab !== 'mine') return

    // Wait a frame so layout is ready.
    requestAnimationFrame(() => {
      const el = document.getElementById('usernames-tabs')
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [activeTab, location?.state])

  // The offers badge intentionally does NOT clear on view — it tracks the
  // count of ACTIVE offers received and only drops when each offer is
  // accepted or cancelled (server-side `status` transition). The next badge
  // poll picks up the change automatically.

  useEffect(() => {
    Promise.all([
      apiFetch<{ totalUsers: number; totalCawBurned: string }>('/api/stats'),
      apiFetch<{ listings: any[]; total: number }>('/api/marketplace/listings?limit=0&status=ACTIVE'),
    ]).then(([communityStats, marketStats]) => {
      setStats({
        totalUsers: communityStats.totalUsers,
        activeListings: marketStats.total,
        totalCawBurned: communityStats.totalCawBurned,
      })
    }).catch(() => {})
  }, [])

  return (
      <div className="max-w-5xl mx-auto px-6 py-4">
        {/* Hero */}
        <div className="mb-8">
          <h1 className={`text-2xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {t('marketplace.title')}
          </h1>
          <div className={`flex items-center gap-2 mt-2 text-sm ${
            isDark ? 'text-gray-400' : 'text-gray-500'
          }`}>
            <HiOutlineInformationCircle className="w-4 h-4 flex-shrink-0" />
            <span>{t('marketplace.subtitle')}</span>
          </div>

          {/* Stats row. On mobile we'd otherwise show 2-on-row-1 + 1-orphan
              left-aligned in row 2 — span the third card across both
              columns at small widths so it centers, and reset on sm+ where
              all three fit in one row. */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-5">
              <StatCard label={t('marketplace.stats.profiles_created')} value={stats.totalUsers.toLocaleString()} isDark={isDark} />
              <StatCard label={t('marketplace.stats.for_sale')} value={stats.activeListings.toLocaleString()} isDark={isDark} />
              <div className="col-span-2 sm:col-span-1">
                <StatCard label={t('marketplace.stats.caw_burned')} value={formatBurned(stats.totalCawBurned)} isDark={isDark} />
              </div>
            </div>
          )}

          {/* Create Profile CTA */}
          <div className="flex justify-center mt-6">
            <button
              onClick={() => navigate('/usernames/new')}
              className="px-8 py-3 rounded-xl text-base font-semibold bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer"
            >
              {t('marketplace.create_button')}
            </button>
          </div>
        </div>

        {/* Marketplace section */}
        <div className={`border-t pt-6 ${themeBorder(isDark)}`}>
          <h2 className={`text-3xl font-bold mb-4 ${themeText(isDark)}`}>{t('marketplace.title')}</h2>

          {/* Claimable refunds (outbid bids + cancelled/reclaimed auctions) */}
          <RefundsBanner />

          {/* Tabs */}
          <div id="usernames-tabs" className={`flex gap-1 mb-6 border-b ${themeBorder(isDark)}`}>
            <TabButton active={activeTab === 'listings'} onClick={() => setActiveTab('listings')} isDark={isDark}>
              {t('marketplace.tab.for_sale')}
            </TabButton>
            <TabButton active={activeTab === 'sales'} onClick={() => setActiveTab('sales')} isDark={isDark}>
              {t('marketplace.tab.recent_sales')}
              {salesUnreadCount > 0 && (
                <span className="ml-1.5 min-w-[18px] h-[18px] inline-flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1">
                  {salesUnreadCount > 99 ? '99+' : salesUnreadCount}
                </span>
              )}
            </TabButton>
            <TabButton active={activeTab === 'mine'} onClick={() => setActiveTab('mine')} isDark={isDark}>
              {t('marketplace.tab.my_profiles')}
            </TabButton>
            <TabButton active={activeTab === 'offers'} onClick={() => setActiveTab('offers')} isDark={isDark}>
              {t('marketplace.tab.my_offers')}
              {offersUnreadCount > 0 && (
                <span className="ml-1.5 min-w-[18px] h-[18px] inline-flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1">
                  {offersUnreadCount > 99 ? '99+' : offersUnreadCount}
                </span>
              )}
            </TabButton>
          </div>

          <div className="pb-[calc(var(--bottom-nav-h,0px)+16px)]">
            {activeTab === 'listings' && <ListingsTab />}
            {activeTab === 'sales' && <SalesTab />}
            {activeTab === 'mine' && <MyProfilesTab />}
            {activeTab === 'offers' && <MyOffersTab />}
          </div>
        </div>
      </div>
  )
}

const StatCard: React.FC<{ label: string; value: string; isDark: boolean }> = ({ label, value, isDark }) => (
  <div className={`px-1 py-6 rounded-lg border transition-all duration-300 flex flex-col items-center justify-between ${
    isDark ? 'border-white/20 bg-black' : 'border-gray-200 bg-white'
  }`}>
    <div className={`text-3xl font-bold transition-colors duration-300 text-center flex-1 flex items-center ${
      isDark ? 'text-white' : 'text-black'
    }`}>
      {value}
    </div>
    <div className={`text-sm transition-colors duration-300 text-center ${
      isDark ? 'text-gray-400' : 'text-gray-600'
    }`}>
      {label}
    </div>
  </div>
)

const TabButton: React.FC<{ active: boolean; onClick: () => void; isDark: boolean; children: React.ReactNode }> = ({
  active, onClick, isDark, children,
}) => (
  <button
    onClick={onClick}
    className={`flex-1 inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium transition cursor-pointer -mb-px border-b-2 ${
      active
        ? (isDark ? 'border-yellow-500 text-yellow-500' : 'border-yellow-600 text-yellow-700')
        : `border-transparent ${themeTextMuted(isDark)} hover:${isDark ? 'text-white' : 'text-gray-900'}`
    }`}
  >
    {children}
  </button>
)

const ListingsTab: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { listings, total, loading, loadMore, hasMore } = useMarketplaceListings()

  return (
    <>
      <ListingFilters />

      <p className={`text-sm mt-4 mb-4 ${themeTextMuted(isDark)}`}>
        {t('marketplace.listings_count', { count: total })}
      </p>

      {listings.length > 0 ? (
        <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
          {listings.map(l => <ListingCard key={l.id} listing={l} />)}
        </div>
      ) : !loading ? (
        <div className={`text-center py-12 ${themeBgSubtle(isDark)} rounded-xl`}>
          <HiOutlineSearch className={`w-12 h-12 mx-auto mb-4 opacity-30 ${
            isDark ? 'text-white' : 'text-black'
          }`} />
          <h3 className={`text-lg font-semibold mb-2 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {t('marketplace.listings_empty.title')}
          </h3>
          <p className={`transition-colors duration-300 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            {t('marketplace.listings_empty.hint')}
          </p>
        </div>
      ) : null}

      {loading && (
        <div className="flex justify-center py-8">
          <div className={`w-8 h-8 border-2 border-t-transparent rounded-full animate-spin ${isDark ? 'border-yellow-500' : 'border-yellow-600'}`} />
        </div>
      )}

      {hasMore && !loading && (
        <div className="flex justify-center mt-6">
          <button
            onClick={loadMore}
            className={`px-6 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
              isDark ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
            }`}
          >
            {t('common.load_more')}
          </button>
        </div>
      )}
    </>
  )
}

const SalesTab: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { sales, total, loading } = useMarketplaceSales()

  return (
    <>
      <p className={`text-sm mb-4 ${themeTextMuted(isDark)}`}>
        {t('marketplace.sales_count', { count: total })}
      </p>

      {sales.length > 0 ? (
        <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
          {sales.map(s => <SaleCard key={s.id} sale={s} />)}
        </div>
      ) : !loading ? (
        <div className={`text-center py-12 ${themeBgSubtle(isDark)} rounded-xl`}>
          <HiOutlineCurrencyDollar className={`w-12 h-12 mx-auto mb-4 opacity-30 ${
            isDark ? 'text-white' : 'text-black'
          }`} />
          <h3 className={`text-lg font-semibold mb-2 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {t('marketplace.sales_empty.title')}
          </h3>
          <p className={`transition-colors duration-300 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            {t('marketplace.sales_empty.hint')}
          </p>
        </div>
      ) : null}

      {loading && (
        <div className="flex justify-center py-8">
          <div className={`w-8 h-8 border-2 border-t-transparent rounded-full animate-spin ${isDark ? 'border-yellow-500' : 'border-yellow-600'}`} />
        </div>
      )}
    </>
  )
}

const MyProfilesTab: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const openCreateListing = useMarketplaceStore(s => s.openCreateListing)
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)

  const allTokens = useMemo(
    () => Object.values(tokensByAddress).flat(),
    [tokensByAddress]
  )

  const addressKey = useMemo(
    () => Object.keys(tokensByAddress).map(a => a.toLowerCase()).sort().join(','),
    [tokensByAddress]
  )

  const [myListings, setMyListings] = useState<MarketplaceListing[]>([])
  const [loading, setLoading] = useState(false)
  const refreshCounter = useMarketplaceStore(s => s.refreshCounter)

  useEffect(() => {
    if (!addressKey) return
    const addresses = addressKey.split(',').filter(Boolean)
    if (addresses.length === 0) return

    setLoading(true)
    Promise.all(
      addresses.map(addr =>
        apiFetch<{ listings: MarketplaceListing[]; total: number }>(`/api/marketplace/listings/seller/${addr}?status=ACTIVE`)
      )
    )
      .then(results => setMyListings(results.flatMap(r => r.listings)))
      .catch(err => console.error('[MyProfiles] fetch error:', err))
      .finally(() => setLoading(false))
  }, [addressKey, refreshCounter])

  return (
    <>
      {/* Active listings */}
      {myListings.length > 0 && (
        <div className="mb-8">
          <h3 className={`text-sm font-medium mb-3 ${themeTextMuted(isDark)}`}>
            {t('marketplace.my_profiles.active_listings', { count: myListings.length })}
          </h3>
          <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
            {myListings.map(l => <ListingCard key={l.id} listing={l} showCancel />)}
          </div>
        </div>
      )}

      {/* Unlisted usernames */}
      {(() => {
        const unlisted = allTokens.filter(t => !myListings.some(l => l.tokenId === t.tokenId))
        return (
          <div className="mb-8">
            <h3 className={`text-sm font-medium mb-3 ${themeTextMuted(isDark)}`}>
              {t('marketplace.my_profiles.your_usernames', { count: unlisted.length })}
            </h3>
            {unlisted.length > 0 ? (
              <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
                {unlisted.map(token => (
                  <ProfileCard key={token.tokenId} username={token.username}>
                    <div className="flex items-center justify-center">
                      <button
                        onClick={() => openCreateListing(token.tokenId, token.username)}
                        className={`px-5 py-2.5 rounded-lg text-sm font-medium transition cursor-pointer ${
                          isDark
                            ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                            : 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
                        }`}
                      >
                        {t('create_listing.button.list')}
                      </button>
                    </div>
                  </ProfileCard>
                ))}
              </div>
            ) : allTokens.length === 0 ? (
              <div className={`text-center py-12 ${themeBgSubtle(isDark)} rounded-xl`}>
                <p className={`text-lg ${themeTextMuted(isDark)}`}>{t('marketplace.empty.title')}</p>
                <p className={`text-sm mt-1 ${themeTextMuted(isDark)}`}>
                  {t('marketplace.empty.hint')}
                </p>
              </div>
            ) : null}
          </div>
        )
      })()}

      {loading && (
        <div className="flex justify-center py-8">
          <div className={`w-8 h-8 border-2 border-t-transparent rounded-full animate-spin ${isDark ? 'border-yellow-500' : 'border-yellow-600'}`} />
        </div>
      )}
    </>
  )
}

const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6 }

function fmtPrice(raw: string, token: string): string {
  const dec = DECIMALS[token] ?? 18
  const num = parseFloat(dec === 18 ? formatEther(BigInt(raw)) : formatUnits(BigInt(raw), dec))
  if (token === 'CAW') return num.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (token === 'USDC' || token === 'USDT') return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function formatTimeLeft(expiry: string): string {
  const diff = new Date(expiry).getTime() - Date.now()
  if (diff <= 0) return 'Expired' /* not localized — internal date helper, replaced where displayed */
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  if (days > 0) return `${days}d ${hours}h left`
  const mins = Math.floor((diff % 3600000) / 60000)
  if (hours > 0) return `${hours}h ${mins}m left`
  return `${mins}m left`
}

const MyOffersTab: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { address: walletAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const refreshCounter = useMarketplaceStore(s => s.refreshCounter)
  const navigate = useNavigate()

  // The address whose received offers we should fetch — must be the owner of
  // the user's active profile, not "whatever address happens to be first in
  // tokensByAddress". The store can hold tokens for multiple addresses (e.g.
  // after a marketplace-buy promotes a new wallet) and Object.keys()[0] is
  // arbitrary; picking it caused the My Offers list to come up empty even
  // when the badge endpoint (which resolves address from tokenId server-side)
  // saw the offer. Use the active token's owner so both queries agree.
  const activeToken = useActiveToken()
  const address = activeToken?.address?.toLowerCase() ?? walletAddress?.toLowerCase() ?? null

  const [sentOffers, setSentOffers] = useState<MarketplaceOffer[]>([])
  const [receivedOffers, setReceivedOffers] = useState<MarketplaceOffer[]>([])
  const [loading, setLoading] = useState(false)
  const [cancellingId, setCancellingId] = useState<number | null>(null)

  // Cancel offer hooks
  const { writeContract, data: cancelHash, isPending: isCancelPending, error: cancelError, reset: resetCancel } = useWriteContract()
  const { isLoading: isCancelConfirming, isSuccess: isCancelSuccess } = useWaitForTransactionReceipt({ hash: cancelHash })

  // Accept offer hooks
  const { writeContract: writeApprove, data: approveHash, isPending: isApproving, reset: resetApprove } = useWriteContract()
  const { isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })
  const { writeContract: writeAccept, data: acceptHash, isPending: isAcceptPending, error: acceptError, reset: resetAccept } = useWriteContract()
  const { isLoading: isAcceptConfirming, isSuccess: isAcceptSuccess } = useWaitForTransactionReceipt({ hash: acceptHash })
  const [acceptingId, setAcceptingId] = useState<number | null>(null)
  const [pendingAcceptAfterApprove, setPendingAcceptAfterApprove] = useState<MarketplaceOffer | null>(null)
  const [lzFee, setLzFee] = useState(0n)
  const [acceptFailureMessage, setAcceptFailureMessage] = useState<string | null>(null)

  // Check NFT approval
  const { data: isNftApproved, refetch: refetchApproval } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
    functionName: 'isApprovedForAll',
    args: [walletAddress!, CAW_NAME_MARKETPLACE_ADDRESS],
    chainId: chains.l1.chainId,
    query: { enabled: !!walletAddress },
  })

  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  // Quote LZ fee fresh, immediately before signing
  const quoteAndAccept = async (offer: MarketplaceOffer) => {
    if (!walletAddress) return
    try {
      const quote: any = await readContract(wagmiConfig, {
        address: CAW_NAME_QUOTER_ADDRESS,
        abi: cawProfileQuoterAbi,
        functionName: 'syncTransferQuote',
        args: [offer.tokenId, offer.offerer as `0x${string}`, false],
        chainId: chains.l1.chainId,
      })
      const exactFee = quote.nativeFee as bigint
      setLzFee(exactFee)
      setAcceptingId(offer.offerId)
      writeAccept({
        address: CAW_NAME_MARKETPLACE_ADDRESS,
        abi: cawProfileMarketplaceAbi,
        functionName: 'acceptOffer',
        args: [BigInt(offer.offerId)],
        value: exactFee,
        chainId: chains.l1.chainId,
      })
    } catch (err: any) {
      console.error('[Accept offer] LZ fee quote failed:', err)
      setAcceptFailureMessage(t('marketplace.error.lz_fee_quote'))
      // Report to backend for admin visibility
      apiFetch('/api/marketplace/offers/report-failure', {
        method: 'POST',
        body: JSON.stringify({
          offerId: offer.offerId,
          stage: 'quote',
          error: String(err?.message || err),
        }),
      }).catch(() => {})
    }
  }

  // Surface wagmi tx errors with a friendly message + report to backend
  useEffect(() => {
    if (!acceptError) return
    const msg = acceptError.message?.includes('User rejected')
      ? t('profile.error.tx_rejected')
      : t('marketplace.error.accept_offer')
    setAcceptFailureMessage(msg)
    setAcceptingId(null)
    setPendingAcceptAfterApprove(null)
    // Report to backend for admin visibility
    if (acceptingId !== null) {
      apiFetch('/api/marketplace/offers/report-failure', {
        method: 'POST',
        body: JSON.stringify({
          offerId: acceptingId,
          stage: 'accept',
          error: String(acceptError.message || acceptError),
        }),
      }).catch(() => {})
    }
  }, [acceptError])

  // After approval succeeds, auto-trigger the accept tx with a fresh quote
  useEffect(() => {
    if (!isApproveSuccess) return
    refetchApproval()
    if (pendingAcceptAfterApprove) {
      const offer = pendingAcceptAfterApprove
      setPendingAcceptAfterApprove(null)
      quoteAndAccept(offer)
    }
  }, [isApproveSuccess])

  // Handle accept success — mark sold on server, remove the sold token from the store, switch active token
  useEffect(() => {
    if (!isAcceptSuccess || acceptingId === null) return
    const offer = receivedOffers.find(o => o.offerId === acceptingId)
    if (offer) {
      apiFetch(`/api/marketplace/offers/${offer.offerId}/accepted`, {
        method: 'POST',
        body: JSON.stringify({ txHash: acceptHash, buyer: offer.offerer }),
      }).catch(() => {})

      // Remove the sold token from the local store
      const store = useTokenDataStore.getState()
      store.removeToken(offer.tokenId)

      // If the sold token was the active one, switch to another token (or clear)
      const remaining = Object.values(store.tokensByAddress).flat().filter(t => t.tokenId !== offer.tokenId)
      if (store.activeTokenId === offer.tokenId) {
        if (remaining.length > 0) {
          store.setActiveTokenId(remaining[0].tokenId)
        } else {
          store.removeActiveToken()
        }
      }

      // Backoff-poll until the chooser sees the ownership change. The
      // server endpoint only flips offer status; User.address comes from
      // the indexer reading the L2 OfferAccepted event.
      refetchTokenDataUntilChanged()
    }
    setReceivedOffers(prev => prev.filter(o => o.offerId !== acceptingId))
    setAcceptingId(null)
    resetAccept()
  }, [isAcceptSuccess])

  // Fetch sent and received offers
  useEffect(() => {
    if (!address) { setSentOffers([]); setReceivedOffers([]); return }
    setLoading(true)
    Promise.all([
      apiFetch<{ offers: MarketplaceOffer[]; total: number }>(`/api/marketplace/offers/address/${address}`),
      apiFetch<{ offers: MarketplaceOffer[]; total: number }>(`/api/marketplace/offers/received/${address}`),
    ])
      .then(([sent, received]) => {
        setSentOffers(sent.offers)
        setReceivedOffers(received.offers)
      })
      .catch(() => { setSentOffers([]); setReceivedOffers([]) })
      .finally(() => setLoading(false))
  }, [address, refreshCounter])

  // Handle cancel success
  useEffect(() => {
    if (!isCancelSuccess || cancellingId === null) return
    const offer = sentOffers.find(o => o.offerId === cancellingId)
    if (offer) {
      apiFetch(`/api/marketplace/offers/${offer.offerId}/cancelled`, {
        method: 'POST',
        body: JSON.stringify({ txHash: cancelHash }),
      }).catch(() => {})
    }
    setSentOffers(prev => prev.filter(o => o.offerId !== cancellingId))
    setCancellingId(null)
    resetCancel()
  }, [isCancelSuccess])

  const handleCancel = (offer: MarketplaceOffer) => {
    if (!isConnected) { openConnectModal?.(); return }
    if (needsChainSwitch) { switchChain({ chainId: chains.l1.chainId }); return }
    if (cancelError) resetCancel()
    setCancellingId(offer.offerId)
    writeContract({
      address: CAW_NAME_MARKETPLACE_ADDRESS,
      abi: cawProfileMarketplaceAbi,
      functionName: 'cancelOffer',
      args: [BigInt(offer.offerId)],
      chainId: chains.l1.chainId,
    })
  }

  const handleDenyReceived = (offer: MarketplaceOffer) => {
    setReceivedOffers(prev => prev.filter(o => o.offerId !== offer.offerId))
    apiFetch(`/api/marketplace/offers/${offer.id}/dismiss`, {
      method: 'POST',
    }).catch(err => console.warn('[MyOffers] Failed to dismiss offer:', err))
  }

  const handleAcceptReceived = (offer: MarketplaceOffer) => {
    if (!isConnected) { openConnectModal?.(); return }
    if (needsChainSwitch) { switchChain({ chainId: chains.l1.chainId }); return }
    if (acceptError) resetAccept()
    setAcceptFailureMessage(null)
    if (!isNftApproved) {
      // Queue the accept to fire automatically after approval confirms
      setPendingAcceptAfterApprove(offer)
      setAcceptingId(offer.offerId)
      writeApprove({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
        functionName: 'setApprovalForAll',
        args: [CAW_NAME_MARKETPLACE_ADDRESS, true],
        chainId: chains.l1.chainId,
      })
      return
    }
    // Quote fresh and send the exact fee — no padding
    quoteAndAccept(offer)
  }

  // Helper to compute USD value
  const getUsdStr = (offer: MarketplaceOffer) => {
    const token = offer.paymentToken
    const dec = DECIMALS[token] ?? 18
    const num = parseFloat(dec === 18 ? formatEther(BigInt(offer.amount)) : formatUnits(BigInt(offer.amount), dec))
    let rate = 0
    if (token === 'USDC' || token === 'USDT') rate = 1
    else if (token === 'ETH' || token === 'WETH') rate = ethPrice
    else if (token === 'CAW') rate = cawPrice
    const usd = rate > 0 ? num * rate : 0
    return usd > 0
      ? usd < 0.01 ? '<$0.01' : `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : null
  }

  if (!address) {
    return (
      <div className={`text-center py-16 ${themeBgSubtle(isDark)} rounded-xl`}>
        <p className={`text-lg ${themeTextMuted(isDark)}`}>{t('marketplace.my_offers.signin_required')}</p>
      </div>
    )
  }

  return (
    <>
      {/* Cancel error */}
      {cancelError && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
          {cancelError.message?.includes('User rejected')
            ? t('profile.error.tx_rejected')
            : t('marketplace.error.tx_failed')}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-8">
          <div className={`w-8 h-8 border-2 border-t-transparent rounded-full animate-spin ${isDark ? 'border-yellow-500' : 'border-yellow-600'}`} />
        </div>
      )}

      {/* Offers Sent */}
      {!loading && (
        <div className="mb-8">
          <h3 className={`text-sm font-medium mb-3 ${themeTextMuted(isDark)}`}>
            {t('marketplace.offers.sent.title', { n: sentOffers.length })}
          </h3>
          {sentOffers.length > 0 ? (
            <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
              {sentOffers.map(offer => {
                const isThisOffer = cancellingId === offer.offerId
                const isCancelling = isThisOffer && (isCancelPending || isCancelConfirming)
                const usdStr = getUsdStr(offer)

                return (
                  <div
                    key={offer.offerId}
                    className={`p-4 rounded-xl border transition-all duration-200 ${
                      isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white'
                    }`}
                  >
                    <div
                      className="cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => navigate(`/users/${offer.username}`)}
                    >
                      <div className="w-full max-w-[160px] mx-auto mb-3">
                        <UsernameSvg username={offer.username} />
                      </div>
                    </div>
                    <div className="text-center mb-3">
                      {usdStr && (
                        <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {usdStr}
                        </div>
                      )}
                      <div className={`text-sm ${themeTextMuted(isDark)}`}>
                        {fmtPrice(offer.amount, offer.paymentToken)} {offer.paymentToken}
                      </div>
                      <div className={`text-xs mt-1 ${themeTextMuted(isDark)}`}>
                        {formatTimeLeft(offer.expiry)}
                      </div>
                    </div>
                    <button
                      onClick={() => handleCancel(offer)}
                      disabled={isCancelling || isSwitchingChain}
                      className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer disabled:opacity-50 ${
                        isDark
                          ? 'bg-white/10 text-white hover:bg-white/20'
                          : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                      }`}
                    >
                      {isThisOffer && isCancelPending ? t('marketplace.button.confirm_in_wallet')
                        : isThisOffer && isCancelConfirming ? t('staking.button.withdrawing')
                        : t('marketplace.button.cancel_withdraw')}
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className={`text-center py-12 ${themeBgSubtle(isDark)} rounded-xl`}>
              <HiOutlineTag className={`w-12 h-12 mx-auto mb-4 opacity-30 ${
                isDark ? 'text-white' : 'text-black'
              }`} />
              <h3 className={`text-lg font-semibold mb-2 transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {t('marketplace.offers.sent.empty.title')}
              </h3>
              <p className={`transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                {t('marketplace.offers.sent.empty.body')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Accept failure message */}
      {acceptFailureMessage && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
          {acceptFailureMessage}
        </div>
      )}

      {/* Offers Received */}
      {!loading && (
        <div className="mb-8">
          <h3 className={`text-sm font-medium mb-3 ${themeTextMuted(isDark)}`}>
            {t('marketplace.offers.received.title', { n: receivedOffers.length })}
          </h3>
          {receivedOffers.length > 0 ? (
            <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
              {receivedOffers.map(offer => {
                const usdStr = getUsdStr(offer)
                return (
                  <div
                    key={offer.offerId}
                    className={`p-4 rounded-xl border transition-all duration-200 ${
                      isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white'
                    }`}
                  >
                    <div
                      className="cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => navigate(`/users/${offer.username}`)}
                    >
                      <div className="w-full max-w-[160px] mx-auto mb-3">
                        <UsernameSvg username={offer.username} />
                      </div>
                    </div>
                    <div className="text-center mb-3">
                      {usdStr && (
                        <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {usdStr}
                        </div>
                      )}
                      <div className={`text-sm ${themeTextMuted(isDark)}`}>
                        {fmtPrice(offer.amount, offer.paymentToken)} {offer.paymentToken}
                      </div>
                      <div className={`text-xs mt-1 ${themeTextMuted(isDark)}`}>
                        {t('marketplace.offers.from')}{' '}
                        <Link
                          to={`/address/${offer.offerer.toLowerCase()}`}
                          onClick={e => e.stopPropagation()}
                          className={`hover:underline ${isDark ? 'hover:text-yellow-400' : 'hover:text-yellow-500'}`}
                        >
                          {formatAddress(offer.offerer)}
                        </Link>
                      </div>
                      <div className={`text-xs mt-0.5 ${themeTextMuted(isDark)}`}>
                        {formatTimeLeft(offer.expiry)}
                      </div>
                    </div>
                    {(() => {
                      const isThisAccepting = acceptingId === offer.offerId
                      const isActing = isThisAccepting && (isAcceptPending || isAcceptConfirming)
                      return (
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleAcceptReceived(offer)}
                            disabled={isActing || isSwitchingChain || isApproving}
                            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50"
                          >
                            {isThisAccepting && isApproving ? t('staking.button.approving')
                              : isThisAccepting && (isAcceptPending || isAcceptConfirming) ? t('marketplace.button.accepting')
                              : t('marketplace.button.accept')}
                          </button>
                          <button
                            onClick={() => handleDenyReceived(offer)}
                            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
                              isDark
                                ? 'bg-white/10 text-white hover:bg-white/20'
                                : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                            }`}
                          >
                            {t('marketplace.button.deny')}
                          </button>
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className={`text-center py-12 ${themeBgSubtle(isDark)} rounded-xl`}>
              <HiOutlineTag className={`w-12 h-12 mx-auto mb-4 opacity-30 ${
                isDark ? 'text-white' : 'text-black'
              }`} />
              <h3 className={`text-lg font-semibold mb-2 transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {t('marketplace.offers.received.empty.title')}
              </h3>
              <p className={`transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                {t('marketplace.offers.received.empty.body')}
              </p>
            </div>
          )}
        </div>
      )}
    </>
  )
}

export default Marketplace
