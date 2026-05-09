//src/config/chains.ts
import { sepolia, baseSepolia }       from 'wagmi/chains'

export const chains = {
  l1: {
    chainId:    sepolia.id,
    layerZero:  40161,
  },
  l2: {
    chainId:    baseSepolia.id,
    layerZero:  40245,
  }
} as const

export type ChainKey = keyof typeof chains

// True when the configured L1 is a testnet. Single source of truth
// for testnet-vs-mainnet UI flips (Faucet vs Uniswap CTA, "(testnet)"
// labels, etc.) so we don't sprinkle `chainId === 11155111` across
// the codebase.
const TESTNET_CHAIN_IDS = new Set<number>([
  11155111, // Sepolia
  17000,    // Holesky
  84532,    // Base Sepolia
  421614,   // Arbitrum Sepolia
  11155420, // OP Sepolia
])

export const isTestnet = TESTNET_CHAIN_IDS.has(chains.l1.chainId)
