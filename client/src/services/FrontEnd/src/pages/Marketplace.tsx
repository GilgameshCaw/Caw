import React, { useState, useEffect, useCallback, useMemo } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { themeText, themeTextMuted, themeTextSecondary, themeBorder, themeBgSubtle } from '~/utils/theme'
import { useMarketplaceListings, useMarketplaceSales } from '~/hooks/useMarketplace'
import { apiFetch } from '~/api/client'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useMarketplaceStore, MarketplaceListing } from '~/store/marketplaceStore'
import ListingCard from '~/components/marketplace/ListingCard'
import ListingFilters from '~/components/marketplace/ListingFilters'
import SaleCard from '~/components/marketplace/SaleCard'
import { useNavigate } from 'react-router-dom'
import ProfileCard from '~/components/marketplace/ProfileCard'

type Tab = 'listings' | 'sales' | 'mine'

function formatBurned(raw: string): string {
  const n = Number(raw)
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toLocaleString()
}

const Marketplace: React.FC = () => {
  const { isDark } = useTheme()
  const [activeTab, setActiveTab] = useState<Tab>('listings')
  const [stats, setStats] = useState<{ totalUsers: number; activeListings: number; totalCawBurned: string } | null>(null)
  const navigate = useNavigate()

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
            Your username is an NFT — mint one, or buy and sell on the feeless marketplace.
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
          </div>

          {activeTab === 'listings' && <ListingsTab />}
          {activeTab === 'sales' && <SalesTab />}
          {activeTab === 'mine' && <MyProfilesTab />}
        </div>
      </div>
    </MainLayout>
  )
}

const StatCard: React.FC<{ label: string; value: string; isDark: boolean }> = ({ label, value, isDark }) => (
  <div className={`px-1 py-6 rounded-lg border transition-all duration-300 flex flex-col items-center justify-between ${
    isDark ? 'border-white/20 bg-black' : 'border-gray-300 bg-white'
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
        <div className={`text-center py-16 ${themeBgSubtle(isDark)} rounded-xl`}>
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
        <div className={`text-center py-16 ${themeBgSubtle(isDark)} rounded-xl`}>
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

export default Marketplace
