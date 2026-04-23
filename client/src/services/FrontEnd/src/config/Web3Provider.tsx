import { WagmiProvider, http } from "wagmi";
import { sepolia, baseSepolia } from "wagmi/chains";
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

export const wagmiConfig = getDefaultConfig({
  appName: "CAW",
  projectId: import.meta.env.VITE_PROJECT_ID || "your_project_id_here",
  chains: [sepolia, baseSepolia],
  transports: {
    [sepolia.id]: http(L1_RPC, transportOptions),
    [baseSepolia.id]: http(L2_RPC, transportOptions),
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
