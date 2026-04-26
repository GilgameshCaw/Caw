/**
 * Deployment manifest for CAW Protocol contracts.
 *
 * MANAGED BY: solidity/scripts/deploy.js (after every successful deploy run).
 * READ BY: cli/src/steps/* (resolves the operator's chosen client to the
 *          right per-chain addresses, then writes addresses.ts).
 *
 * STRUCTURE:
 *   deployments[env][chainKey][contractName] = address
 *
 *   * env       — 'testnet' | 'mainnet' | 'dev'
 *   * chainKey  — 'L1' | 'L2' | 'L2b' | future 'L2c'...
 *
 * One client = one storage chain. The CLI looks up the operator's clientId
 * on the L1 CawClientManager (getStorageChainEid), maps the eid back to a
 * chainKey, and pulls THIS client's CawActions / CawProfileL2 / etc. from
 * the matching block. addresses.ts ends up with singular constants — the
 * call-sites in the rest of the codebase don't have to be multi-chain aware.
 *
 * Per-chain contracts (one entry per L2):
 *   - CawActions       (storage chain — receives action submissions)
 *   - CawProfileL2     (per-chain balance/auth bookkeeping)
 *   - CawActionsArchive (storage chain doubles as archive — see deploy.js)
 *   - CawChallengeRelay (storage chain's relay for fraud proofs)
 *
 * L1-only contracts:
 *   - CawProfile, CawClientManager, CawProfileMinter, CawProfileQuoter,
 *     CawProfileMarketplace, CawProfileURI, MintableCaw, CawProfileL2_L1,
 *     CawActions_L1
 *     (L1 hosts a co-deployed CawProfileL2 + CawActions in bypassLZ mode so
 *     a client can pick L1 as their storage chain. L1 doesn't get its own
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
  CawProfileL2?: `0x${string}`     // On L1 this is the bypassLZ co-deployed mirror
  CawClientManager?: `0x${string}`
  CawProfileMinter?: `0x${string}`
  CawProfileQuoter?: `0x${string}`
  CawProfileMarketplace?: `0x${string}`
  CawProfileURI?: `0x${string}`
  CawFontDataA?: `0x${string}`
  CawFontDataB?: `0x${string}`
  CawBuyAndBurn?: `0x${string}`
  MockSwapRouter?: `0x${string}`

  // Per-chain contracts (present on every L2; CawActions also on L1):
  CawActions?: `0x${string}`
  CawActionsArchive?: `0x${string}`
  CawChallengeRelay?: `0x${string}`
}

export type Deployments = Record<Env, Partial<Record<ChainKey, ChainContracts>>>

export const deployments: Deployments = {
  testnet: {
    L1: {
      MintableCaw: '0x56817dc696448135203C0556f702c6a953260411',
      CawProfile: '0x14FFACEB52025d2A04f3FA997e3946b17eB28aF2',
      CawProfileL2: '0xfB9D00d70C747995f2c9D3b31B998bC0C218A399',
      CawClientManager: '0x4524922C4614DBbb79FCcdce6d2c41CaF563FE04',
      CawProfileMinter: '0xbacef3De5A2c8036268df5a59c3cce2fbd533883',
      CawProfileQuoter: '0x92A2d161c13539eD7646e0BE5D464495DddfeD17',
      CawProfileMarketplace: '0x5696675aB8e8E82cBe46C805F47875CF836bFd2A',
      CawProfileURI: '0xfD3dC7f5337e5f5b3D532305c915B072fb75bc21',
      CawFontDataA: '0xf0Fe84e0F72680529386DF570B26F1D143Ce92CA',
      CawFontDataB: '0x70C7C2209d2ad77C72C2E0a03B10cb47f24e8222',
      CawBuyAndBurn: '0x102b60a0DC5646eFdFDC891Fe46495B5dAAbAaB8',
      MockSwapRouter: '0xc13fe90EDFC5bDe4d48ed8Bfc887a8C9b9d1bcD4',
      CawActions: '0xaEE8a40EEDe3c17dA85339F97472c32618AEa905',
    },
    L2: {
      CawProfileL2: '0xB379a474C770CB5e7657C8EcC0FF2f7D2863b5bb',
      CawActions: '0x701Cae1460569acc64d69B0B757AE847E1565B94',
      CawChallengeRelay: '0xBE2329e895e0c8e2934c8b3096445c9a11C99d49',
      // CawActionsArchive: pending — Phase 4 of next deploy run.
    },
    L2b: {
      CawProfileL2: '0xcD049777d2f9951eE62C2D8D4c23A154BC9D2F86',
      CawActions: '0xFa22Bd6811d204beba9388549D1d7BFe485d9903',
      CawActionsArchive: '0x78569305b07972350fF55e1aa5d399ADC9dCdDA3',
      // CawChallengeRelay: pending — Phase 4 of next deploy run.
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
 * as the addresses above so the CLI can map a client's storageChainEid back
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
 * CLI to translate a client's on-chain storageChainEid into the abstract
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
