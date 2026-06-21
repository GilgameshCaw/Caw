/**
 * RainbowKitLayer — lazy-loaded RainbowKit UI layer.
 *
 * This module is the ONLY file in the FE that imports from @rainbow-me/rainbowkit
 * (except ConnectButton.tsx / WalletAccountButton.tsx which are similarly
 * only rendered when wallet UI is needed). It is loaded via React.lazy in
 * Web3Provider.tsx and only mounts when a wallet-connect flow is first invoked.
 *
 * On mount it:
 *   1. Calls connectorsForWallets() to build the RK-decorated connector list.
 *   2. REPLACES the wagmi-native connectors already in wagmiConfig (registered
 *      eagerly at startup in wagmiConfig.ts) with their RK-decorated equivalents
 *      so the connect modal has proper icons, names, and deep links.
 *      injected() and any connector not present in the RK list are preserved.
 *   3. Registers openConnectModal into the connectModalStore bridge.
 *   4. Drains any queued open request that triggered the mount.
 *
 * The CSS (`@rainbow-me/rainbowkit/styles.css`) is imported here instead of
 * main.tsx so it lands in the lazy chunk rather than the entry bundle.
 *
 * Reconnect behaviour: wagmi's reconnect() reads config.connectors synchronously
 * during WagmiProvider render (before this lazy chunk loads). The wagmi-native
 * connectors in wagmiConfig.ts handle that. This layer only needs to run before
 * the user SEES the connect modal — which is always after a user action.
 */
import "@rainbow-me/rainbowkit/styles.css";

import { useEffect } from "react";
import {
  RainbowKitProvider,
  darkTheme,
  useConnectModal,
  useAccountModal,
  connectorsForWallets,
} from "@rainbow-me/rainbowkit";
import {
  safeWallet,
  rainbowWallet,
  coinbaseWallet,
  metaMaskWallet,
  walletConnectWallet,
  ledgerWallet,
} from "@rainbow-me/rainbowkit/wallets";

import { wagmiConfig } from "~/config/wagmiConfig";
import { useConnectModalStore } from "~/store/connectModalStore";

// RainbowKit forwards appName/appDescription/appUrl/appIcon into the
// WalletConnect `metadata` object on every pairing request. Some wallets
// (notably Zerion mobile) treat a sparse / missing metadata payload as a
// signal that the dApp is on the legacy WalletConnect v1 protocol, and
// surface a misleading "DApp uses WalletConnect v1.0 which is outdated"
// warning. Populating all four fields makes the dApp render correctly
// in every wallet's pairing UI AND silences the false-positive v1 alert.
const APP_URL = (typeof window !== 'undefined' && window.location?.origin)
  || 'https://caw.social'

// Loud-fail in production if VITE_PROJECT_ID is unset or still placeholder.
// Mobile users (no injected wallet) depend entirely on WalletConnect — a
// missing or placeholder projectId silently breaks every mobile wallet.
// Fail at module init time so the error surfaces clearly in the local
// ErrorBoundary (see Web3Provider.tsx) rather than manifesting as
// "no wallet options appear" or crashing the whole app.
const _projectId = import.meta.env.VITE_PROJECT_ID || "your_project_id_here"
if (import.meta.env.PROD && (!_projectId || _projectId === 'your_project_id_here')) {
  throw new Error(
    'VITE_PROJECT_ID is unset or placeholder in production build. ' +
    'WalletConnect will not work. Set a valid WalletConnect Cloud project ID.'
  )
}

// Explicit wallet list. We pin this rather than relying on the implicit
// `getDefaultWallets()` so a future RainbowKit version bump can't silently
// re-introduce hardware-wallet connectors into the "Popular" group.
//
// Hardware-wallet connectors (Ledger, etc.) probe WebUSB / WebHID during
// connector init, which triggers a browser-level permission prompt the
// first time the user opens any wallet flow — even users who don't own a
// hardware wallet see it. We push Ledger into a separate "Hardware" group
// behind the "More" expansion in the RainbowKit modal so it only loads
// when a user actively reaches for it.
const walletList = [
  {
    groupName: "Popular",
    wallets: [
      safeWallet,
      rainbowWallet,
      coinbaseWallet,
      metaMaskWallet,
      walletConnectWallet,
    ],
  },
  {
    groupName: "Hardware",
    wallets: [ledgerWallet],
  },
];

