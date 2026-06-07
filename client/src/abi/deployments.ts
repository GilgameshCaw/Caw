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
      CawProfile: '0x62A5E43306B2a8b909d9E1aFc880272EDa24E0e9',
      CawProfileLedger: '0xAf6AB0E0765Fc73e8944D73296B14d7e80563f80',
      CawNetworkManager: '0xeCc4AD86C4213E54d1F328eda1E128E61EC68506',
      CawProfileMinter: '0x977e6D822290f36346118E819fdF77d9f410fE96',
      CawProfileQuoter: '0xbD354eC68E350b02A56453bA98b01f4Bc39b1b11',
      CawProfileMarketplace: '0xd72EFcf334b8992CA9D19a464d0993535C0fb20F',
      SmartEOA: '0xa8CD52F7590ae3198713e562a3315dD604d949D9',
      CawProfileURI: '0x8097261879875fbA2BB1EE6aEfC96834C6370959',
      CawFontDataA: '0xe0d5432976f4A3ef75De617B15FF6d4387F6390c',
      CawFontDataB: '0x22C9ED2dFd9987313C670F21bfCe381860402a9E',
      CawBuyAndBurn: '0x9a8D96b8cD15Accf544785ED958b013b5be2A46B',
      CawActions: '0xa86B3558078160821C4b5AFEdBC1146bFBBb76b8',
      CawActionsERC1271: '0x8102A68899418207eC2EA114f22a2Ec8081F6B34',
    },
    L2: {
      CawProfileLedger: '0xED1a265C498e576adcfc29a1063f7Ceaa3633557',
      CawActions: '0x2CEDf5AdDF076233D1BfD80F3e7a33a4Dd9AF789',
      CawActionsERC1271: '0x298aDA8120f421fBFC577eBF1eC7d3c16709F9D0',
      CawActionsArchive: '0x7377819Ce206241F20a922f25cc86Ed680525faF',
      CawChallengeRelay: '0xdD3BC568631C3AA5F3b095a99Ee4f9a100b8F546',
    },
    L2b: {
      CawProfileLedger: '0xDc2875708f56b5dD0E3E4034c6a3C0b5cb541Ba7',
      CawActions: '0x5e39b4e9A4C51b6E321BBF2d50A23baFc0DbE0F8',
      CawActionsERC1271: '0x9C77AAe845e0Dd2ccD44FC6BC40b59b197099aA8',
      CawActionsArchive: '0x5CABf6C36d88311C1Ba578900A3c27f6cceb32D6',
      CawChallengeRelay: '0x40419A78AB38807D3aD73330b01485b2c077fb46',
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
