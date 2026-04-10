import { WagmiProvider, http, webSocket } from "wagmi";
import { sepolia, baseSepolia, hardhat, mainnet } from "wagmi/chains";
import { getDefaultConfig, RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const rpcs = {
  HARDHAT: "ws://127.0.0.1:8545",
  // Using environment variables for RPC URLs
  ALCHEMY_MAINNET: import.meta.env.VITE_ALCHEMY_API_KEY
    ? `https://eth-mainnet.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`
    : "https://mainnet.infura.io/v3/xxx",
  SEPOLIA: "https://ethereum-sepolia-rpc.publicnode.com",
  BASE_SEPOLIA: "https://base-sepolia-rpc.publicnode.com"
};

export const wagmiConfig = getDefaultConfig({
  appName: "CAW",
  projectId: import.meta.env.VITE_PROJECT_ID || "your_project_id_here",
  chains: [sepolia, baseSepolia],
  transports: {
    [sepolia.id]: http(rpcs.SEPOLIA),
    [baseSepolia.id]: http(rpcs.BASE_SEPOLIA),
    // [hardhat.id]: http(rpcs.HARDHAT),
    // [mainnet.id]: http(rpcs.ALCHEMY_MAINNET),
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