// Replace wagmi-native connectors with RK-decorated equivalents.
//
// wagmiConfig.ts registers native wagmi connectors (walletConnect, metaMask,
// coinbaseWallet, safe) EAGERLY so wagmi's reconnect() sees them on page load.
// Here we replace those native stubs with RK-decorated versions that carry
// icons, grouping metadata, and deep links needed by the connect modal.
//
// The REPLACE strategy (not append-and-skip) is intentional:
//   - injected() is preserved (different id, not in the RK list).
//   - connectors with the same id as an RK connector are swapped out.
//   - rainbowWallet has no native counterpart, so it is appended.
//
// LOW guard: assert the internal setup API exists before calling it.
// A future wagmi version bump that removes or renames this API will fail
// loudly here rather than silently corrupting the connector list.
if (typeof wagmiConfig._internal?.connectors?.setup !== 'function') {
  throw new Error(
    '[RainbowKitLayer] wagmiConfig._internal.connectors.setup is not a function. ' +
    'This wagmi version is incompatible with the RK connector injection pattern. ' +
    'Check wagmi release notes and update the connector injection code.'
  )
}

const rkConnectorFns = connectorsForWallets(walletList, {
  projectId: _projectId,
  appName: "CAW",
  appDescription: "A trustless and decentralized social clearing-house committed to making freedom of speech unstoppable.",
  appUrl: APP_URL,
  appIcon: `${APP_URL}/logo.jpeg`,
});

wagmiConfig._internal.connectors.setState((existing) => {
  // Instantiate each RK connector factory via the internal setup helper.
  // setup() wires emitter + uid, exactly as createConfig does at init.
  const rkConnectors = rkConnectorFns.map((fn) => wagmiConfig._internal.connectors.setup(fn))
  const rkById = new Map(rkConnectors.map((c) => [c.id, c]))

  // Replace existing connectors that have an RK equivalent; keep the rest.
  // This preserves injected() and any connector not in the RK wallet list.
  const replaced = existing.map((c) => rkById.get(c.id) ?? c)
  const replacedIds = new Set(replaced.map((c) => c.id))

  // Append any RK connectors that don't replace an existing one (e.g. rainbowWallet,
  // ledgerWallet) — these are new entries with no prior native counterpart.
  const appended = rkConnectors.filter((c) => !replacedIds.has(c.id))
  return [...replaced, ...appended]
})

/**
 * Inner component that has access to RainbowKitProvider context.
 * Bridges useConnectModal + useAccountModal into the connectModalStore.
 */
function ModalRegistrar() {
  const { openConnectModal } = useConnectModal()
  const { openAccountModal } = useAccountModal()
  const setOpenConnectModal = useConnectModalStore(s => s.setOpenConnectModal)
  const setOpenAccountModal = useConnectModalStore(s => s.setOpenAccountModal)
  const drainPendingOpen = useConnectModalStore(s => s.drainPendingOpen)

  useEffect(() => {
    setOpenConnectModal(openConnectModal ?? null)
    setOpenAccountModal(openAccountModal ?? null)
    // If a caller requested open before the layer mounted, fire it now.
    // Drain is a no-op when pendingModal is null.
    drainPendingOpen()
    return () => {
      // On unmount clear the bridge (shouldn't normally happen — layer stays
      // mounted once requested — but guards against edge cases).
      setOpenConnectModal(null)
      setOpenAccountModal(null)
    }
  }, [openConnectModal, openAccountModal, setOpenConnectModal, setOpenAccountModal, drainPendingOpen])

  return null
}

interface RainbowKitLayerProps {
  children?: React.ReactNode
}

/**
 * The lazy RainbowKit UI layer.
 *
 * Renders <RainbowKitProvider> wrapping children, and mounts
 * ConnectModalRegistrar to bridge the openConnectModal function into the
 * shared store for callers outside this subtree.
 *
 * Web3Provider renders this conditionally — only when mountRequested = true
 * in connectModalStore. Once mounted it stays mounted (unmounting would lose
 * active wallet connections).
 */
export default function RainbowKitLayer({ children }: RainbowKitLayerProps) {
  // Diagnostic: surface WalletConnect projectId + origin so Rainbow Wallet
  // connection failures on test.caw.social can be triaged from console alone.
  // LOW: guard with !PROD so the projectId does not leak into production logs.
  useEffect(() => {
    if (!import.meta.env.PROD) {
      const origin = typeof window !== 'undefined' ? window.location.origin : '(no window)';
      console.log(`[RainbowKitLayer] mounted — projectId=${_projectId} origin=${origin}`);
      if (_projectId === "your_project_id_here") {
        console.warn('[RainbowKitLayer] WARNING: VITE_PROJECT_ID is unset; WalletConnect will not work');
      }
    }
  }, [])

  return (
    <RainbowKitProvider
      theme={darkTheme({ accentColor: "#f7b72b", accentColorForeground: "#10101d", borderRadius: "medium" })}
      // Suppress RainbowKit's built-in avatar (gradient blockie / ENS image)
      // in the wallet menu — the app renders its own profile avatar elsewhere
      // and the RK one was visually competing inside the connected-account chip.
      avatar={() => null}
    >
      <ModalRegistrar />
      {children}
    </RainbowKitProvider>
  )
}
