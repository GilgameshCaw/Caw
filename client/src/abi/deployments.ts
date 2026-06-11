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
 * chainKey, and pulls THIS Network's CawActions / CawProfileLedger / etc. from
 * the matching block. addresses.ts ends up with singular constants — the
 * call-sites in the rest of the codebase don't have to be multi-chain aware.
 *
 * Per-chain contracts (one entry per L2):
 *   - CawActions       (storage chain — receives action submissions)
 *   - CawProfileLedger     (per-chain balance/auth bookkeeping)
 *   - CawActionsArchive (storage chain doubles as archive — see deploy.js)
 *   - CawChallengeRelay (storage chain's relay for fraud proofs)
 *
 * L1-only contracts:
 *   - CawProfile, CawNetworkManager, CawProfileMinter, CawProfileQuoter,
 *     CawProfileMarketplace, CawProfileURI, MintableCaw, CawProfileLedger_L1,
 *     CawActions_L1
 *     (L1 hosts a co-deployed CawProfileLedger + CawActions in bypassLZ mode so
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
  CawProfileLedger?: `0x${string}`     // On L1 this is the bypassLZ co-deployed mirror
  CawNetworkManager?: `0x${string}`
  CawProfileMinter?: `0x${string}`
  CawProfileQuoter?: `0x${string}`
  CawProfileLens?: `0x${string}`
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
      CawProfile: '0x21016F5c0FeA1C2698a73E2537582b02C983654e',
      CawProfileLedger: '0x59A373efed45427b4bBcfc5896c799AB470Ca2d6',
      CawNetworkManager: '0x3d6345052af8B371D4708Cf6d3601d8FbC8b7Cf4',
      CawProfileMinter: '0xe2b08548D023741e77d60741B9Cb83d8758C7BAD',
      CawProfileQuoter: '0xa336eBE60369f7deDc2F45aCd87349f4717b62fd',
      CawProfileMarketplace: '0xBfDc3b96030D4712d4CaF2E7deD754e37892CAED',
      SmartEOA: '0x1c5452f5101219fCC4a68E19B0B3D388C719E6C7',
      CawProfileURI: '0x6C8a88966ec4D0B2D065605114679443472B02c5',
      CawFontDataA: '0x02cdC50b337a075e9b3BDb1BFDe97F4f6989E2a1',
      CawFontDataB: '0x0DAc9CFceB54FDa5d946698d2Ffbd844f7d4e3A3',
      CawBuyAndBurn: '0xd288E1759bFf220B80D642E317d01d0753d767F3',
      CawActions: '0xd5d90DD7BBF215D36727D2EffE3b9C3465cD80d7',
      CawActionsERC1271: '0x2aDb645091Ad77EcB828CeCC30056A0D995eE592',
    },
    L2: {
      CawProfileLedger: '0x8859599049c7ae5Eb265B047B6c3e04DdA9AAB7D',
      CawActions: '0xC1cD691301Ad7967C5883A5e9050a505097E3595',
      CawActionsERC1271: '0x3269d6eF8b2a97192a38C50f9f3755d2D59B09f0',
      CawActionsArchive: '0x4D54131a8121638916bd406644c0e6bAc3cB3380',
      CawChallengeRelay: '0x00Cc477d22C31F6eE9928Ae2dF13eef265b62a00',
    },
    L2b: {
      CawProfileLedger: '0x9f315dd3a7dFCd852e8096e5d0F6e84F514fbb35',
      CawActions: '0xf0e0dD13774ba22220ae3294b3012A76889Ac652',
      CawActionsERC1271: '0x6b24d277c136CAc5b5b2a1470Af2C4646cbd1153',
      CawActionsArchive: '0x1a91B902bDF0630dFFD32b336646E381CFF2bFD7',
      CawChallengeRelay: '0x99A86dC4F1e7b3Ab0C1937A607149739b4Eb160e',
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
