import { BrowserRouter, Route, Routes } from "react-router";
import { useCawonceSync } from '~/hooks/useCawonce'
import { useSessionKeyWalletGuard } from '~/hooks/useSessionKey'
import { useTxQueueMonitor } from '~/hooks/useTxQueueMonitor'
import { useClientConfig } from '~/store/clientConfigStore'
import { CLIENT_ID } from '~/api/actions'
import { useAccount } from "wagmi"
import routes from "./routes";
import InsufficientStakeModal from '~/components/modals/InsufficientStakeModal'
import { useInsufficientStakeStore } from '~/store/insufficientStakeStore'
import VerifyWalletModal from '~/components/modals/VerifyWalletModal'
import SignInModal from '~/components/modals/SignInModal'
import TransferNFTModal from '~/components/modals/TransferNFTModal'
import CreateListingModal from '~/components/modals/CreateListingModal'
import BuyModal from '~/components/modals/BuyModal'
import PlaceBidModal from '~/components/modals/PlaceBidModal'
import MakeOfferModal from '~/components/modals/MakeOfferModal'
import ViewOffersModal from '~/components/modals/ViewOffersModal'
import SyncTransferModal from '~/components/modals/SyncTransferModal'
import OnboardingGuard from '~/components/OnboardingGuard'
import QuickSignRenewModal from '~/components/modals/QuickSignRenewModal'
import QuickSignModal from '~/components/modals/QuickSignModal'
import QuickSignUnlock from '~/components/QuickSignUnlock'
import ClientAuthModal from '~/components/modals/ClientAuthModal'
import { useSessionSpendSync } from '~/hooks/useSessionSpendSync'
import { useDmUnreadSync } from '~/hooks/useDmUnreadSync'
import { useNotificationUnreadSync } from '~/hooks/useNotificationUnreadSync'
import { useOffersUnreadSync } from '~/hooks/useOffersUnreadSync'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useActionErrorStore } from '~/store/actionErrorStore'
import ModalWrapper from '~/components/modals/ModalWrapper'
import { useEffect } from 'react'

function App() {
  useCawonceSync();
  useTxQueueMonitor();
  useSessionKeyWalletGuard();
  useClientConfig(CLIENT_ID); // Fetch client config on init for dynamic tip calculation
  useSessionSpendSync(); // Sync on-chain session spending on load
  useDmUnreadSync(); // Fetch DM unread count for sidebar badge
  useNotificationUnreadSync(); // Fetch notification unread count for sidebar badge
  useOffersUnreadSync(); // Fetch received offers count for sidebar badge

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
      <Routes>
        {routes.map((route) => (
          <Route key={route.path} path={route.path} element={route.component} />
        ))}
      </Routes>

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
      <TransferNFTModal />
      <CreateListingModal />
      <BuyModal />
      <PlaceBidModal />
      <MakeOfferModal />
      <ViewOffersModal />
      <SyncTransferModal />

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
    </BrowserRouter>
  );
}

export default App;
