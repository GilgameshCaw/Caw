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
      CawProfile: '0x6ADB4a3Acd80bB2105BD45F5009D08AEA445B3d8',
      CawProfileLedger: '0xdAF4783E70970F66A0a8474168C3562b6d713051',
      CawNetworkManager: '0x29a8EEABa4A632b2800Ade158239a93cca1234c7',
      CawProfileMinter: '0xE999711e90208E75E685192B3A1B7180e3Ce9bDa',
      CawProfileQuoter: '0xa81CF89C5Dce752815c5D3cA19CCB997528a2710',
      CawProfileMarketplace: '0x30e2a4f2cd6F74254672a6d6685A071961aFb638',
      SmartEOA: '0x2e1B89a71E7dDebb01a36292ba705ac52FEBbBF0',
      CawProfileURI: '0x6Ed996BAA347F747aB5B0Dd377ACE963725bC783',
      CawFontDataA: '0x7b09b65253A887e6F820a84A7b5785Aedc3c2d5f',
      CawFontDataB: '0xd1989b417eF31a661fe417596aCaEcD1Af38d2F9',
      CawBuyAndBurn: '0x300F761743540f6583CD9227E03Aedc82C477FEF',
      CawActions: '0x702BE289646D5736E7932f90486979F38ACF9034',
      CawActionsERC1271: '0x0731EEA09639713CB7cF574EcDD3deb34D31d86E',
    },
    L2: {
      CawProfileLedger: '0x4Bbd94f8368Da4e61bdeF6d8CE5C7FB72DeDD5b8',
      CawActions: '0x1c408187A1006c0906be68032D32D9d34971fDCF',
      CawActionsERC1271: '0xab3E75B931C1Bcd1A44c025Ba49b4B1afb9FFa46',
      CawActionsArchive: '0x26ed02EC62b2f54e591860d918336f70e3350340',
      CawChallengeRelay: '0xA66A3f644B5F6925E5B0cB712B203B39B70E293B',
    },
    L2b: {
      CawProfileLedger: '0xd83e9d38969613228971FC90b3b54E045e6BcC37',
      CawActions: '0x5Fbaa10e83C10Ce5768EA7ffc9b66f08ce5e0827',
      CawActionsERC1271: '0xEE2C3F0a6361B26eB790F1cD7210FfC33A687794',
      CawActionsArchive: '0xe86e00bBF10b2787a734e86623942f2DF0EACdA7',
      CawChallengeRelay: '0x0a379E89A90D375ccF7F326Af8FC56D76280a35b',
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
