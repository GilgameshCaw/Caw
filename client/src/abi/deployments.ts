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
      CawProfile: '0x68667fe0916d851356B4D5476d4aDEBBD0Ec6288',
      CawProfileLedger: '0xeD96d1053Af0bE6fEb133237506De718b42c9453',
      CawNetworkManager: '0xE2531C75A4AdA5736898f844Ce60b3e3470Bc765',
      CawProfileMinter: '0xa7bB3f84d1A639460b3Aed31EA9E13978D2d8CD0',
      CawProfileQuoter: '0x6ea5a02d5DfA104228AEa8FCa7f7FedB291Dc08F',
      CawProfileMarketplace: '0x9aE526919591a167a60BFE096A923b1853c9aaDb',
      SmartEOA: '0x211Bfc2c70e49c7973B6d4d2000D9368537a8D38',
      CawProfileURI: '0xE73CE6dA80dDF3475f72cA142a52A794D77d4a33',
      CawFontDataA: '0x3c77eBC39Db7715Ca6FBcFeC0C2858e0D4ef2188',
      CawFontDataB: '0xe81c28578414Cd4adD61C5A7e526E86dB3C28186',
      CawBuyAndBurn: '0xeCfC3fCE0606CB761bAAeCdB4708Af6514050Ac5',
      CawActions: '0x85899774ddc650aA1CF69b2a35965815BC5DBfE5',
      CawActionsERC1271: '0xb3D80DdC0BA7e394F646c1cA41C574EcE4E2BFE0',
    },
    L2: {
      CawProfileLedger: '0x99A037A6eFa70B2fA77192d3773c7eae5cAc2187',
      CawActions: '0x66b23fEEbf4FFA0c1B1f1Cf792026d71B88880C8',
      CawActionsERC1271: '0xbb27459E986EfEdFf185276CB91AE74a4F24b70e',
      CawActionsArchive: '0x2C3b5cd8F5d6997274510bF1Aac885Bc083ee069',
      CawChallengeRelay: '0xdB01756BC72e47aC44e2B4363281eB4a0493c040',
    },
    L2b: {
      CawProfileLedger: '0x77d07860e5e473e86D62fd8d68b4bE0ca4f275C2',
      CawActions: '0x5FCd3ae069Cf7fA960967Db97b334C4981C00EB1',
      CawActionsERC1271: '0xC5c4198aC9eBE97B577D077489D9F226e0857CCe',
      CawActionsArchive: '0xBc6A5eee4722101FcAf3d006c781B0DBd247EACd',
      CawChallengeRelay: '0x516860bE34e949836F507E708c87D441dfef81bF',
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
