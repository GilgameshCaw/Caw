// src/components/ProfileChooser.tsx
import React, { useState, useEffect, useRef } from "react";
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import { formatAddress, formatUnitsCompact, convertToText } from "~/utils";
import UsernameSvg from "./UsernameSvg";
import { Link } from '~/utils/localizedRouter'
import { TokenData } from "~/types";
import { useAccount, useDisconnect } from "wagmi";
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { HiOutlineSwitchHorizontal } from 'react-icons/hi';
import { Address } from "viem";
import { useTheme } from "~/hooks/useTheme";
import { apiFetch } from "~/api/client";
import { useHasActiveSession } from '~/hooks/useHasActiveSession';
import { usePendingSpendStore } from '~/store/pendingSpendStore';
import { useBalanceChangeStore } from '~/store/balanceChangeStore';
import { useUserByUsername, useUserByToken } from '~/hooks/useUserData';
import { getUserAvatar, getDefaultAvatarForUser } from '~/utils/defaultAvatar';
import Avatar from '~/components/Avatar';
import { useQuickSignPromptStore } from '~/components/modals/QuickSignModal';
import { useFollowerCounts } from '~/hooks/useFollowerCounts';
import { usePinnedProfilesStore } from '~/store/pinnedProfilesStore';
import { ThumbtackIcon } from '~/components/icons/ThumbtackIcon';
import { HiOutlinePlus, HiUsers } from 'react-icons/hi'
import { useT } from '~/i18n/I18nProvider';

