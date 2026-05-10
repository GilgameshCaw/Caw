import { WagmiProvider, http } from "wagmi";
import { mainnet, sepolia, baseSepolia } from "wagmi/chains";
import { getDefaultConfig, RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// RPC URLs — configurable via VITE_ env vars, falls back to free public endpoints.
// Set VITE_L1_RPC_URL / VITE_L2_RPC_URL in the frontend .env to use the same
// provider as the server (recommended). The optional _FRONTEND variants allow
// a dedicated frontend RPC if needed (e.g. rate-limit separation).
const L1_RPC = import.meta.env.VITE_L1_RPC_URL_FRONTEND
  || import.meta.env.VITE_L1_RPC_URL
  || "https://ethereum-sepolia-rpc.publicnode.com"
const L2_RPC = import.meta.env.VITE_L2_RPC_URL_FRONTEND
  || import.meta.env.VITE_L2_RPC_URL
  || "https://base-sepolia-rpc.publicnode.com"

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

export const wagmiConfig = getDefaultConfig({
  appName: "CAW",
  appDescription: "A trustless and decentralized social clearing-house committed to making freedom of speech unstoppable.",
  appUrl: APP_URL,
  appIcon: `${APP_URL}/logo.jpeg`,
  projectId: import.meta.env.VITE_PROJECT_ID || "your_project_id_here",
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
