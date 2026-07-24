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
      CawProfile: '0x61C07717210988df782E779cAc8AC67633Ed2a2e',
      CawProfileLedger: '0xdbBE199f301AF59f471A586975e2Bc64b57F917f',
      CawNetworkManager: '0x2Ce2d752675bf1Ee927D71090Fba50348B4BBB0e',
      CawProfileMinter: '0xDA1F1c34Ed283C7aF358Fbb2d2A3A1A27C5Ac1D7',
      CawProfileQuoter: '0xF7b06c7F266fF1bEA86Cab27d1cEE8E0a1f5Ae90',
      CawProfileMarketplace: '0x6056d828d1bFCBDC2DD6443DbDCF44b709f21a0b',
      SmartEOA: '0x2e1B89a71E7dDebb01a36292ba705ac52FEBbBF0',
      CawProfileURI: '0x6Ed996BAA347F747aB5B0Dd377ACE963725bC783',
      CawFontDataA: '0x7b09b65253A887e6F820a84A7b5785Aedc3c2d5f',
      CawFontDataB: '0xd1989b417eF31a661fe417596aCaEcD1Af38d2F9',
      CawBuyAndBurn: '0x300F761743540f6583CD9227E03Aedc82C477FEF',
      CawActions: '0x5158eD62E9cB57F2Ddd38B2D841589E4033CCcCc',
      CawActionsERC1271: '0xE75F262AF4767C162FA94EcBd624437004B5a99C',
    },
    L2: {
      CawProfileLedger: '0xee2B2E2dE111942b8a1980836894aB1FDa765f24',
      CawActions: '0x106e1895c1aa7D6B044c50d7c7F04a46Ea4CABb7',
      CawActionsERC1271: '0x0BF14cAb1256960093248A603c9607C1F62742A2',
      CawActionsArchive: '0x82d6618f77E3B11bc181911BEf28d7471006b91f',
      CawChallengeRelay: '0x9A3bE72fEe5f5f7b259FB2889e2F65CDf7380D57',
    },
    L2b: {
      CawProfileLedger: '0x7E10b26635fC907774798fd30cB76AD1777A502A',
      CawActions: '0x9e1F62917D9f5D6dc83917565c4e8cbC2BDf6AF2',
      CawActionsERC1271: '0x2cf3FDC6c9e87c17bCb7dCd316740a886C852e3b',
      CawActionsArchive: '0xEb0fD584bd1E5793e7fe9eDA33FCA4BEFd65937f',
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
