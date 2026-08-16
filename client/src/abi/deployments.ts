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
      CawProfile: '0x3BA577936Ff6Cfe07DC2D00e6669436C6Dace319',
      CawProfileLedger: '0x617Ef7b3CeD96D277693C530DA3eA410de92df72',
      CawNetworkManager: '0x35c27e4bCC13101Acdf6418DeDEd99ccD3838075',
      CawProfileMinter: '0x5613353c6B6F55fBc82487D36a5316A2cAdE7Ee0',
      CawProfileQuoter: '0x66da3A1fd97c175f74e5f3Aabbe630B08f2c6c8a',
      CawProfileMarketplace: '0x858F60fC71bAfBdC6Ba170aCC7dc8974F6270CBD',
      SmartEOA: '0x918082aB668D7661bCe65C3CAAF047648f7D4271',
      CawProfileURI: '0xd91AF2c28faF3561274d12f5CD62e7E65Ae9ae7B',
      CawFontDataA: '0x43840B562b412B59741B20BAB7FAa06569ff98Fd',
      CawFontDataB: '0x6df9f0a1A98006eBEc92A4e789662e6343445e19',
      CawBuyAndBurn: '0x008e096877Dbf12fa5c0F07489855adE3874b4e7',
      CawActions: '0xe33339b3D826E7fC61557D7e82A4348710790136',
      CawActionsERC1271: '0x2418592Eb4bd5212b3c64408769f95F73dCb45c6',
    },
    L2: {
      CawProfileLedger: '0x93593A023629EB84B389770d76A81C5f982F02a9',
      CawActions: '0x73246104f57001EDC6d0659Fa37Afb672a76E763',
      CawActionsERC1271: '0x78AB5d7be8Ba2BC722f58B862c16Ee77fEcbCF74',
      CawActionsArchive: '0x2423D40BB16FcFe71821E24ae507746dc7449F74',
      CawChallengeRelay: '0xeb8ee1EB63976631bdaD061AFB04d0e4329e11E7',
    },
    L2b: {
      CawProfileLedger: '0x2B7f85B2f28d9d691947498FA8aE8eF8F4317197',
      CawActions: '0x5D35790EE0E3f1641aea635C11882C4a9fca23a0',
      CawActionsERC1271: '0x5F41CB93b2a95aC6A77A4d73043dEB244EA3802F',
      CawActionsArchive: '0x3B526a24a740F8FD5Ed9688E109414Ec10786B8D',
      CawChallengeRelay: '0x10723C6e9fD79683143564df246Bf17870eff20d',
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
