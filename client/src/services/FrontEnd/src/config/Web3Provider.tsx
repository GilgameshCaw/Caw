import { WagmiProvider, http, webSocket } from "wagmi";
import { sepolia, baseSepolia, hardhat, mainnet } from "wagmi/chains";
import { getDefaultConfig, RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const rpcs = {
  HARDHAT: "ws://127.0.0.1:8545",
  // TODO: move this out to config file or .env
  ALCHEMY_MAINNET: "https://mainnet.infura.io/v3/xxx",
  SEPOLIA: "https://ethereum-sepolia-rpc.publicnode.com",
  BASE_SEPOLIA: "https://base-sepolia-rpc.publicnode.com"
};

const queryClient = new QueryClient();

export const wagmiConfig = getDefaultConfig({
  appName: "CAW",
  projectId: "xxx",
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
}

export default function Web3Provider({ children }: Web3ProviderProps) {
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
