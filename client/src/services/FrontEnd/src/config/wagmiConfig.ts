import { createConfig, http, injected } from "wagmi";
import { walletConnect, metaMask, coinbaseWallet, safe } from "wagmi/connectors";
import { mainnet, sepolia, baseSepolia } from "wagmi/chains";

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

// wagmi auto-polls eth_blockNumber to invalidate stale queries.
// Default is ~4s, which is ~3,600/hour just from one open tab — was
// the single biggest contributor to RPC quota burn. We don't need
// near-real-time block tracking on the FE; almost every read can
// tolerate a 30s lag. Cuts blockNumber polling by ~7×.
const BLOCK_POLLING_INTERVAL_MS = 30_000

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
//
// WalletConnect projectId — the same value RainbowKitLayer uses. Duplicated
// here so wagmi can configure the WalletConnect connector at startup without
// a dependency on RainbowKit code.
const _projectId = import.meta.env.VITE_PROJECT_ID || "your_project_id_here"

// Connectors are registered EAGERLY here so wagmi's reconnect() sees the full
// set when WagmiProvider first renders.
//
// Why eagerly: wagmi's hydrate() calls reconnect(config) synchronously during
// WagmiProvider render (config._internal.ssr is false → onMount() runs
// inline). reconnect() reads config.connectors at call time — before any
// await/microtask boundary. If connectors are injected lazily (on first
// Connect click), any Pop-A user who previously connected via WalletConnect
// or MetaMask SDK will appear DISCONNECTED on every page reload.
//
// These are wagmi-native connectors from wagmi/connectors (already in the
// vendor-core chunk — no bundle-size regression). The lazy RainbowKitLayer
// chunk REPLACES them with RK-decorated equivalents (icons, group names, deep
// links) once the user opens the connect modal for the first time. Reconnect
// on reload uses the native versions; the RK modal uses the decorated ones.
//
// injected() covers EIP-6963 browser extension wallets (MetaMask extension,
// Brave Wallet, Rabby, etc.) and is also used for passkey / chain-read flows.
export const wagmiConfig = createConfig({
  chains: [sepolia, baseSepolia, mainnet],
  pollingInterval: BLOCK_POLLING_INTERVAL_MS,
  connectors: [
    injected(),
    walletConnect({ projectId: _projectId }),
    metaMask(),
    coinbaseWallet({ appName: "CAW" }),
    safe(),
  ],
  transports: {
    [sepolia.id]: http(L1_RPC, transportOptions),
    [baseSepolia.id]: http(L2_RPC, transportOptions),
    // Mainnet transport is unused — see chains comment above. Public
    // RPC is fine here; no eth_calls flow through it under normal use.
    [mainnet.id]: http("https://ethereum-rpc.publicnode.com", transportOptions),
  },
});
