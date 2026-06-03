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
      CawProfile: '0x8E894F432BCec06E000e99028aeB606B91DB409B',
      CawProfileLedger: '0x85b0f85DEe5eA86Fd16DD4418dDB5bCa1Fbd693a',
      CawNetworkManager: '0xe97Dd35E7Bb6c9Dcc3f9351803D71D4d1498648D',
      CawProfileMinter: '0xd53C25cb58072D871D808e7eA252BCC635EAcBa8',
      CawProfileQuoter: '0xF5C3a82b3CCCB0a6e3Ee70E797c87909a5366686',
      CawProfileMarketplace: '0xccA9998f76c2F3b424127Fec53Ca8C7bd3782033',
      SmartEOA: '0x0cac4995FCEc670fea7B8CEaC7C7c70573510A13',
      CawProfileURI: '0x388B72f4aec7B9563327079fb1F3694aD4Ac429A',
      CawFontDataA: '0x30e9752186854Cfd7E46C0487c43aeDA2BaAdc5a',
      CawFontDataB: '0xa5052d62A86c1803B78c2Df20629e23D25f66019',
      CawBuyAndBurn: '0xBA76DF1f2651d85910AE3A2d8D68c0342A6e1cb5',
      CawActions: '0x59Ca290FCE7e8203335A1EF887B3bB6eCAF2C7f3',
      CawActionsERC1271: '0x6DCf7C33e765D525047E52b13A2DD55fA88A896C',
    },
    L2: {
      CawProfileLedger: '0xe0A701C4eD80D0a08d316bfBB7BB0717CAb88338',
      CawActions: '0xcb4afF5CEe90998CDbCCAFe8a84D24D0a4F6B89d',
      CawActionsERC1271: '0xF0fB48d43E44b73ECa21DBF5270215a191a9Fe39',
      CawActionsArchive: '0x25e2dDD7fd841cF6eF35330DCD9371c575477E13',
      CawChallengeRelay: '0xb0D4a13b7Df875048ED8c650FE90956876Cd2812',
    },
    L2b: {
      CawProfileLedger: '0x93E4Ef2909Ed20BA748a447D277e74615f83B756',
      CawActions: '0x609A60AF438d45AD06Cb8c885DeDD2814ad535da',
      CawActionsERC1271: '0xb78cCAd2224FF9FF29D6453EF4EEd612f149D389',
      CawActionsArchive: '0xDDa2326ecD403dC34Fd9d35367B91401817ded0f',
      CawChallengeRelay: '0x6ecBDF6B035451fB2Ec9978813265DB26696434f',
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
