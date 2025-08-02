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

