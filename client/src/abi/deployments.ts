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
      CawProfile: '0x5c9Ad791e4f468dc4D407f934Be2c33387CBD736',
      CawProfileLedger: '0xf17B25dF03e248319ECd3511F104B43ed3791272',
      CawNetworkManager: '0xeC7464d0a7b59ca76Be67d3D158d8a4C58C05463',
      CawProfileMinter: '0x2BA12B8e58Ce80579F663a3a5D53A2d1A8698244',
      CawProfileQuoter: '0x9ff410E19dbf8cf5D227911f9aE4A89cfC00a332',
      CawProfileMarketplace: '0x9Fd61927023DD2b4bcc060AD4bcf50562bC04400',
      SmartEOA: '0x49cab45e98D2835939155E095994Fa97deB4d872',
      CawProfileURI: '0x84B45F31F8869D95fA83F1f8422eDeA8d7536bE2',
      CawFontDataA: '0x2a93b87881bc2C6375F4011C6bE4B516006F4B0d',
      CawFontDataB: '0x76AA53dac02A8448679686947b6AB3E2E3eD6b7e',
      CawBuyAndBurn: '0x9C804d596C64Ec3Ab38c17474c74daBC18574D2a',
      CawActions: '0x914871d4BC9Db62116BC639B113A3a272EcE8E01',
      CawActionsERC1271: '0x22B31A7F4DEBdBd5eD94e00F31D148D906c98426',
    },
    L2: {
      CawProfileLedger: '0xFCeF600b64198eeB6787B9836C3BBAedcff4C267',
      CawActions: '0xB7E09a05073169Ea4a119294C974401D1efC2Ab1',
      CawActionsERC1271: '0x8544053749A674C7EbeF3Ed51856cb97C6610Ae5',
      CawActionsArchive: '0x77D08cA4Af27183808c9a65c15AA7907Adec1b34',
      CawChallengeRelay: '0xeccFc6Ab0B661689e224138c5429361131EE8f3b',
    },
    L2b: {
      CawProfileLedger: '0x5CB9bFb660e70f70Cf37470E86966e2191146cf4',
      CawActions: '0x246f6E29Cf1Fd130Fb4De879E8840bfE506e1F24',
      CawActionsERC1271: '0xba5d89f87f2c24E4880ed5705474D94b9d2A8F1b',
      CawActionsArchive: '0x7F04E80F05C67258f6229c5175DE11e15cA3D54A',
      CawChallengeRelay: '0x64672192523eFA2c56e6262775Dee0def1f4378B',
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
