import { BrowserRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import React, { lazy, Suspense, useEffect } from 'react'
import { useCawonceSync } from '~/hooks/useCawonce'
import { useSessionKeyWalletGuard } from '~/hooks/useSessionKey'
import { useTxQueueMonitor } from '~/hooks/useTxQueueMonitor'
import { layoutRoutes, bareRoutes } from "./routes";
import MainLayout from '~/layouts/MainLayout'
import { useInsufficientStakeStore } from '~/store/insufficientStakeStore'
import { useSessionSpendSync } from '~/hooks/useSessionSpendSync'
import { useBadgeSync } from '~/hooks/useBadgeSync'
import { useIncomingBalanceWatcher } from '~/hooks/useIncomingBalanceWatcher'
import BalanceChangeToast from '~/components/BalanceChangeToast'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'
import { useAuthStore } from '~/store/authStore'
import { apiFetch } from '~/api/client'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useActionErrorStore } from '~/store/actionErrorStore'
import { useInstanceStore } from '~/store/instanceStore'
import { CLIENT_ID } from '~/api/actions'
import ModalWrapper from '~/components/modals/ModalWrapper'
import { I18nProvider } from '~/i18n/I18nProvider'

// Auth-flow modals stay eagerly imported. They open in response to
// security-sensitive moments (sign-in challenge, mid-action verification,
// session expiry) where a Suspense fallback would be both visually jarring
// and a usability footgun — the user should see the modal land instantly,
// not a spinner. They're also small.
import OnboardingGuard from '~/components/OnboardingGuard'
import VerifyWalletModal from '~/components/modals/VerifyWalletModal'
import SignInModal from '~/components/modals/SignInModal'
import QuickSignRenewModal from '~/components/modals/QuickSignRenewModal'
import QuickSignModal from '~/components/modals/QuickSignModal'
import QuickSignUnlock from '~/components/QuickSignUnlock'
import ClientAuthModal from '~/components/modals/ClientAuthModal'
import InsufficientStakeModal from '~/components/modals/InsufficientStakeModal'

// Marketplace + transfer modals are opened from discrete user actions
// (clicks on Buy / Place bid / Make offer / Transfer / etc.). The brief
// chunk fetch on the first open is fine — they're not in a critical-path
// auth flow — and lazy-loading them strips the marketplace flow chrome out
// of the entry bundle entirely. Same applies to the in-feed CawMediaModal
// (rendered only when navigating to /caws/:id with a backgroundLocation).
const TransferNFTModal = lazy(() => import('~/components/modals/TransferNFTModal'))
const CreateListingModal = lazy(() => import('~/components/modals/CreateListingModal'))
const BuyModal = lazy(() => import('~/components/modals/BuyModal'))
const PlaceBidModal = lazy(() => import('~/components/modals/PlaceBidModal'))
const MakeOfferModal = lazy(() => import('~/components/modals/MakeOfferModal'))
const ViewOffersModal = lazy(() => import('~/components/modals/ViewOffersModal'))
const SyncTransferModal = lazy(() => import('~/components/modals/SyncTransferModal'))
const CawMediaModal = lazy(() => import('~/components/modals/CawMediaModal'))

function AppRoutes() {
  const location = useLocation() as any
  const state = (location.state as { backgroundLocation?: any } | null) ?? null
  const backgroundLocation = state?.backgroundLocation

  return (
    <>
      <Routes location={backgroundLocation || location}>
        {/* Layout-wrapped routes: MainLayout stays mounted across nav
            between these, so Sidebar / ProfileChooser / Avatar don't
            remount and the avatar no longer flashes on every page change.
            Pages that need to suppress the chrome for a transient state
            (e.g. /usernames/new mid-mint) flip useLayoutStore.

            Each route is registered twice: bare (English, /home) and
            locale-prefixed (e.g. /es/home). The locale segment is read
            by I18nProvider via parseLocaleFromPath() — no route-side
            code reads it. Routes themselves don't bind :locale: they
            match by literal path and trust the i18n side to react. */}
        <Route element={<MainLayout><Outlet /></MainLayout>}>
          {layoutRoutes.map((route) => (
            <React.Fragment key={route.path}>
              <Route path={route.path} element={route.component} />
              <Route path={`/:locale${route.path}`} element={route.component} />
            </React.Fragment>
          ))}
        </Route>

        {/* Bare routes: pre-auth captive splash, welcome, admin shells.
            These never had MainLayout pre-hoist. Same locale-prefix
            duplication as layoutRoutes above. */}
        {bareRoutes.map((route) => (
          <React.Fragment key={route.path}>
            <Route path={route.path} element={route.component} />
            <Route path={`/:locale${route.path}`} element={route.component} />
          </React.Fragment>
        ))}
      </Routes>

      {/* Modal routes (rendered on top of backgroundLocation). Both URL
          shapes mount the same media modal — the modal pulls the post
          data via `id` from the route, slug suffix is ignored. */}
      {backgroundLocation && (
        <Routes>
          <Route path="/users/:username/caw/:idSlug" element={<CawMediaModal />} />
          <Route path="/:locale/users/:username/caw/:idSlug" element={<CawMediaModal />} />
          <Route path="/caws/:id" element={<CawMediaModal />} />
          <Route path="/:locale/caws/:id" element={<CawMediaModal />} />
        </Routes>
      )}
    </>
  )
}

