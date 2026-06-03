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
      CawProfile: '0xD664324637115d1191c9Cfe16B16852a67e86374',
      CawProfileLedger: '0x6A9Ec77500eabD0F65c5612974891a5f9D7d35ac',
      CawNetworkManager: '0x3F9a5EC7aEc69dA70eCa54ED9f2EcE04862D9050',
      CawProfileMinter: '0xFd8D322F55726c0Ae2969c3ca1D1B507207276a2',
      CawProfileQuoter: '0xE9a908267266fC4808bF9Cf9E66DC41759f121Be',
      CawProfileMarketplace: '0x54B61222313a8774684BEb89f5772e8Fb908352c',
      SmartEOA: '0x1902E86f2494B13784b3372490638771178fBA29',
      CawProfileURI: '0x16fF9bbfa92c75131462a2E559DCcF95Be1Fbd8b',
      CawFontDataA: '0xEc3E9F72D0fd356fF7C7395805fc765A4082b8dF',
      CawFontDataB: '0x77392D797877374231fFB8e3E2Dbf1ab044Bd745',
      CawBuyAndBurn: '0x5a65bCF1885b5dAB34c9c26361c2DFE2Ba63C648',
      CawActions: '0x02776EBA128e2A1D6505BfC1B2f15025Fe7E6Ab5',
      CawActionsERC1271: '0xD6D3c9c504B52f63E496e4fB61adae3826CC80B5',
    },
    L2: {
      CawProfileLedger: '0xdDe8aFEb5bdc1DdBf14373B9b9a2945955B355b0',
      CawActions: '0x7787102b45eA7ace5090Ed006cE1d9E73843a4CF',
      CawActionsERC1271: '0x292E175f71d6c54541aB6b9F29bC4e19FF1Fb1fB',
      CawActionsArchive: '0x6391CE04740CB93F99E2099F154b877d3CA45e10',
      CawChallengeRelay: '0xd18dcd3EeB23b9E150F4538b8cD3c64f39a82Fd8',
    },
    L2b: {
      CawProfileLedger: '0xC70a3d7bDDd84a917826fAac7be085De6b9FF868',
      CawActions: '0xDCF76ce65A0D7A60560606A584A084043787eD92',
      CawActionsERC1271: '0xBb68556cfd875D121615eEb1925b09622B2fE97F',
      CawActionsArchive: '0xdc9543845A73F8C86DeA6982cDDD4913fd17A903',
      CawChallengeRelay: '0x73677eCCA1a32Aa0418D3171A772286Aa3453b94',
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
