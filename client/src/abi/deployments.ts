/**
 * Deployment manifest for CAW Protocol contracts.
 *
 * MANAGED BY: solidity/scripts/deploy.js (after every successful deploy run).
 * READ BY: cli/src/steps/* (resolves the operator's chosen network to the
 *          right per-chain addresses, then writes addresses.ts).
 *
 * STRUCTURE:
 *   deployments[env][chainKey][contractName] = address
 *
 *   * env       — 'testnet' | 'mainnet' | 'dev'
 *   * chainKey  — 'L1' | 'L2' | 'L2b' | future 'L2c'...
 *
 * One Network = one storage chain. The CLI looks up the operator's networkId
 * on the L1 CawNetworkManager (getStorageChainEid), maps the eid back to a
 * chainKey, and pulls THIS Network's CawActions / CawProfileL2 / etc. from
 * the matching block. addresses.ts ends up with singular constants — the
 * call-sites in the rest of the codebase don't have to be multi-chain aware.
 *
 * Per-chain contracts (one entry per L2):
 *   - CawActions       (storage chain — receives action submissions)
 *   - CawProfileL2     (per-chain balance/auth bookkeeping)
 *   - CawActionsArchive (storage chain doubles as archive — see deploy.js)
 *   - CawChallengeRelay (storage chain's relay for fraud proofs)
 *
 * L1-only contracts:
 *   - CawProfile, CawNetworkManager, CawProfileMinter, CawProfileQuoter,
 *     CawProfileMarketplace, CawProfileURI, MintableCaw, CawProfileL2_L1,
 *     CawActions_L1
 *     (L1 hosts a co-deployed CawProfileL2 + CawActions in bypassLZ mode so
 *     a Network can pick L1 as their storage chain. L1 doesn't get its own
 *     archive/relay — see L2_CHAIN_KEYS comment in deploy.js.)
 *
 * After deploy: deploy.js rewrites just the env block it ran against.
 * Other env blocks are left untouched.
 */

export type Env = 'testnet' | 'mainnet' | 'dev'
export type ChainKey = 'L1' | 'L2' | 'L2b' | string

export interface ChainContracts {
  // L1-only contracts (only present on chainKey === 'L1'):
  MintableCaw?: `0x${string}`
  CawProfile?: `0x${string}`
  CawProfileL2?: `0x${string}`     // On L1 this is the bypassLZ co-deployed mirror
  CawNetworkManager?: `0x${string}`
  CawProfileMinter?: `0x${string}`
  CawProfileQuoter?: `0x${string}`
  CawProfileMarketplace?: `0x${string}`
  CawProfileURI?: `0x${string}`
  CawFontDataA?: `0x${string}`
  CawFontDataB?: `0x${string}`
  CawBuyAndBurn?: `0x${string}`
  MockSwapRouter?: `0x${string}`
  SmartEOA?: `0x${string}`

  // Per-chain contracts (present on every L2; CawActions also on L1):
  CawActions?: `0x${string}`
  CawActionsERC1271?: `0x${string}`
  CawActionsArchive?: `0x${string}`
  CawChallengeRelay?: `0x${string}`
}

export type Deployments = Record<Env, Partial<Record<ChainKey, ChainContracts>>>

