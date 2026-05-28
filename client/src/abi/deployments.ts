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
      CawProfile: '0xe57791977a5a4EC22Dfde604C67F66A4B42a6362',
      CawProfileL2: '0xC37f17BE926e1bFDB1e2D7e2e099715C4B0C2322',
      CawNetworkManager: '0x6454E37eAe60438DF4a619B6e6ffdEed987Cd706',
      CawProfileMinter: '0x49FE24634a8a14Ba7e8C6F28365F67C867fbCB13',
      CawProfileQuoter: '0x055759486178b7DC8D18f216C3B598b46e0f03E2',
      CawProfileMarketplace: '0xEfe905751798B2170CDD04c5Bc9ACAA5701CDD5C',
      SmartEOA: '0xB4911A185376f7988214c3c6Fdf5E14B05d712B5',
      CawProfileURI: '0x1b35E41551117c2E472Bd0E2D25DC82dDaE1b294',
      CawFontDataA: '0xB7aB740c8ec839F0aDa261e428c8750b3357Ce41',
      CawFontDataB: '0x5acBCbfb86Ed9446f090BA401b83bC27a844bC81',
      CawBuyAndBurn: '0xA78A8597f5F866F884C2a834F26763D181bfc9bB',
      CawActions: '0x90627378f24A79b9f41465BB7b4364e98Def6420',
      CawActionsERC1271: '0x2644A9dEd9555EEbAcc150F3C1947e576569a2Aa',
    },
    L2: {
      CawProfileL2: '0x1Bad9c3D16aEb988206c5f7eBA3154BFFa5d94d0',
      CawActions: '0xc434874E80aC9B2Cda6B019978720f2e29BAD759',
      CawActionsERC1271: '0x0b0A7AbBE98468D63255624668522f5Ec89ac5BC',
      CawActionsArchive: '0x605Aa1F8bBcbe1d52FD176e3B3b77833d91D495D',
      CawChallengeRelay: '0x09618138943087E8b6aBCC15c3366561710F64E0',
    },
    L2b: {
      CawProfileL2: '0x284149508AaB9bdE4a06f13281AeE96eaeF31cB1',
      CawActions: '0xAd92d6795fCF785961Df1b3728c61858c2335510',
      CawActionsERC1271: '0x5C2027C54a83f5209Bc2f23382335020a69f665A',
      CawActionsArchive: '0xdCc627038777D5216CB74A6B4ED6FC45188Cf825',
      CawChallengeRelay: '0x632751178E80f40d52D57523cFB02E5876944bC2',
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
