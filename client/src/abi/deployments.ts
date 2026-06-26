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
      CawProfile: '0x4F853523102577dDaf5fdbc823EDdCB13b35C543',
      CawProfileLedger: '0x51c25d5DDA39bA91f1750Ac227C368fe9fD44CB6',
      CawNetworkManager: '0x2Ce2d752675bf1Ee927D71090Fba50348B4BBB0e',
      CawProfileMinter: '0xe6eF1c8705a28DF44FA5F04c8B282b545A454Fed',
      CawProfileQuoter: '0xB5E6415EDffCe9480dB1188125cd45abe0Bd501F',
      CawProfileMarketplace: '0xD9b3dAf889D0e244de3B2137Eb78eb668455cA7D',
      SmartEOA: '0x2e1B89a71E7dDebb01a36292ba705ac52FEBbBF0',
      CawProfileURI: '0x6Ed996BAA347F747aB5B0Dd377ACE963725bC783',
      CawFontDataA: '0x7b09b65253A887e6F820a84A7b5785Aedc3c2d5f',
      CawFontDataB: '0xd1989b417eF31a661fe417596aCaEcD1Af38d2F9',
      CawBuyAndBurn: '0x300F761743540f6583CD9227E03Aedc82C477FEF',
      CawActions: '0x754058427A709991aA66DA90fFA0FFA80b2DFc92',
      CawActionsERC1271: '0xE75F262AF4767C162FA94EcBd624437004B5a99C',
    },
    L2: {
      CawProfileLedger: '0x087C09E919d91fdD6e3f1Ac2cEFA1Bd13c15934F',
      CawActions: '0xb7ec5e9999b73154E430570836b02BA70Da17dC6',
      CawActionsERC1271: '0x0BF14cAb1256960093248A603c9607C1F62742A2',
      CawActionsArchive: '0x82d6618f77E3B11bc181911BEf28d7471006b91f',
      CawChallengeRelay: '0xFa10e5957619F768d4313C3E6704b972a720BD87',
    },
    L2b: {
      CawProfileLedger: '0x287113f288D93E1243e779A520d18f930f4b5A0A',
      CawActions: '0x6ed6221E1D422bfc9b6C15F07BB9D38C87b98903',
      CawActionsERC1271: '0x2cf3FDC6c9e87c17bCb7dCd316740a886C852e3b',
      CawActionsArchive: '0x4DDBF2cB960C6B38B72e554Aa619450b265c704e',
      CawChallengeRelay: '0x52419e528068D6Bb8dfC3F13723bA09936Ee3ec5',
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
