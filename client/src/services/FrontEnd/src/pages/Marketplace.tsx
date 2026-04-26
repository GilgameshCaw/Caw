import React, { useState, useEffect, useCallback, useMemo } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { themeText, themeTextMuted, themeTextSecondary, themeBorder, themeBgSubtle } from '~/utils/theme'
import { useMarketplaceListings, useMarketplaceSales } from '~/hooks/useMarketplace'
import { apiFetch } from '~/api/client'
import { useTokenDataStore, usePriceStore, useActiveToken } from '~/store/tokenDataStore'
import { useMarketplaceStore, MarketplaceListing, MarketplaceOffer } from '~/store/marketplaceStore'
import ListingCard from '~/components/marketplace/ListingCard'
import ListingFilters from '~/components/marketplace/ListingFilters'
import SaleCard from '~/components/marketplace/SaleCard'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
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
import { useOffersUnreadStore } from '~/store/offersUnreadStore'

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
  const { isDark } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as Tab | null
  const [activeTab, setActiveTab] = useState<Tab>(
    tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'listings'
  )
  const activeToken = useActiveToken()
  const offersUnreadCount = useOffersUnreadStore(s => s.unreadCount)
  const [stats, setStats] = useState<{ totalUsers: number; activeListings: number; totalCawBurned: string } | null>(null)
  const navigate = useNavigate()

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
    <MainLayout>
      <div className="max-w-5xl mx-auto px-6 py-4">
        {/* Hero */}
        <div className="mb-8">
          <h1 className={`text-3xl font-bold mb-2 ${themeText(isDark)}`}>Usernames</h1>
          <p className={`text-sm ${themeTextSecondary(isDark)}`}>
            Your username is an NFT — create one, or buy and sell on the feeless marketplace.
          </p>

          {/* Stats row */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-5">
              <StatCard label="Profiles Created" value={stats.totalUsers.toLocaleString()} isDark={isDark} />
              <StatCard label="For Sale" value={stats.activeListings.toLocaleString()} isDark={isDark} />
              <StatCard label="CAW Burned" value={formatBurned(stats.totalCawBurned)} isDark={isDark} />
            </div>
          )}

          {/* Create Profile CTA */}
          <div className="flex justify-center mt-6">
            <button
              onClick={() => navigate('/usernames/new')}
              className="px-8 py-3 rounded-xl text-base font-semibold bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer"
            >
              Create New Profile
            </button>
          </div>
        </div>

        {/* Marketplace section */}
        <div className={`border-t pt-6 ${themeBorder(isDark)}`}>
          <h2 className={`text-3xl font-bold mb-4 ${themeText(isDark)}`}>Profile Marketplace</h2>

          {/* Claimable refunds (outbid bids + cancelled/reclaimed auctions) */}
          <RefundsBanner />

          {/* Tabs */}
          <div className={`flex gap-1 mb-6 border-b ${themeBorder(isDark)}`}>
            <TabButton active={activeTab === 'listings'} onClick={() => setActiveTab('listings')} isDark={isDark}>
              For Sale
            </TabButton>
            <TabButton active={activeTab === 'sales'} onClick={() => setActiveTab('sales')} isDark={isDark}>
              Recent Sales
            </TabButton>
            <TabButton active={activeTab === 'mine'} onClick={() => setActiveTab('mine')} isDark={isDark}>
              My Profiles
            </TabButton>
            <TabButton active={activeTab === 'offers'} onClick={() => setActiveTab('offers')} isDark={isDark}>
              My Offers
              {offersUnreadCount > 0 && (
                <span className="ml-1.5 min-w-[18px] h-[18px] inline-flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1">
                  {offersUnreadCount > 99 ? '99+' : offersUnreadCount}
                </span>
              )}
            </TabButton>
          </div>

          {activeTab === 'listings' && <ListingsTab />}
          {activeTab === 'sales' && <SalesTab />}
          {activeTab === 'mine' && <MyProfilesTab />}
          {activeTab === 'offers' && <MyOffersTab />}
        </div>
      </div>
    </MainLayout>
  )
}

