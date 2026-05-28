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
 * chainKey, and pulls THIS Network's CawActions / CawProfileL2 / etc. from
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
 *   - CawProfile, CawNetworkManager, CawProfileMinter, CawProfileQuoter,
 *     CawProfileMarketplace, CawProfileURI, MintableCaw, CawProfileL2_L1,
 *     CawActions_L1
 *     (L1 hosts a co-deployed CawProfileL2 + CawActions in bypassLZ mode so
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
  CawProfileL2?: `0x${string}`     // On L1 this is the bypassLZ co-deployed mirror
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
      CawProfile: '0x0C9F467A4ef611B8A9bbbDbb82481741e8B1Cdd6',
      CawProfileL2: '0x22166Eb917F771F07a462AB44c1090FBBC99a2fA',
      CawNetworkManager: '0x074Ab61e1D1E43204439F7A78E92416f917680F4',
      CawProfileMinter: '0xe008D47c28731cF13e66db17a63F2DE91b036d1F',
      CawProfileQuoter: '0x7fDc54A0131C06e6911df0656D73a17875839494',
      CawProfileMarketplace: '0x5b2fd5195bEc0C747C9B0EeB1722C9Bf718248cF',
      SmartEOA: '0x300Ae0b250508Ab5e5Ec2e305adFB06803B3c425',
      CawProfileURI: '0x049e77e5637181F9C6Aa4CDCb687e61eB9581ff6',
      CawFontDataA: '0x5BD32Be077B5879f7bf4264ffFf0103bA545ED04',
      CawFontDataB: '0xc27f2DFeddE5F99ecbA99284C6F5bA34D3A74D70',
      CawBuyAndBurn: '0x90b3dF047C5e2631405De145EC6a474750D4453C',
      CawActions: '0x12908f2f26227D834706ef496fDe6E1a912Ef3ed',
      CawActionsERC1271: '0x60808e021DC0800C681233ad863a78F519c85F20',
    },
    L2: {
      CawProfileL2: '0xe4046A1d858f662A8f7520bEf6B2501e411926F3',
      CawActions: '0xB39A290fE77B9580F346B35d0Ec675C7839228b1',
      CawActionsERC1271: '0xB2f892126a8569C120F2b8EFE85A6b5FbF218944',
      CawActionsArchive: '0x84BEB58f91a7c2F4336620ACDBb919750Ffd6fA0',
      CawChallengeRelay: '0x767f32534B37972F9C2995B431581313dd5e6fC9',
    },
    L2b: {
      CawProfileL2: '0xae17761dEf8dD1DAC774043df22985881FF0bF1C',
      CawActions: '0x3B75FB793608302f9371323a8aF731b52e2636BB',
      CawActionsERC1271: '0xc88f44E2bdC41E3946D17320cB76D25ffEf6424B',
      CawActionsArchive: '0xB4946e9229A49a7d5F7F3480b0A34FAc4b836fd7',
      CawChallengeRelay: '0x6B44B371c4727Cf2B81CB5780B488C3c34605bD0',
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