function App() {
  useCawonceSync();
  useTxQueueMonitor();
  useSessionKeyWalletGuard();
  useSessionSpendSync(); // Sync on-chain session spending on load
  useBadgeSync(); // Combined poll for sidebar badge counts (DMs, notifications, offers)
  useIncomingBalanceWatcher(); // Fires balance-change toast windows when likes/recaws/follows/tips land

  // Discover peer instances on boot + every 5 min. Without this call,
  // useInstanceStore stays empty and getApiHosts() returns just the
  // local primary — meaning every redundancy-broadcast site
  // (signAndSubmit, DM relay, host verification) silently no-ops
  // because there are no peers to talk to. Gated on a valid CLIENT_ID
  // so a misconfigured FE doesn't make a chain-scan request with NaN.
  // The 5-min refresh is mostly free: fetchInstances skips if it
  // refreshed within FRESH_THRESHOLD_MS (10 min); the schedule just
  // ensures a long-running session picks up newly-registered peers
  // without a hard reload.
  const fetchInstances = useInstanceStore(s => s.fetchInstances)
  useEffect(() => {
    if (!Number.isFinite(CLIENT_ID) || CLIENT_ID <= 0) return
    fetchInstances(CLIENT_ID).catch(() => { /* fetchInstances logs internally */ })
    // 30 min between refreshes. Per-instance change events arrive via
    // the API tier when peers register/update — the chain-fallback
    // path only runs if the API tier is dead, and that path issues
    // ~140 eth_getLogs per call (chunked back to genesis on free
    // RPCs). 5min was burning thousands of getLogs/hr per browser.
    const id = setInterval(() => {
      fetchInstances(CLIENT_ID).catch(() => {})
    }, 30 * 60 * 1000)
    return () => clearInterval(id)
  }, [fetchInstances])

  // Rehydrate the wallet session on app startup. The HttpOnly caw_session
  // cookie carries the real auth — but the FE's useAuthStore only persists
  // the derived hints (authorizedTokenIds/Addresses). On any reload the
  // store starts effectively empty even when the cookie is still valid;
  // /api/auth/refresh reads the DB and hydrates those hints back without
  // requiring a fresh wallet signature. Fires once per mount.
  // skipAuthModal=true: 401 here just means "no live session" — not a
  // privileged-action failure — so we must not open the verify modal.
  useEffect(() => {
    let cancelled = false
    apiFetch<{
      sessionToken?: string
      authorizedTokenIds?: number[]
      authorizedAddresses?: string[]
      expiresAt?: number
    }>('/api/auth/refresh', { method: 'POST', skipAuthModal: true })
      .then(data => {
        if (cancelled) return
        if (data?.sessionToken) {
          useAuthStore.getState().setSession(
            data.sessionToken,
            data.authorizedTokenIds ?? [],
            data.authorizedAddresses ?? [],
            data.expiresAt ?? Date.now() + 86400_000,
          )
        }
      })
      .catch(() => {
        // No live cookie or already-invalid session — leave the store as-is.
        // (clearSession on AUTH_REQUIRED is handled inside apiFetch; do nothing here.)
      })
    return () => { cancelled = true }
  }, [])

  // Fetch blocked users from server on init
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeTokenFallback = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens[0]?.tokenId
  })
  const effectiveTokenId = activeTokenId || activeTokenFallback
  const fetchBlocks = useBlockedUsersStore(s => s.fetchBlocks)
  const blocksInitialized = useBlockedUsersStore(s => s.initialized)
  useEffect(() => {
    if (effectiveTokenId && !blocksInitialized) {
      fetchBlocks(effectiveTokenId)
    }
  }, [effectiveTokenId, blocksInitialized, fetchBlocks])

  const stakeModal = useInsufficientStakeStore()
  const actionError = useActionErrorStore()

  return (
    <BrowserRouter>
      <I18nProvider>
      {/* Suspense fallback is intentionally null — every lazy route is
          a full page, so a one-frame blank during chunk fetch is less
          jarring than a spinner that flashes for ~50ms on a fast
          connection. On slow networks the browser's own loading bar
          tells the user something's happening. */}
      <Suspense fallback={null}>
        <AppRoutes />
      </Suspense>

      <InsufficientStakeModal
        isOpen={stakeModal.isOpen}
        onClose={stakeModal.close}
        currentAmount={stakeModal.currentAmount}
        requiredAmount={stakeModal.requiredAmount}
        actionType={stakeModal.actionType}
        onStake={stakeModal.onStake}
      />
      <OnboardingGuard />
      <VerifyWalletModal />
      <SignInModal />
      <QuickSignRenewModal />
      <QuickSignModal />
      <QuickSignUnlock />
      <ClientAuthModal />
      <BalanceChangeToast />
      {/* Lazy modals: each renders to null until its zustand isOpen flips,
          so the chunk fetch doesn't fire on first paint. Suspense fallback
          is null because the modal itself was hidden a moment ago anyway —
          the user perceives "click → modal appears after a beat" not a
          loading state. */}
      <Suspense fallback={null}>
        <TransferNFTModal />
        <CreateListingModal />
        <BuyModal />
        <PlaceBidModal />
        <MakeOfferModal />
        <ViewOffersModal />
        <SyncTransferModal />
      </Suspense>

      {/* Global action error modal */}
      <ModalWrapper isOpen={actionError.isOpen} onClose={actionError.close} maxWidth="max-w-sm">
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-red-500/20">
              <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-white">
              {actionError.title}
            </h3>
          </div>
          <p className="text-sm text-white/70">
            {actionError.message}
          </p>
          <button
            onClick={actionError.close}
            className="w-full py-2.5 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer"
          >
            OK
          </button>
        </div>
      </ModalWrapper>
      </I18nProvider>
    </BrowserRouter>
  );
}

export default App;
