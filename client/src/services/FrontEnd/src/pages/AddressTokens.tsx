import React, { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useReadContract, useReadContracts } from 'wagmi'
import { useQuery, useQueries } from '@tanstack/react-query'
import { erc20Abi, formatEther, formatUnits } from 'viem'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeTextMuted, themeBgSubtle, themeBorder } from '~/utils/theme'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi } from '~/../../../abi/generated'
import { apiFetch } from '~/api/client'
import CopyAddressButton from '~/components/CopyAddressButton'
import UserCard, { UserCardUser } from '~/components/UserCard'
import UsernameSvg from '~/components/UsernameSvg'
import LiveCountdown from '~/components/marketplace/LiveCountdown'
import { LoadingSpinner } from '~/components/Skeleton'
import { useTokenDataStore, usePriceStore } from '~/store/tokenDataStore'
import { MarketplaceOffer } from '~/store/marketplaceStore'
import { convertToNumber, formatNumberCompact } from '~/utils'

const ADDRESS_RX = /^0x[a-f0-9]{40}$/

// Mirrors ViewOffersModal.tsx:20-28 — keep formatting consistent.
const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6 }
function fmtPrice(raw: string, token: string): string {
  const dec = DECIMALS[token] ?? 18
  const num = parseFloat(dec === 18 ? formatEther(BigInt(raw)) : formatUnits(BigInt(raw), dec))
  if (token === 'CAW') return num.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (token === 'USDC' || token === 'USDT') return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

interface ApiUserByToken {
  tokenId: number
  username: string | null
  displayName?: string | null
  avatarUrl?: string | null
  defaultAvatarId?: number | null
  image?: string | null
  followerCount?: number
  likeCount?: number
}

const AddressTokens: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { address: rawAddress } = useParams<{ address: string }>()
  const address = (rawAddress || '').toLowerCase()
  const valid = ADDRESS_RX.test(address)
  const addrTyped = address as `0x${string}`

  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  // 1) Count of NFTs owned by this address on the configured L1
  const { data: balanceRaw, isLoading: balanceLoading } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
    functionName: 'balanceOf',
    args: [addrTyped],
    chainId: chains.l1.chainId,
    query: { enabled: valid },
  })
  const tokenCount = balanceRaw !== undefined ? Number(balanceRaw) : 0

  // 2) Fetch all tokenIds in one batched RPC. wagmi's batch.wait coalesces these.
  const indexCalls = useMemo(
    () =>
      Array.from({ length: tokenCount }, (_, i) => ({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
        functionName: 'tokenOfOwnerByIndex' as const,
        args: [addrTyped, BigInt(i)] as const,
        chainId: chains.l1.chainId,
      })),
    [tokenCount, addrTyped]
  )
  const { data: indexResults, isLoading: indicesLoading } = useReadContracts({
    contracts: indexCalls,
    query: { enabled: valid && tokenCount > 0 },
  })
  const tokenIds: number[] = useMemo(() => {
    if (!indexResults) return []
    return indexResults
      .map(r => (r.status === 'success' && r.result !== undefined ? Number(r.result) : null))
      .filter((id): id is number => id !== null)
  }, [indexResults])

  // 3) L1 CAW balance for this address (ERC-20)
  const { data: l1CawBalance } = useReadContract({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [addrTyped],
    chainId: chains.l1.chainId,
    query: { enabled: valid },
  })

  // 4) Resolve each tokenId → user via the API (which already does its own L1 fallback)
  const userQueries = useQueries({
    queries: tokenIds.map(tokenId => ({
      queryKey: ['user-by-token', tokenId],
      queryFn: async () => {
        try {
          return await apiFetch<ApiUserByToken>(`/api/users/by-token/${tokenId}`)
        } catch {
          return null // fall through to client-side L1 fallback below
        }
      },
      enabled: !!tokenId,
    })),
  })

  // 5) Client-side L1 fallback for any token whose API lookup failed.
  // Reads `usernames(tokenId - 1)` directly from L1 — gives us a username with no stats.
  const fallbackTokenIds = useMemo(
    () =>
      tokenIds.filter((_, i) => {
        const q = userQueries[i]
        return q?.isSuccess && q.data === null
      }),
    [tokenIds, userQueries]
  )
  const fallbackCalls = useMemo(
    () =>
      fallbackTokenIds.map(tid => ({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
        functionName: 'usernames' as const,
        args: [BigInt(tid - 1)] as const,
        chainId: chains.l1.chainId,
      })),
    [fallbackTokenIds]
  )
  const { data: fallbackResults } = useReadContracts({
    contracts: fallbackCalls,
    query: { enabled: fallbackTokenIds.length > 0 },
  })
  const fallbackByTokenId = useMemo(() => {
    const map = new Map<number, string>()
    if (!fallbackResults) return map
    fallbackResults.forEach((r, i) => {
      if (r.status === 'success' && typeof r.result === 'string' && r.result) {
        map.set(fallbackTokenIds[i], r.result)
      }
    })
    return map
  }, [fallbackResults, fallbackTokenIds])

  // 6) Build the list of user objects for <UserCard>. Tokens still loading are skipped;
  // tokens that failed both the API and the L1 fallback are skipped too.
  const resolvedUsers: UserCardUser[] = useMemo(() => {
    const out: UserCardUser[] = []
    tokenIds.forEach((tokenId, i) => {
      const q = userQueries[i]
      if (q?.isSuccess && q.data) {
        const u = q.data
        if (!u.username) return
        out.push({
          tokenId: u.tokenId ?? tokenId,
          username: u.username,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl,
          defaultAvatarId: u.defaultAvatarId,
          image: u.image,
          followerCount: u.followerCount ?? 0,
          likeCount: u.likeCount ?? 0,
        })
        return
      }
      // API miss — try L1 fallback
      const fallbackUsername = fallbackByTokenId.get(tokenId)
      if (fallbackUsername) {
        out.push({
          tokenId,
          username: fallbackUsername,
          displayName: null,
          followerCount: 0,
          likeCount: 0,
        })
      }
    })
    return out
  }, [tokenIds, userQueries, fallbackByTokenId])

  // 7) Total CAW staked across the resolved tokens — same pattern as ProfileCard.tsx:24-27
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const totalStaked = useMemo(() => {
    const usernameSet = new Set(resolvedUsers.map(u => u.username))
    let sum = 0
    for (const tokens of Object.values(tokensByAddress)) {
      for (const t of tokens) {
        if (usernameSet.has(t.username)) sum += convertToNumber(t.stakedAmount, 18)
      }
    }
    return sum
  }, [resolvedUsers, tokensByAddress])

  // 8) Active offers made by this address
  const { data: offersResp } = useQuery<{ offers: MarketplaceOffer[]; total: number }>({
    queryKey: ['offers-by-address', address],
    queryFn: () => apiFetch(`/api/marketplace/offers/address/${address}?limit=20`),
    enabled: valid,
  })
  const offers = offersResp?.offers || []

  // ----- render -----

  if (!valid) {
    return (
      <MainLayout>
        <div className="max-w-2xl mx-auto px-6 py-16 text-center">
          <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
            {t('address_tokens.invalid_title')}
          </h2>
          <p className={themeTextMuted(isDark)}>
            {t('address_tokens.invalid_body')}
          </p>
        </div>
      </MainLayout>
    )
  }

  const cawL1Number = l1CawBalance !== undefined ? convertToNumber(l1CawBalance as bigint, 18) : 0
  const cawUsd = cawL1Number * cawPrice
  void ethPrice // referenced to keep imports stable; not currently surfaced on this page

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className={`rounded-xl border ${themeBorder(isDark)} ${themeBgSubtle(isDark)} p-4 mb-4`}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h1 className={`text-base font-mono font-bold break-all flex items-center gap-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
              <span>{address}</span>
              <CopyAddressButton address={address} iconOnly />
            </h1>
            <a
              href={`https://etherscan.io/address/${address}`}
              target="_blank"
              rel="noreferrer"
              className={`text-xs ${themeTextMuted(isDark)} hover:underline`}
            >
              {t('address_tokens.view_etherscan')}
            </a>
          </div>

          <div className={`grid grid-cols-3 gap-3 mt-4 pt-4 border-t ${themeBorder(isDark)}`}>
            <div className="text-center">
              <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {balanceLoading ? '—' : tokenCount}
              </div>
              <div className={`text-xs ${themeTextMuted(isDark)}`}>{t('address_tokens.profiles_owned')}</div>
            </div>
            <div className="text-center">
              <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {formatNumberCompact(totalStaked, 0, 1)}
              </div>
              <div className={`text-xs ${themeTextMuted(isDark)}`}>{t('address_tokens.caw_staked')}</div>
            </div>
            <div className="text-center">
              <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {formatNumberCompact(cawL1Number, 0, 1)}
              </div>
              <div className={`text-xs ${themeTextMuted(isDark)}`}>
                {t('address_tokens.caw_l1')}{cawUsd >= 0.01 ? ` · $${cawUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}
              </div>
            </div>
          </div>
        </div>

        {/* Profiles owned */}
        <h2 className={`text-lg font-semibold mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('address_tokens.profiles_owned')}
        </h2>
        {balanceLoading || indicesLoading ? (
          <LoadingSpinner className="py-8" />
        ) : tokenCount === 0 ? (
          <div className={`rounded-xl border ${themeBorder(isDark)} ${themeBgSubtle(isDark)} p-8 text-center ${themeTextMuted(isDark)}`}>
            {t('address_tokens.no_usernames')}
          </div>
        ) : resolvedUsers.length === 0 ? (
          <LoadingSpinner className="py-8" />
        ) : (
          <div className="flex flex-wrap justify-center gap-3">
            {resolvedUsers.map(u => (
              <div key={u.tokenId} className="w-full sm:w-[calc(50%-0.375rem)] md:w-[calc(33.333%-0.5rem)]">
                <UserCard user={u} />
              </div>
            ))}
          </div>
        )}

        {/* Offers made */}
        <h2 className={`text-lg font-semibold mt-8 mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('address_tokens.active_offers')}
        </h2>
        {offers.length === 0 ? (
          <div className={`rounded-xl border ${themeBorder(isDark)} ${themeBgSubtle(isDark)} p-6 text-center ${themeTextMuted(isDark)}`}>
            {t('address_tokens.no_offers')}
          </div>
        ) : (
          <div className="grid grid-cols-1 min-[520px]:grid-cols-2 gap-4">
            {offers.map(offer => {
              const dec = DECIMALS[offer.paymentToken] ?? 18
              const num = parseFloat(dec === 18 ? formatEther(BigInt(offer.amount)) : formatUnits(BigInt(offer.amount), dec))
              let rate = 0
              if (offer.paymentToken === 'USDC' || offer.paymentToken === 'USDT') rate = 1
              else if (offer.paymentToken === 'ETH' || offer.paymentToken === 'WETH') rate = ethPrice
              else if (offer.paymentToken === 'CAW') rate = cawPrice
              const usd = rate > 0 ? num * rate : 0
              const usdStr = usd > 0
                ? usd < 0.01 ? '<$0.01' : `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : null
              return (
                <div
                  key={offer.offerId}
                  className={`p-4 rounded-xl border transition-all duration-200 ${
                    isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white'
                  }`}
                >
                  <Link
                    to={`/users/${offer.username}`}
                    className="block cursor-pointer hover:opacity-80 transition-opacity"
                  >
                    <div className="w-full max-w-[160px] mx-auto mb-3">
                      <UsernameSvg username={offer.username} />
                    </div>
                  </Link>
                  <div className="text-center">
                    {usdStr && (
                      <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {usdStr}
                      </div>
                    )}
                    <div className={`text-sm ${themeTextMuted(isDark)}`}>
                      {fmtPrice(offer.amount, offer.paymentToken)} {offer.paymentToken}
                    </div>
                    <div className="text-xs mt-1">
                      <LiveCountdown endTime={offer.expiry} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default AddressTokens
