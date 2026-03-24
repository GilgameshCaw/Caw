import { BrowserRouter, Route, Routes } from "react-router";
import { useCawonceSync } from '~/hooks/useCawonce'
import { useTxQueueMonitor } from '~/hooks/useTxQueueMonitor'
import { useClientConfig } from '~/store/clientConfigStore'
import { CLIENT_ID } from '~/api/actions'
import { useAccount } from "wagmi"
import routes from "./routes";
import InsufficientStakeModal from '~/components/modals/InsufficientStakeModal'
import { useInsufficientStakeStore } from '~/store/insufficientStakeStore'
import VerifyWalletModal from '~/components/modals/VerifyWalletModal'
import TransferNFTModal from '~/components/modals/TransferNFTModal'
import SyncTransferModal from '~/components/modals/SyncTransferModal'
import OnboardingGuard from '~/components/OnboardingGuard'
import QuickSignRenewModal from '~/components/modals/QuickSignRenewModal'
import ClientAuthModal from '~/components/modals/ClientAuthModal'
import { useSessionSpendSync } from '~/hooks/useSessionSpendSync'
import { useDmUnreadSync } from '~/hooks/useDmUnreadSync'
import { useNotificationUnreadSync } from '~/hooks/useNotificationUnreadSync'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useEffect } from 'react'

function App() {
  useCawonceSync();
  useTxQueueMonitor();
  useClientConfig(CLIENT_ID); // Fetch client config on init for dynamic tip calculation
  useSessionSpendSync(); // Sync on-chain session spending on load
  useDmUnreadSync(); // Fetch DM unread count for sidebar badge
  useNotificationUnreadSync(); // Fetch notification unread count for sidebar badge

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
      <QuickSignRenewModal />
      <ClientAuthModal />
      <TransferNFTModal />
      <SyncTransferModal />
    </BrowserRouter>
  );
}

export default App;
