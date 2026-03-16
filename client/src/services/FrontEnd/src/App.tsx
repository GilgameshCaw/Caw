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

function App() {
  useCawonceSync();
  useTxQueueMonitor();
  useClientConfig(CLIENT_ID); // Fetch client config on init for dynamic tip calculation

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
      />
      <VerifyWalletModal />
      <TransferNFTModal />
      <SyncTransferModal />
    </BrowserRouter>
  );
}

export default App;
