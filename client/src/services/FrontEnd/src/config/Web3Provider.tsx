import { useEffect } from "react";
import { WagmiProvider, http } from "wagmi";
import { mainnet, sepolia, baseSepolia } from "wagmi/chains";
import { getDefaultConfig, RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import {
  safeWallet,
  rainbowWallet,
  coinbaseWallet,
  metaMaskWallet,
  walletConnectWallet,
  ledgerWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// RPC URLs — default to OUR backend RPC proxy at /api/rpc/{l1,l2}.
// The proxy folds identical reads across all browsers into one
// upstream Infura call, caches "latest"-block results for 3-5s, and
// keeps the Infura key out of the bundle entirely. At 100 users open
// at the same time, this is the difference between 100× upstream
// fan-out and ~1× (plus cache misses on user-specific reads).
//
// Operators can override per-chain via VITE_L1_RPC_URL[_FRONTEND]
// and VITE_L2_RPC_URL[_FRONTEND] — useful for tests where the proxy
// is bypassed deliberately. The public-RPC fallback is a last
// resort for static-hosted FE deployments that don't run a backend.
const L1_RPC = import.meta.env.VITE_L1_RPC_URL_FRONTEND
  || import.meta.env.VITE_L1_RPC_URL
  || (typeof window !== 'undefined' ? `${window.location.origin}/api/rpc/l1` : '/api/rpc/l1')
const L2_RPC = import.meta.env.VITE_L2_RPC_URL_FRONTEND
  || import.meta.env.VITE_L2_RPC_URL
  || (typeof window !== 'undefined' ? `${window.location.origin}/api/rpc/l2` : '/api/rpc/l2')

// Shared transport options for both chains.
// - `batch.wait: 16ms` — coalesces any eth_call issued in the same render cycle
//   into a single JSON-RPC batch request. Drops the per-render RPC count
//   roughly by N (number of contract reads on the page).
// - `retryCount: 3` with `retryDelay: 1000` — retry 429s with a 1s base delay,
//   doubled by viem's built-in exponential backoff. Infura gets 4 attempts
//   over ~15s before failing for real instead of spamming.
const transportOptions = {
  batch: { wait: 16 },
  retryCount: 3,
  retryDelay: 1_000,
}

// RainbowKit forwards appName/appDescription/appUrl/appIcon into the
// WalletConnect `metadata` object on every pairing request. Some wallets
// (notably Zerion mobile) treat a sparse / missing metadata payload as a
// signal that the dApp is on the legacy WalletConnect v1 protocol, and
// surface a misleading "DApp uses WalletConnect v1.0 which is outdated"
// warning. Populating all four fields makes the dApp render correctly
// in every wallet's pairing UI AND silences the false-positive v1 alert.
const APP_URL = (typeof window !== 'undefined' && window.location?.origin)
  || 'https://caw.social'

// Mainnet is included in the chain tuple ONLY to satisfy mobile wallets'
// CAIP-25 namespace check during WalletConnect v2 pairing. Rainbow Mobile
// (and others) reject the session proposal with "No accounts found in
// approved namespaces" when the dApp's required chains are testnet-only
// — those wallets ship without testnet accounts by default and have no
// surfaced toggle to add them. Listing mainnet (which every EVM wallet
// always has accounts on) makes the namespace match and the wallet
// approves the session. We never read or write mainnet — all our RPC
// transports stay testnet — so this is a connection-handshake placeholder,
// not a real chain in the app. Sepolia is first so wagmi's default-chain
// selection still lands the user on the L1 testnet.
// wagmi auto-polls eth_blockNumber to invalidate stale queries.
// Default is ~4s, which is ~3,600/hour just from one open tab — was
// the single biggest contributor to RPC quota burn. We don't need
// near-real-time block tracking on the FE; almost every read can
// tolerate a 30s lag. Cuts blockNumber polling by ~7×.
const BLOCK_POLLING_INTERVAL_MS = 30_000

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

export const wagmiConfig = getDefaultConfig({
  appName: "CAW",
  appDescription: "A trustless and decentralized social clearing-house committed to making freedom of speech unstoppable.",
  appUrl: APP_URL,
  appIcon: `${APP_URL}/logo.jpeg`,
  projectId: import.meta.env.VITE_PROJECT_ID || "your_project_id_here",
  wallets: walletList,
  chains: [sepolia, baseSepolia, mainnet],
  pollingInterval: BLOCK_POLLING_INTERVAL_MS,
  transports: {
    [sepolia.id]: http(L1_RPC, transportOptions),
    [baseSepolia.id]: http(L2_RPC, transportOptions),
    // Mainnet transport is unused — see chains comment above. Public
    // RPC is fine here; no eth_calls flow through it under normal use.
    [mainnet.id]: http("https://ethereum-rpc.publicnode.com", transportOptions),
  },
});

interface Web3ProviderProps {
  children: React.ReactNode;
  queryClient: QueryClient;
}

export default function Web3Provider({ children, queryClient }: Web3ProviderProps) {
  // Diagnostic: surface WalletConnect projectId + origin so Rainbow Wallet
  // connection failures on test.caw.social can be triaged from console alone.
  // The placeholder-id check catches missing VITE_PROJECT_ID (the most common
  // cause of "QR scans but never opens the dApp" symptoms).
  useEffect(() => {
    const projectId = import.meta.env.VITE_PROJECT_ID || "your_project_id_here";
    const origin = typeof window !== 'undefined' ? window.location.origin : '(no window)';
    console.log(`[Web3Provider] projectId=${projectId} origin=${origin}`);
    if (projectId === "your_project_id_here") {
      console.warn('[Web3Provider] WARNING: VITE_PROJECT_ID is unset; WalletConnect will not work');
    }
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({ accentColor: "#f7b72b", accentColorForeground: "#10101d", borderRadius: "medium" })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
