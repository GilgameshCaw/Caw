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
      CawProfile: '0x9c3b63CB5fbAEDfACA657d6e0D00d718De3895d4',
      CawProfileLedger: '0x6AF1e13a6d5a50da52216709B6d4db779E45Cd14',
      CawNetworkManager: '0xDd2ff580cc167677d5Ba1e65F7F0486Ea9337051',
      CawProfileMinter: '0xE0afde7666C0c2fC42789b588B0eE0c15788ADfb',
      CawProfileQuoter: '0xdeAE552BbB861017744f85ec0CC792480d5B21b7',
      CawProfileMarketplace: '0x2e404d2072E41D1904584cf65EAA5342a00b9747',
      SmartEOA: '0xf9CDe52d39232d1cf5C434017EC08Fa9A08571fF',
      CawProfileURI: '0x474836c537fFF1ebd43e79E9D6174F87828851A8',
      CawFontDataA: '0x3e01c2d1311FE79C43Bb8Ae5BD44d80c8E36b6FD',
      CawFontDataB: '0xfB850C0B6C7ce039Eb1Bf6ea261E85C04a23A646',
      CawBuyAndBurn: '0x3799E5c6618Df9f17f245989640Ee13f5425BFC4',
      CawActions: '0x65e8BA0dCe43d5CE6a0caB8294aF2f408De019D8',
      CawActionsERC1271: '0x7f3800b99c4B50206C81C5F943d00b6E050e0228',
    },
    L2: {
      CawProfileLedger: '0x7035Ce80A7E0eEf7dD57FFCE340CF43d36Ce3Ea5',
      CawActions: '0x35226b1c61f925594434fB4C484e05841C07fdED',
      CawActionsERC1271: '0x486435C9E28D337adC7307f9D90485241A9FFadd',
      CawActionsArchive: '0x537cF317c744a720841593119D141a185D7dcc07',
      CawChallengeRelay: '0x9d356e810A244d63Eb9803f770D700ea7c60b923',
    },
    L2b: {
      CawProfileLedger: '0xd4577f60a22F6119719df4e1eD355B8Ab0cC5261',
      CawActions: '0xF4aa48b241c16B042f1b440dB96eeD0a304031a8',
      CawActionsERC1271: '0xcf7e3bb1b5721e86d0e262F8E4160e5413E95de0',
      CawActionsArchive: '0x677F02B1fe32B8D00FDce72C7c5e901C88ED9c36',
      CawChallengeRelay: '0x1377592C2C5d32Dcc79668edfe0d26747A1EaA27',
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
