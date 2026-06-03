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
      CawProfile: '0x773E40F664F4EC059d6f1a25eD5d42A8EfcE7e59',
      CawProfileLedger: '0x17f12c59E6A17e49C9c3E4eB8EfB2896c9c29Ee7',
      CawNetworkManager: '0xa8016B714122d588294D4abDa3d9f11B065e0F06',
      CawProfileMinter: '0x9b5A9Ad2672EdC0F980E325efdEdC5A40287c77a',
      CawProfileQuoter: '0xD37a0f1518D7096cbB737a90EfBd7d251fe81A13',
      CawProfileMarketplace: '0x59C95A3161878C7a876AeAABabdbd95Ed269454A',
      SmartEOA: '0xb3fF59926e50596C1563BB703455050256E70951',
      CawProfileURI: '0x79C7Ba1A263B051C994e4829F46Cffc2B97249a0',
      CawFontDataA: '0xEc2C90F75b8c4e1B1265922fff161Ac45F307b55',
      CawFontDataB: '0xDBeFa5E27A28D2a2710D168F4Ea86FF22B6A6643',
      CawBuyAndBurn: '0x10D792D2aA80dbEBA85b51d88e685c7fC8eC5DB3',
      CawActions: '0x89009adC3799649D71A1FA9b09Da5752CE8084fc',
      CawActionsERC1271: '0x9801aAFBD42Be517Be4cab60C0211ff8d7b47FE1',
    },
    L2: {
      CawProfileLedger: '0x07C0b03f58B16aB95fa7f8842ea0031A811f69a1',
      CawActions: '0x93C2DbB6e75d00f472dE3Dc3b1909Fdd845A16a9',
      CawActionsERC1271: '0x696E2EcC9BAD57DFE79c5ACb9CA585D88180f159',
      CawActionsArchive: '0x6F112a3DF289b4B870E802ca4fd2165E8EA550A6',
      CawChallengeRelay: '0x32CF7AeC6532812Cd96eF53815C636bB1a58352f',
    },
    L2b: {
      CawProfileLedger: '0x65A68eb9df2aECa49D598016F8F49a7EF9F9A640',
      CawActions: '0xfAaD4D37051815A5f99491Ae53f633A07b1b752C',
      CawActionsERC1271: '0xAc81C1888587C8E18320088Fa11E8a74C38bFB14',
      CawActionsArchive: '0x22c71864314e1Ee78CB2495d7819f6b56F0A13cf',
      CawChallengeRelay: '0xE4E30801cb934d91f8E2ac4c5b2A30fA61c8dC3A',
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