const ProfileChooser: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const t = useT()
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();

  // Disconnect the current wallet and immediately surface RainbowKit's
  // connect modal so the user can pick a different one. We also wipe
  // wagmi's `recentConnectorId` from localStorage as belt-and-suspenders
  // against auto-reconnect to the just-disconnected wallet on the next
  // page load (wagmi reads this key during hydration).
  const handleSwitchWallet = () => {
    try { localStorage.removeItem('wagmi.recentConnectorId') } catch { /* ignore */ }
    try { disconnect() } catch { /* ignore */ }
    setDropdownOpen(false)
    // Defer so wagmi has a tick to flush its disconnect state before
    // RainbowKit decides which connectors to render.
    setTimeout(() => { openConnectModal?.() }, 0)
  }
  const hasActiveSession = useHasActiveSession();
  const activeToken = useActiveToken()
  const pendingSpend = usePendingSpendStore(s => s.pendingSpend)
  // Live in-flight balance change windows — incoming-only deltas roll
  // into the existing "pending" line below so a like / recaw / follow
  // landing on the user's content nudges the +X CAW pending counter.
  // Same store the BalanceChangeToast reads from.
  const balanceWindows = useBalanceChangeStore(s => s.windows)
  const sweepBalance = useBalanceChangeStore(s => s.sweep)
  useEffect(() => {
    // Periodically drop expired windows so the displayed net rolls down.
    // The toast component does its own sweep, but ProfileChooser is
    // visible without it (sidebar always-on), so it needs its own tick.
    const id = setInterval(() => { sweepBalance() }, 500)
    return () => clearInterval(id)
  }, [sweepBalance])
  const lastAddress = useTokenDataStore(state => state.lastAddress);
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress);
  const removeAddress = useTokenDataStore(s => s.removeAddress);
  const { isDark } = useTheme()
  const avatars = useTokenDataStore(s => s.avatarsByTokenId)
  const setAvatar = useTokenDataStore(s => s.setAvatar)

  // Fetch avatar for the active token via shared query
  const { data: activeUserData } = useUserByUsername(activeToken?.username)
  useEffect(() => {
    if (activeToken && activeUserData) {
      setAvatar(activeToken.tokenId, getUserAvatar(activeUserData) || null)
    }
  }, [activeToken?.tokenId, activeUserData?.avatarUrl, activeUserData?.defaultAvatarId])

  // Pending L1→L2 deposit in flight — show "+X CAW pending" alongside staked.
  // We keep a per-token localStorage hint so the badge can render instantly
  // on page load (instead of waiting for the /by-token API round-trip), and
  // we hide it the moment the on-chain stake has caught up, regardless of
  // whether the backend lazy-clear has run yet.
  const readPendingHint = (tokenId?: number): bigint | null => {
    if (!tokenId) return null
    try {
      const raw = localStorage.getItem(`caw:pendingDeposit:${tokenId}`)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { amount: string; at: number; txHash?: string }
      // 30-min hard expiry matches the actions.ts hint-forwarding window and
      // the validator's 25-min waiting_for_deposit safety net.
      const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000
      if (parsed.at < thirtyMinutesAgo) return null
      return BigInt(parsed.amount)
    } catch { return null }
  }
  const clearPendingHint = (tokenId?: number) => {
    if (!tokenId) return
    try { localStorage.removeItem(`caw:pendingDeposit:${tokenId}`) } catch {}
  }

  const [pendingDepositWei, setPendingDepositWei] = useState<bigint | null>(() =>
    readPendingHint(activeToken?.tokenId)
  )

  useEffect(() => {
    // Re-prime from localStorage whenever the active token changes.
    setPendingDepositWei(readPendingHint(activeToken?.tokenId))
  }, [activeToken?.tokenId])

  // Listen for pending-deposit writes from other components (New.tsx,
  // Staking.tsx, PostMintOnboarding.tsx) so the badge updates immediately
  // instead of waiting for the 15s backend poll. The writers dispatch a
  // 'caw:pendingDepositChanged' CustomEvent on the window after setting the
  // localStorage entry.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tokenId?: number } | undefined
      // Update if the event is for the currently-active token (or has no
      // tokenId, meaning "re-read whatever we have").
      if (!detail?.tokenId || detail.tokenId === activeToken?.tokenId) {
        setPendingDepositWei(readPendingHint(activeToken?.tokenId))
      }
    }
    window.addEventListener('caw:pendingDepositChanged', handler)
    return () => window.removeEventListener('caw:pendingDepositChanged', handler)
  }, [activeToken?.tokenId])

  // IMPORTANT: The localStorage hint is WRITE-ONCE by New.tsx (at mint/deposit
  // success) and READ-ONLY everywhere else, including here. It carries the L1
  // tx hash that actions.ts forwards as pendingDepositTxHash to the server.
  // Overwriting it here destroys the hash and breaks the validator's hold
  // mechanism. We only ever clear it (never overwrite) and only when we're
  // certain the deposit has fully landed AND there are no in-flight waiting
  // actions that still need the hash. The simplest safe rule: clear it if the
  // hint is past its 30-minute hard expiry. Cleanup of the "live" case is
  // handled in Session 2 via a dedicated endpoint that reports when all of
  // the sender's waiting_for_deposit rows have settled.
  useEffect(() => {
    if (!activeToken?.tokenId) return
    try {
      const raw = localStorage.getItem(`caw:pendingDeposit:${activeToken.tokenId}`)
      if (!raw) return
      const parsed = JSON.parse(raw) as { amount: string; at: number; txHash?: string }
      if (Date.now() - parsed.at > 30 * 60 * 1000) {
        clearPendingHint(activeToken.tokenId)
        setPendingDepositWei(null)
      }
    } catch { /* ignore */ }
  }, [activeToken?.tokenId])

  // Backend display poll. The localStorage hint (written on L1 tx success) is
  // the primary source for the "+X CAW pending" badge; the backend value is
  // a fallback for cross-device or post-expiry cases.
  //
  // Hint-clearing rule: a hint carries a `stakedAtHintTime` baseline captured
  // when the deposit was initiated. The deposit has landed once the current
  // on-chain stake has grown past that baseline by approximately the pending
  // amount. We use a 5% tolerance to absorb contract-side precision loss in
  // the L2 cawBalanceOf scaling math. When landed, flush the hint and badge.
  //
  // Gate refetchInterval on having a live hint. Without a hint, there's no
  // landed-deposit event to wait for — we just want fresh user data on
  // navigation, which the default staleTime (5min) handles. The 15s poll
  // used to fire constantly for every logged-in user, racking up ~4 API
  // calls/min from ProfileChooser alone (always-mounted in MainLayout).
  // Diagnostics showed this single query at 14 fires / 5 min vs. <2 for
  // everything else.
  const { data: byTokenData } = useUserByToken(
    activeToken?.tokenId,
    pendingDepositWei !== null ? 15_000 : undefined,
  )
  useEffect(() => {
    if (!activeToken?.tokenId) return
    const data = byTokenData
    if (!data) return
    const check = () => {

        // Parse the raw hint (not via readPendingHint — we need stakedAtHintTime)
        let hintWei: bigint | null = null
        let hintBaseline: bigint = 0n
        let hintAgeMs = 0
        try {
          const raw = localStorage.getItem(`caw:pendingDeposit:${activeToken.tokenId}`)
          if (raw) {
            const parsed = JSON.parse(raw) as { amount: string; at: number; stakedAtHintTime?: string }
            hintAgeMs = Date.now() - (parsed?.at ?? 0)
            if (parsed?.amount && hintAgeMs < 30 * 60 * 1000) {
              try { hintWei = BigInt(parsed.amount) } catch {}
              try { hintBaseline = BigInt(parsed.stakedAtHintTime ?? '0') } catch {}
            }
          }
        } catch { /* ignore */ }

        // Detect "deposit has landed" by measuring the on-chain stake delta
        // since the hint was written. The baseline is captured from L2's
        // cawBalanceOf at hint-write time (ground truth, not wagmi cache),
        // so stakeDelta represents real new-money arrival. No time-based
        // minimum — the rule fires as soon as the deposit lands, whether
        // that's 8 seconds or 3 minutes from now.
        //
        // 5% tolerance absorbs contract-side precision loss in the L2
        // cawBalanceOf scaling math (cawOwnership * rewardMultiplier / precision).
        const staked = activeToken?.stakedAmount ?? 0n
        if (hintWei !== null && hintWei > 0n) {
          const stakeDelta = staked > hintBaseline ? staked - hintBaseline : 0n
          const requiredDelta = (hintWei * 95n) / 100n
          if (stakeDelta >= requiredDelta && requiredDelta > 0n) {
            clearPendingHint(activeToken.tokenId)
            setPendingDepositWei(null)
            try { useTokenDataStore.getState().refetchTokenData?.() } catch {}
            // Fire a +N CAW balance-change toast for the landed deposit.
            // Source key is the hint's stored timestamp so the same hint
            // can't double-fire across remounts.
            try {
              const isMobile = typeof window !== 'undefined'
                && window.matchMedia('(max-width: 767px)').matches
              useBalanceChangeStore.getState().addWindow(
                hintWei,
                isMobile ? 5_000 : 10_000,
                `deposit:${activeToken.tokenId}:${hintWei.toString()}`,
              )
            } catch { /* non-critical */ }
            return
          }
        }
        void hintAgeMs

        // Also proactively refetch while a hint is still live — keeps
        // activeToken.stakedAmount fresh enough that the landing check
        // fires within one poll cycle of the deposit actually landing.
        if (hintWei !== null && hintWei > 0n) {
          try { useTokenDataStore.getState().refetchTokenData?.() } catch {}
        }

        if (data?.pendingDepositAmount) {
          try {
            const backendWei = BigInt(data.pendingDepositAmount)
            const show = hintWei !== null && hintWei > backendWei ? hintWei : backendWei
            setPendingDepositWei(show)
          } catch { /* ignore */ }
        } else if (hintWei !== null) {
          setPendingDepositWei(hintWei)
        } else {
          setPendingDepositWei(null)
        }
    }
    check()
  }, [activeToken?.tokenId, byTokenData])

  const setLastAddress = useTokenDataStore(s => s.setLastAddress)
  const setActiveTokenId = useTokenDataStore(state => state.setActiveTokenId);;
  const [isDropdownOpen, setDropdownOpen] = useState(false);
  // Per-wallet expansion state for "+N more profiles..." rows. Keyed by
  // owner address (lowercase). When expanded, the wallet group renders
  // its full sorted list inside a scrollable container instead of the
  // capped slice. Resets when the dropdown closes (see toggleDropdown).
  const [expandedAddresses, setExpandedAddresses] = useState<Set<string>>(new Set())
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedToken = activeToken;

  const hasHydrated = useTokenDataStore(s => s.hasHydrated);

  // Reset "+N more profiles..." expansion whenever the dropdown closes,
  // so reopening starts in the compact state. This catches every close
  // path (toggle, click-outside, profile-select) without sprinkling
  // setExpandedAddresses calls into each one.
  useEffect(() => {
    if (!isDropdownOpen) setExpandedAddresses(new Set())
  }, [isDropdownOpen])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isDropdownOpen]);

  if (hasHydrated && !selectedToken) {
    // Check if there are ANY profiles in the browser
    const hasAnyProfiles = Object.values(tokensByAddress).some(tokens => tokens.length > 0);

    // If no wallet connected and no profiles exist, show "Sign In"
    if (!isConnected && !hasActiveSession && !hasAnyProfiles) {
      return (
        <div className="mb-2 flex justify-center">
          <button onClick={() => openConnectModal?.()} type="button" className="btn btn-connect cursor-pointer">
            {t('common.sign_in')}
          </button>
        </div>
      );
    }

    // Otherwise show "create your profile"
    return (
      <div className="mb-2">
        <a href="/usernames/new" className={`inline-flex items-center gap-2 px-4 py-3 rounded-2xl transition-all duration-200 font-medium text-sm hover:scale-105 ${
          isDark
            ? 'bg-white/10 text-white border border-white/20 hover:bg-white/20 hover:border-white/30'
            : 'bg-gray-200 text-black border border-gray-300 hover:bg-gray-300 hover:border-gray-400'
        }`}>
          <span className="text-lg">+</span>
          {t('profile_chooser.create_profile')}
        </a>
      </div>
    );
  }

  // --- handlers ---
  const toggleDropdown = () => {
    const willOpen = !isDropdownOpen
    setDropdownOpen(willOpen)
    // Fetch avatars for all tokens when opening dropdown
    if (willOpen) {
      const allTokens = Object.values(tokensByAddress).flat()
      for (const token of allTokens) {
        apiFetch(`/api/users/${token.username}`)
          .then(data => setAvatar(token.tokenId, getUserAvatar(data) || null))
          .catch(() => {})
      }
    }
  };

  const handleRemoveAddress = (addressToRemove: Address) => {
    const store = useTokenDataStore.getState()
    const normalized = addressToRemove.toLowerCase()

    removeAddress(addressToRemove);

    // If we removed the active address, switch to another one
    if (store.lastAddress?.toLowerCase() === normalized) {
      const remaining = Object.keys(store.tokensByAddress).filter(a => a.toLowerCase() !== normalized)
      if (remaining.length > 0) {
        const newAddr = remaining[0]
        setLastAddress(newAddr.toLowerCase())
        const tokens = store.tokensByAddress[newAddr as Address]
        if (tokens?.length > 0) {
          setActiveTokenId(tokens[0].tokenId)
        }
      }
    }
  };

  const handleSelectProfile = (token: TokenData) => {
    setActiveTokenId(token.tokenId)
    // Update lastAddress so useTokenDataUpdate refetches data for this token's owner
    if (token.address) {
      setLastAddress(token.address.toLowerCase())
    }
    setDropdownOpen(false);
    // useEffect will fetch avatar when activeToken.tokenId changes
  };

  const walletMismatch = address?.toLowerCase() != activeToken?.owner?.toLowerCase();
  const notCurrentAddress = !hasActiveSession && walletMismatch;
  const quickSignWithWrongWallet = hasActiveSession && walletMismatch && isConnected;

  // Normalize all addresses to lowercase to prevent duplicates with different cases
  const normalizedTokensByAddress: Record<Address, TokenData[]> = {}
  for (const [addr, tokens] of Object.entries(tokensByAddress)) {
    const normalizedAddr = addr.toLowerCase() as Address
    if (!normalizedTokensByAddress[normalizedAddr]) {
      normalizedTokensByAddress[normalizedAddr] = []
    }
    // Add tokens if not already present (by tokenId)
    for (const token of tokens) {
      if (!normalizedTokensByAddress[normalizedAddr].some(t => t.tokenId === token.tokenId)) {
        normalizedTokensByAddress[normalizedAddr].push(token)
      }
    }
  }

  const visibleTokensByAddress = { ...normalizedTokensByAddress }
  const normalizedAddress = address?.toLowerCase() as Address | undefined
  if (normalizedAddress && (!visibleTokensByAddress[normalizedAddress] || visibleTokensByAddress[normalizedAddress].length == 0))
      visibleTokensByAddress[normalizedAddress] = [];

  // Dropdown UX: cap to 3 wallets and 3 profiles per wallet, sorted by
  // follower count desc within each wallet. Active token's wallet is ALWAYS
  // included (placed last so it sits closest to the user's eye), and the
  // active token itself is always included even if its follower count would
  // otherwise push it outside the top-3 within its wallet.
  const MAX_PROFILES_PER_WALLET = 3
  const MAX_WALLETS = 3
  const allTokenIds: number[] = []
  for (const list of Object.values(visibleTokensByAddress)) {
    for (const t of (list || [])) allTokenIds.push(t.tokenId)
  }
  const followerCounts = useFollowerCounts(allTokenIds)
  const pinnedAt = usePinnedProfilesStore(s => s.pinnedAt)

  const activeOwnerKey = activeToken?.address?.toLowerCase()
  const limitedTokensByAddress: Record<string, TokenData[]> = {}

  // Step 1: pick which wallets to show (up to MAX_WALLETS), with the active
  // token's wallet guaranteed and placed last.
  const allWalletKeys = Object.keys(visibleTokensByAddress)
  const otherWalletKeys = allWalletKeys.filter(k => k !== activeOwnerKey)
  const slotsForOthers = activeOwnerKey && allWalletKeys.includes(activeOwnerKey)
    ? MAX_WALLETS - 1
    : MAX_WALLETS
  const orderedWalletKeys = [
    ...otherWalletKeys.slice(0, slotsForOthers),
    ...(activeOwnerKey && allWalletKeys.includes(activeOwnerKey) ? [activeOwnerKey] : []),
  ]

  // Step 2: within each chosen wallet, sort by pinned-first (most-recently
  // pinned wins) then follower count desc, and cap to MAX_PROFILES_PER_WALLET.
  // If the active token is in this wallet but outside the cap, swap it into
  // the visible slice. Track per-wallet hidden count for the "+N more
  // profiles..." toggle shown below each truncated wallet group.
  //
  // We also keep `fullSortedTokensByAddress` so the expanded-state render
  // can show the OUT-OF-SLICE tokens without re-sorting. Computing the
  // hidden tokens as `full \ slice` (rather than `full.slice(slice.length)`)
  // keeps things correct when the active-token swap pulls a profile from
  // outside the original slice into the visible group.
  const hiddenCountByAddress: Record<string, number> = {}
  const hiddenTokensByAddress: Record<string, TokenData[]> = {}
  for (const addrKey of orderedWalletKeys) {
    const full = (visibleTokensByAddress[addrKey as Address] || []).slice()
    full.sort((a, b) => {
      const ap = pinnedAt[a.tokenId]
      const bp = pinnedAt[b.tokenId]
      if (ap && bp) return bp.localeCompare(ap)        // both pinned: newer first
      if (ap) return -1                                 // a pinned, b not
      if (bp) return 1                                  // b pinned, a not
      return (followerCounts[b.tokenId] ?? 0) - (followerCounts[a.tokenId] ?? 0)
    })
    let slice = full.slice(0, MAX_PROFILES_PER_WALLET)
    if (
      activeToken?.tokenId &&
      addrKey === activeOwnerKey &&
      !slice.some(t => t.tokenId === activeToken.tokenId)
    ) {
      const activeRow = full.find(t => t.tokenId === activeToken.tokenId)
      if (activeRow) {
        // Replace the lowest-follower entry in slice with the active token.
        slice = [...slice.slice(0, MAX_PROFILES_PER_WALLET - 1), activeRow]
      }
    }
    limitedTokensByAddress[addrKey] = slice
    hiddenCountByAddress[addrKey] = Math.max(0, full.length - slice.length)
    const visibleIds = new Set(slice.map(t => t.tokenId))
    hiddenTokensByAddress[addrKey] = full.filter(t => !visibleIds.has(t.tokenId))
  }

  // --- main render when tokens exist ---
  return (
    <div ref={dropdownRef} className="relative flex flex-col text-left left-[0%]">
      <button
        onClick={toggleDropdown}
        className={`flex items-center cursor-pointer w-full min-w-0 ${compact ? 'px-1 py-0.5' : 'p-1'}`}
      >
        <div className={`rounded-full overflow-hidden border border-gray-700 flex-shrink-0 aspect-square ${compact ? 'w-11 h-11 mr-3' : 'w-[50px] h-[50px] m-3'}`}>
          <Avatar
            src={avatars[selectedToken.tokenId] || getUserAvatar({ tokenId: selectedToken.tokenId })}
            fallbackSrc={getDefaultAvatarForUser({ tokenId: selectedToken.tokenId })}
            size="small"
          />
        </div>
        <div className="text-left flex-1 min-w-0">
          <div className={compact ? 'h-1' : 'm-5'}>
          </div>

          <div className="relative overflow-hidden">
            <div
              className={`font-bold transition-all duration-300 whitespace-nowrap ${
                isDark ? 'text-white' : 'text-black'
              } ${
                selectedToken.username.length > 16 ? 'text-xs'
                : selectedToken.username.length > 12 ? 'text-sm'
                : selectedToken.username.length > 9 ? (compact ? 'text-sm' : 'text-base')
                : compact ? 'text-base' : 'text-lg'
              }`}
            >
              {selectedToken.username}
            </div>
            {/* Fade-to-background gradient on the right to indicate overflow */}
            <div
              className={`pointer-events-none absolute inset-y-0 right-0 w-6 ${
                isDark
                  ? 'bg-gradient-to-l from-black to-transparent'
                  : 'bg-gradient-to-l from-white to-transparent'
              }`}
            />
          </div>
          <div className={`${compact ? 'text-xs' : 'text-sm'} transition-all duration-300 ${
            isDark ? 'text-gray-300' : 'text-gray-700'
          }`}>
            {selectedToken.stakedAmount > 0n ? formatUnitsCompact((selectedToken.stakedAmount / 10n**18n) * 10n**18n, 18) : "No"} CAW
          </div>
          {(() => {
            // Live in-flight CAW meter. Shows the net delta between funds the
            // user expects to land soon and funds they've committed to actions
            // that haven't confirmed yet:
            //   delta = pendingDepositWei + recentIncoming - pendingSpend
            //
            // recentIncoming pulls only the positive (incoming) windows from
            // balanceChangeStore — likes / recaws / follows / tips landing on
            // the user's content. Outgoing spend is already captured by
            // pendingSpend; including negative windows here would double-count.
            //
            // Examples:
            //   deposited 38k, no actions → "+38k pending"
            //   deposited 38k, followed once (31k) → "+7k pending"
            //   no pending deposit, liked 3 posts (9k) → "-9k pending"
            //   no pending, someone liked your caw (+1600) → "+1k6 pending"
            // Hidden only when the delta is exactly zero.
            const pendingDep = pendingDepositWei ?? 0n
            const recentIncoming = balanceWindows.reduce(
              (acc, w) => w.delta > 0n ? acc + w.delta : acc,
              0n,
            )
            const delta = pendingDep + recentIncoming - pendingSpend
            if (delta === 0n) return null
            const isPositive = delta > 0n
            const absValue = isPositive ? delta : -delta
            return (
              <div className={`text-2xs ${isPositive ? 'text-yellow-500' : 'text-gray-400'}`}>
                {isPositive ? '+' : '-'}{formatUnitsCompact(absValue, 18)} CAW pending
              </div>
            )
          })()}
          {notCurrentAddress && (
            <div className="text-2xs text-error-dim">
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  useQuickSignPromptStore.getState().show()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    useQuickSignPromptStore.getState().show()
                  }
                }}
                className="underline hover:opacity-80 cursor-pointer"
              >
                {isConnected ? "(Wrong Address)" : "not connected"}
              </span>
            </div>
          )}
          {quickSignWithWrongWallet && (
            <div className="text-2xs text-yellow-500">
              (Quick Sign)
            </div>
          )}
        </div>

      </button>

      {isDropdownOpen && (
        <ul
          className={`${compact
            ? 'absolute left-0 right-0 bottom-full mb-2 w-full max-w-full sm:w-[340px] sm:max-w-[340px] sm:right-auto'
            : (window.innerWidth < 1350 ? 'fixed mt-2' : 'absolute mt-2')
          } rounded-md overflow-y-auto z-[9999] transition-all duration-300 ${
            // The compact branch opens UPWARD via bottom-full from the
            // sidebar avatar button. The avatar sits ~195px above the
            // viewport bottom (theme toggle + safe-area + sidebar
            // padding), so cap the dropdown at viewport - 195px so
            // expanded "+N more" sections never overflow off-screen.
            // Non-compact opens downward and just uses 95vh as before.
            compact ? 'max-h-[calc(100vh-195px)]' : 'max-h-[95vh]'
          } ${
            compact ? '' : 'max-w-[calc(100vw-20px)] w-[min(420px,calc(100vw-20px))]'
          } ${
            isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
          }`}
          style={{
            ...(compact
              ? {}
              : {
                  right: window.innerWidth < 1350 ? '10px' : '0',
                  left: window.innerWidth < 1350 ? '10px' : 'auto',
                  bottom: window.innerWidth < 1350 ? '15px' : '0',
                }),
          }}
        >
          {Object.entries(limitedTokensByAddress).map(([ownerAddress, tokenList]) => (
            <li key={ownerAddress} className={`border-b transition-all duration-300 ${
              isDark ? 'border-gray-700' : 'border-gray-200'
            }`}>
              {/* group header */}
              <div className={`sticky top-0 z-10 px-4 py-2 text-xs font-semibold flex items-center justify-between gap-2 min-w-0 transition-all duration-300 hover-parent ${
                isDark ? 'bg-gray-900 text-white' : 'bg-gray-100 text-black'
              }`}>
                <div className="flex-1 min-w-0 truncate" title={ownerAddress}>
                  {ownerAddress}
                </div>
                {normalizedAddress == ownerAddress ? (
                  <div className="w-[15px] pl-2 text-right">
                    ←
                  </div>
                ) : (
                  <button
                    onClick={() => handleRemoveAddress(ownerAddress as Address)}
                    className="hover:bg-[#ffffff33] cursor-pointer show-hover-parent w-[14px] px-0 ml-2 text-[8px] bg-[#ffffff22] rounded-xs"
                  >
                    X
                  </button>
                ) }
              </div>
              {/* tokens for that address */}
              <ul className="">
                {tokenList.map(token => (
                  <li key={token.tokenId}>
                    <button
                      onClick={() => handleSelectProfile(token)}
                      className={`cursor-pointer flex items-center justify-between px-4 py-2 w-full text-left transition-all duration-200 ${
                        isDark
                          ? 'hover:bg-gray-800 text-white'
                          : 'hover:bg-gray-100 text-black'
                      }`}
                    >
                      <div className="flex items-center min-w-0">
                        <div className="rounded-full overflow-hidden w-8 h-8 mr-3 border border-gray-700 flex-shrink-0">
                          <Avatar
                            src={avatars[token.tokenId] || getUserAvatar({ tokenId: token.tokenId })}
                            fallbackSrc={getDefaultAvatarForUser({ tokenId: token.tokenId })}
                            alt={token.username}
                            size="small"
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="font-bold truncate">{token.username}</div>
                          <div className="text-xs text-gray-400">
                            {token.stakedAmount > 0n ? convertToText((token.stakedAmount / 10n**18n) * 10n**18n) : "No"} CAW staked
                          </div>
                        </div>
                      </div>
                      {pinnedAt[token.tokenId] && (
                        <ThumbtackIcon
                          className={`w-3.5 h-3.5 flex-shrink-0 ml-2 ${isDark ? 'text-yellow-400/80' : 'text-yellow-600/80'}`}
                        />
                      )}
                    </button>
                  </li>
                ))}
                {hiddenCountByAddress[ownerAddress] > 0 && (() => {
                  const isExpanded = expandedAddresses.has(ownerAddress)
                  const hiddenCount = hiddenCountByAddress[ownerAddress]
                  const hidden = hiddenTokensByAddress[ownerAddress] || []
                  return (
                    <>
                      <li>
                        <button
                          type="button"
                          onClick={() => setExpandedAddresses(prev => {
                            const next = new Set(prev)
                            if (next.has(ownerAddress)) next.delete(ownerAddress)
                            else next.add(ownerAddress)
                            return next
                          })}
                          className={`w-full text-left px-4 py-1.5 text-xs italic transition-colors cursor-pointer ${
                            isDark
                              ? 'text-white/40 hover:text-white/70 hover:bg-gray-800'
                              : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
                          }`}
                        >
                          {isExpanded
                            ? `Hide ${hiddenCount} ${hiddenCount === 1 ? 'profile' : 'profiles'}`
                            : `+${hiddenCount} more ${hiddenCount === 1 ? 'profile' : 'profiles'}...`}
                        </button>
                      </li>
                      {/* Expanded hidden-tokens list. max-h caps the scroll
                          area; users with hundreds of profiles can browse
                          inside the dropdown without it taking over the
                          screen. Reuses the same row markup as the visible
                          slice above. */}
                      {isExpanded && (
                        <li>
                          <ul className={`max-h-64 overflow-y-auto custom-scrollbar-alt border-t ${
                            isDark ? 'border-white/5' : 'border-gray-200'
                          }`}>
                            {hidden.map(token => (
                              <li key={token.tokenId}>
                                <button
                                  onClick={() => handleSelectProfile(token)}
                                  className={`cursor-pointer flex items-center justify-between px-4 py-2 w-full text-left transition-all duration-200 ${
                                    isDark
                                      ? 'hover:bg-gray-800 text-white'
                                      : 'hover:bg-gray-100 text-black'
                                  }`}
                                >
                                  <div className="flex items-center min-w-0">
                                    <div className="rounded-full overflow-hidden w-8 h-8 mr-3 border border-gray-700 flex-shrink-0">
                                      <Avatar
                                        src={avatars[token.tokenId] || getUserAvatar({ tokenId: token.tokenId })}
                                        fallbackSrc={getDefaultAvatarForUser({ tokenId: token.tokenId })}
                                        alt={token.username}
                                        size="small"
                                      />
                                    </div>
                                    <div className="min-w-0">
                                      <div className="font-bold truncate">{token.username}</div>
                                      <div className="text-xs text-gray-400">
                                        {token.stakedAmount > 0n ? convertToText((token.stakedAmount / 10n**18n) * 10n**18n) : "No"} CAW staked
                                      </div>
                                    </div>
                                  </div>
                                  {pinnedAt[token.tokenId] && (
                                    <ThumbtackIcon
                                      className={`w-3.5 h-3.5 flex-shrink-0 ml-2 ${isDark ? 'text-yellow-400/80' : 'text-yellow-600/80'}`}
                                    />
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </li>
                      )}
                    </>
                  )
                })()}
              </ul>
            </li>
          ))}

          {/* Switch wallet: disconnects the current wallet and opens
              RainbowKit's connect modal so the user can pick another. */}
          <li
            className={`border-t ${
              isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
            }`}
          >
            <button
              type="button"
              onClick={handleSwitchWallet}
              className={`cursor-pointer flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium transition-all duration-200 ${
                isDark
                  ? 'hover:bg-gray-800 text-white'
                  : 'hover:bg-gray-100 text-black'
              }`}
            >
              <HiOutlineSwitchHorizontal className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-white/70' : 'text-black/60'}`} />
              <span>{t('profile_chooser.switch_wallet')}</span>
            </button>
          </li>

          {/* Sticky footer: Create New (left) + Manage Profiles (right),
              equal-width 2-column grid. Both always visible. */}
          <li
            className={`sticky bottom-0 z-10 border-t grid grid-cols-2 ${
              isDark ? 'bg-black border-white/20 divide-x divide-white/10' : 'bg-white border-gray-200 divide-x divide-gray-200'
            }`}
          >
            <Link
              to="/usernames/new"
              onClick={() => setDropdownOpen(false)}
              className={`cursor-pointer flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-all duration-200 ${
                isDark
                  ? 'hover:bg-gray-800 text-white'
                  : 'hover:bg-gray-100 text-black'
              }`}
            >
              <HiOutlinePlus className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-white/70' : 'text-black/60'}`} />
              <span>{t('profile_chooser.create_new')}</span>
            </Link>
            <Link
              to="/settings/account"
              onClick={() => setDropdownOpen(false)}
              className={`cursor-pointer flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-all duration-200 ${
                isDark
                  ? 'hover:bg-gray-800 text-yellow-400 hover:text-yellow-300'
                  : 'hover:bg-gray-100 text-yellow-700 hover:text-yellow-800'
              }`}
            >
              <HiUsers className="w-4 h-4 flex-shrink-0" />
              <span>{t('profile_chooser.manage_profiles')}</span>
            </Link>
          </li>
        </ul>

      )}

    </div>
  );
};

export default ProfileChooser;