export const deployments: Deployments = {
  testnet: {
    L1: {
      MintableCaw: '0x56817dc696448135203C0556f702c6a953260411',
      CawProfile: '0xFb45Cae2073eA04E3cF31A2D6E55F03737bCA327',
      CawProfileL2: '0x9804b869bFb5E86Ac61748572c40B719d6E0cb37',
      CawNetworkManager: '0x7eE68c573824597FeDd4df38FA30E2D397ec3C07',
      CawProfileMinter: '0xDa124Dba089839e979347117d76004Be7feBD74B',
      CawProfileQuoter: '0xbA30c1Ac24C91E0Ff4294315C295825500Ceea78',
      CawProfileMarketplace: '0x68bFF54d7597387b8CB0e81C9Cf4DA7f0a253312',
      SmartEOA: '0x710041dE1109Ca2077D3580b92bbD20971fc35dc',
      CawProfileURI: '0xC2F820886149abfdC40457E20F35E3A035228100',
      CawFontDataA: '0xa024a43433268EeE963CB201607C2bC58Df9E404',
      CawFontDataB: '0x2529793Df80624716e0F8C71c7c13f6A74072565',
      CawBuyAndBurn: '0xC6D0Ef24BFA66Cfd0Df166d84F7D602b46BF8812',
      CawActions: '0x0b498D4402E8F5bCDD7da7e245B537588263f5Bb',
      CawActionsERC1271: '0x6b0e5c11d8e97Af59E03b08d631c1BA7DD4fDF1e',
    },
    L2: {
      CawProfileL2: '0x866bD663cadf2a5bA23Fab2049732F4067301DfA',
      CawActions: '0xB305E9014f8058AdDE0faD8A53eb895B50564bEB',
      CawActionsERC1271: '0xA6d7cB1001f1D303762529B4e55c279d998acEDa',
      CawActionsArchive: '0x506c5c09B064fcFf6861B1e08b6530D997715159',
      CawChallengeRelay: '0x166FD4aa0379D01251beFAdcc3646004D5be9e91',
    },
    L2b: {
      CawProfileL2: '0x6f310D30bd954D24b83d3233C8529dBdC9B6C72a',
      CawActions: '0x618B3b69aB54Ed8624A03F92C2a8c9c58421dA47',
      CawActionsERC1271: '0xb3f4C111D4424cf9D0c2DC4bda44124adB59c767',
      CawActionsArchive: '0x56BC0Ef3E55CcCb9e0E6ad7E8d8Ce332B368E06b',
      CawChallengeRelay: '0x5e8fFC6fe6F2902970b6733f064B8bF82E5c4D0e',
    },
  },
  mainnet: {
    L1: {
      // CAW token already exists on mainnet; everything else deploys here.
      MintableCaw: '0xf3b9569F82B18aEf890De263B84189bd33EBe452',
    },
  },
  dev: {},
}

/**
 * Look up the deployments block for one (env, chain) pair. Throws if the
 * env or chain is unknown — better to fail loudly during install than to
 * silently end up with undefined addresses on a different chain.
 */
export function getChainContracts(env: Env, chainKey: ChainKey): ChainContracts {
  const envBlock = deployments[env]
  if (!envBlock) throw new Error(`Unknown deployment env: ${env}`)
  const chainBlock = envBlock[chainKey]
  if (!chainBlock) throw new Error(`No deployments for ${env}/${chainKey}`)
  return chainBlock
}

/**
 * LZ endpoint IDs for each (env, chainKey) pair. Same source-of-truth shape
 * as the addresses above so the CLI can map a Network's storageChainEid back
 * to the right chainKey without duplicating the table elsewhere.
 *
 * Kept in sync by hand with solidity/scripts/deploy.js CHAINS map. If you
 * edit one, edit the other (or factor out a single shared constants module
 * later — currently a CommonJS / ESM boundary).
 */
export const lzEids: Record<Env, Partial<Record<ChainKey, number>>> = {
  testnet: {
    L1: 40161,    // Sepolia
    L2: 40245,    // Base Sepolia
    L2b: 40231,   // Arbitrum Sepolia
  },
  mainnet: {
    L1: 30101,    // Ethereum
    L2: 30184,    // Base
    L2b: 30110,   // Arbitrum
  },
  dev: {
    L1: 30101,
    L2: 40161,
    L2b: 40231,
  },
}

/**
 * Reverse lookup: storageChainEid → chainKey for a given env. Used by the
 * CLI to translate a Network's on-chain storageChainEid into the abstract
 * chainKey it needs to read deployments[env][chainKey] from.
 */
export function chainKeyForEid(env: Env, eid: number): ChainKey | null {
  const envBlock = lzEids[env]
  if (!envBlock) return null
  for (const [key, value] of Object.entries(envBlock)) {
    if (value === eid) return key
  }
  return null
}
