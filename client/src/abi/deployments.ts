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
      CawProfile: '0x1f2835Da4c59dB04A3CDb8E5C337c0C0972EB8d5',
      CawProfileLedger: '0xeE49E323c3DB1B6F48B10fEaEe1237Ead448FAF2',
      CawNetworkManager: '0x2FefC87B2b30d67d0CacAFcfa246E1fdbc8DaEE3',
      CawProfileMinter: '0xB48b33318a88bC717C0bAeBa0AC2Ad00F9E97D94',
      CawProfileQuoter: '0x8594256946c1038c9A3F5Da6E4640Fa81C219E12',
      CawProfileMarketplace: '0x2C1Ca3E0CA22EEa41b13F9F207F16E10504e50b0',
      SmartEOA: '0x95B4012609014896B099B3DA3625D11A46f5aBC9',
      CawProfileURI: '0x7e76eDCf0AfC9504661FF92E17Bb2c275D108C97',
      CawFontDataA: '0xf1dDb0aF134eA95DA025E4f74926BBda43504497',
      CawFontDataB: '0x1cCfE0696c77f10486ce473fb1e7De2376A3A60d',
      CawBuyAndBurn: '0xAeBABe09618D7c81Bb0E29c63c65C3052682268a',
      CawActions: '0xcecB2D678518db15B74799DD773e12cE6820D425',
      CawActionsERC1271: '0xBE2329e895e0c8e2934c8b3096445c9a11C99d49',
    },
    L2: {
      CawProfileLedger: '0x026B649FB22b77D767F8Bd2867Fdc9858639fFE2',
      CawActions: '0xb445f98f301655871Dc1DEA3F84A16E2623c101c',
      CawActionsERC1271: '0xf93c648FFEe8005e4C7D3B686094BAC129646f3f',
      CawActionsArchive: '0x4DfbCb0bc26367DC5903f41744445777e8942C5C',
      CawChallengeRelay: '0x861287297C146805734907400C1162bbBDD7532A',
    },
    L2b: {
      CawProfileLedger: '0x22A6A38273744ab344b974347bf43ecEFAaB633E',
      CawActions: '0xfB98b5a65639fa105576b42DC4888ea15281e5E1',
      CawActionsERC1271: '0xA0Fa7764e3F5580C43d18050088Ea5D874502910',
      CawActionsArchive: '0x0709f866344B31509f748EA42ceEFbc160EFa716',
      CawChallengeRelay: '0x64dc784A20CDfe44B9c18435c97891D6C99266F0',
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