const StatCard: React.FC<{ label: string; value: string; isDark: boolean }> = ({ label, value, isDark }) => (
  <div className={`px-1 py-6 rounded-lg border transition-all duration-300 flex flex-col items-center justify-between ${
    isDark ? 'border-white/20 bg-black' : 'border-gray-200 bg-gray-50 shadow-xl'
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
    className={`px-4 py-2.5 text-sm font-medium transition cursor-pointer -mb-px border-b-2 ${
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
  const { listings, total, loading, loadMore, hasMore } = useMarketplaceListings()

  return (
    <>
      <ListingFilters />

      <p className={`text-sm mt-4 mb-4 ${themeTextMuted(isDark)}`}>
        {total} listing{total !== 1 ? 's' : ''}
      </p>

      {listings.length > 0 ? (
        <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
          {listings.map(l => <ListingCard key={l.id} listing={l} />)}
        </div>
      ) : !loading ? (
        <div className={`text-center py-16 ${themeBgSubtle(isDark)} rounded-xl ${isDark ? '' : 'shadow-inner'}`}>
          <p className={`text-lg ${themeTextMuted(isDark)}`}>No listings found</p>
          <p className={`text-sm mt-1 ${themeTextMuted(isDark)}`}>Try adjusting your filters</p>
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
            Load More
          </button>
        </div>
      )}
    </>
  )
}

const SalesTab: React.FC = () => {
  const { isDark } = useTheme()
  const { sales, total, loading } = useMarketplaceSales()

  return (
    <>
      <p className={`text-sm mb-4 ${themeTextMuted(isDark)}`}>
        {total} sale{total !== 1 ? 's' : ''}
      </p>

      {sales.length > 0 ? (
        <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
          {sales.map(s => <SaleCard key={s.id} sale={s} />)}
        </div>
      ) : !loading ? (
        <div className={`text-center py-16 ${themeBgSubtle(isDark)} rounded-xl ${isDark ? '' : 'shadow-inner'}`}>
          <p className={`text-lg ${themeTextMuted(isDark)}`}>No completed sales yet</p>
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
            Your Active Listings ({myListings.length})
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
              Your Usernames ({unlisted.length})
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
                        List for Sale
                      </button>
                    </div>
                  </ProfileCard>
                ))}
              </div>
            ) : allTokens.length === 0 ? (
              <div className={`text-center py-12 ${themeBgSubtle(isDark)} rounded-xl`}>
                <p className={`text-lg ${themeTextMuted(isDark)}`}>No usernames found</p>
                <p className={`text-sm mt-1 ${themeTextMuted(isDark)}`}>
                  Mint a username to get started
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
  if (diff <= 0) return 'Expired'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  if (days > 0) return `${days}d ${hours}h left`
  const mins = Math.floor((diff % 3600000) / 60000)
  if (hours > 0) return `${hours}h ${mins}m left`
  return `${mins}m left`
}

const MyOffersTab: React.FC = () => {
  const { isDark } = useTheme()
  const { address: walletAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const refreshCounter = useMarketplaceStore(s => s.refreshCounter)
  const navigate = useNavigate()

  // Use wallet address, or fall back to the address from the token store
  const tokenStoreAddress = useTokenDataStore(s => {
    const addrs = Object.keys(s.tokensByAddress)
    return addrs.length > 0 ? addrs[0] : null
  })
  const address = walletAddress || tokenStoreAddress

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
      setAcceptFailureMessage('Something went wrong getting the LZ fee quote. Please try again.')
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
      ? 'Transaction rejected'
      : 'Something went wrong accepting the offer. Please try again.'
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

      // Trigger a full refresh of token data to sync with chain/server
      if (store.refetchTokenData) setTimeout(store.refetchTokenData, 2000)
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
        <p className={`text-lg ${themeTextMuted(isDark)}`}>Sign in to see your offers</p>
      </div>
    )
  }

  return (
    <>
      {/* Cancel error */}
      {cancelError && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
          {cancelError.message?.includes('User rejected')
            ? 'Transaction rejected'
            : 'Transaction failed. Please try again.'}
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
            Offers Sent ({sentOffers.length})
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
                      {isThisOffer && isCancelPending ? 'Confirm in wallet...'
                        : isThisOffer && isCancelConfirming ? 'Withdrawing...'
                        : 'Cancel & Withdraw'}
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className={`text-center py-8 ${themeBgSubtle(isDark)} rounded-xl ${isDark ? '' : 'shadow-inner'}`}>
              <p className={`text-sm ${themeTextMuted(isDark)}`}>No offers sent</p>
              <p className={`text-xs mt-1 ${themeTextMuted(isDark)}`}>
                Make an offer on any profile to buy it
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
            Offers Received ({receivedOffers.length})
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
                        from{' '}
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
                            {isThisAccepting && isApproving ? 'Approving...'
                              : isThisAccepting && (isAcceptPending || isAcceptConfirming) ? 'Accepting...'
                              : 'Accept'}
                          </button>
                          <button
                            onClick={() => handleDenyReceived(offer)}
                            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
                              isDark
                                ? 'bg-white/10 text-white hover:bg-white/20'
                                : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                            }`}
                          >
                            Deny
                          </button>
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className={`text-center py-8 ${themeBgSubtle(isDark)} rounded-xl ${isDark ? '' : 'shadow-inner'}`}>
              <p className={`text-sm ${themeTextMuted(isDark)}`}>No offers received</p>
            </div>
          )}
        </div>
      )}
    </>
  )
}

export default Marketplace
