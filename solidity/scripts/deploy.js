#!/usr/bin/env node
/**
 * Multi-Chain Deployment Script for CAW Protocol
 *
 * !!! BRANCH GUARD !!!
 * The contracts on master have been renamed (Client → Network) but the
 * matching ABI regen + FE/backend rename live on `contract-support-v2`.
 * Running this from master would write `CawNetworkManager` keys into
 * client/src/abi/deployments.ts and break every consumer on master.
 * Deploy must be run from `contract-support-v2` (or the eventual merge
 * branch) where the FE/backend keys also expect the new names. The guard
 * below enforces this — override with CAW_DEPLOY_FROM_MASTER=1 only if
 * you know what you're doing.
 *
 * This script replaces the old Truffle migrations (migrations/1_initial_migration.js).
 *
 * FEATURES:
 * - Multi-chain deployment (L1, L2a, L2b with cross-replication)
 * - Automatic retry with exponential backoff on failures
 * - State persistence (.deploy-state.json) - resume from where you left off
 * - Dependency graph - redeploy a contract and all its dependents
 * - Phased deployment across chains
 *
 * USAGE:
 *   node scripts/deploy.js                           # Deploy everything that's missing
 *   node scripts/deploy.js --contract CawActions_L2  # Redeploy specific contract and dependents
 *   node scripts/deploy.js --reset                   # Clear state and start fresh
 *   node scripts/deploy.js --dry-run                 # Show what would be deployed
 *   node scripts/deploy.js --state                   # Show current state
 *
 * ENVIRONMENT VARIABLES (optional - defaults provided):
 *   PRIVATE_KEYS  - Comma-separated private keys (defaults to test keys)
 *   L1_RPC_URL    - L1 RPC (Ethereum / Sepolia)
 *   L2_RPC_URL    - First L2 RPC (Base / Base Sepolia)
 *   L2B_RPC_URL   - Second L2 RPC (Arbitrum / Arbitrum Sepolia)
 *   L2C_RPC_URL   - Third L2 RPC (future, e.g. Optimism). Add an entry to
 *                   `L2_CHAIN_KEYS` below + a CHAINS entry per env to enable.
 *
 * DEPLOYMENT PHASES (generic across N L2s):
 *   Phase 1: For each L2 — deploy CawProfileL2 (peered with L1)
 *   Phase 2: L1 — deploy CawProfile, CCM, Minter, Quoter, Marketplace, etc.
 *   Phase 3: For each L2 — deploy CawActions (storage chain role)
 *   Phase 4: For each L2 — deploy CawActionsArchive + CawChallengeRelay
 *            (any L2 can be both a storage chain AND an archive chain)
 *   Phase 5: Full-mesh peer wiring:
 *            - L1 CawProfile  ↔ each L2's CawProfileL2
 *            - For every (storageL2, archiveL2) pair where storage != archive:
 *                CawChallengeRelay_<storage>  ↔  CawActionsArchive_<archive>
 *
 * ARCHITECTURE:
 *   - Every L2 in `L2_CHAIN_KEYS` deploys the full set, so any network owner
 *     can pick any L2 as their storage chain (createNetwork(..., eid)) and
 *     any validator can replicate to any archive (REPLICATE_NETWORK_IDS env).
 *   - Adding a new L2 = append to `L2_CHAIN_KEYS` + add per-env CHAINS entries.
 *     CONTRACTS, LINKING_STEPS and the LZ DVN PATHWAYS regenerate automatically.
 *
 * STATE FILE:
 *   Deployment state is saved to .deploy-state.json in the solidity directory.
 *   This allows resuming failed deployments. Delete this file to start fresh.
 *
 * PREREQUISITES:
 *   1. Run `npx hardhat compile` first to generate contract artifacts
 *   2. Ensure you have ETH on all target chains for gas
 *   3. Set PRIVATE_KEYS env var or use default test keys (for testnet only!)
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { configureLzDvns } = require('./lz-dvn-config');
require('dotenv').config();

// Program vkey for the SP1 sig-recovery circuit. Regenerated whenever the
// Rust program at solidity/zk/sig-recovery/ changes. To regenerate:
//   cd solidity/zk/sig-recovery && cargo run --release --bin vkey
// Then update this constant and the fixture file in lockstep.
const ZK_PROGRAM_VKEY = '0x00197b568ede30c47de32e462b8f4b99897351568da36e5aad94cfbf6da94770';

// Lockstep guard: the constant above must match the groth16 fixture.
// If you regenerate the SP1 circuit, update BOTH this constant AND the fixture.
{
  const fixture = require('../test/zk-fixtures/groth16-fixture.json');
  if (fixture.vkey.toLowerCase() !== ZK_PROGRAM_VKEY.toLowerCase()) {
    throw new Error(
      `vkey mismatch: deploy.js says ${ZK_PROGRAM_VKEY} but fixture says ${fixture.vkey}. ` +
      `If the circuit was regenerated, update both in lockstep.`
    );
  }
}

// ============================================
// CONFIGURATION
// ============================================

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3000;
const STATE_FILE = path.join(__dirname, '../.deploy-state.json');

// Phase 7 (renounce / additions-only) is opt-in. With this off, the
// deployer EOA stays the owner of every contract — useful during active
// dev when we may need to redeploy or rewire. Flip on for the
// trustlessness-finalizing run:
//   RENOUNCE_ON_DEPLOY=1 node scripts/deploy.js
//
// What phase 7 does:
//   1. Deploys one PathwayExpander per chain (owned by the deployer EOA).
//   2. Transfers ownership of every LZ OApp on that chain to its expander
//      (CawProfile + CawProfileL2_* on L1; CawProfileL2_<L>,
//      CawActionsArchive_<L>, CawChallengeRelay_<L> on each L2).
//   3. Renounces ownership on every other Ownable contract on that chain
//      (CawActions_<L>, CawProfileURI on L1).
//
// After phase 7, the only residual owner authority on the system is:
//   - PathwayExpander.owner (= deployer EOA), which can ONLY call addPeer
//     for not-yet-set eids on the OApps it owns. Cannot reconfigure
//     existing peers, cannot rotate delegate, cannot transfer the OApps'
//     ownership away.
//   - LZ EndpointV2.delegates(oapp) (= deployer EOA at time of writing),
//     which controls DVN/library config on each pathway. Phase 7 does
//     NOT touch the delegate by design — DVN config flexibility is the
//     last operational lever we leave open. To finalize that surface
//     too, run a separate one-shot or call `setDelegate(0)` on each
//     OApp via the expander before transferring ownership (which we do
//     not do today; the additions-only design is for peers, not delegates).
const RENOUNCE_ON_DEPLOY = process.env.RENOUNCE_ON_DEPLOY === '1';

// The deployer wallet address (for verification)
const EXPECTED_DEPLOYER = '0xF71338f3eAa483aA66125598B09BA1988e694a95';

// L2 chain *abstract* keys. Every L2 in this list runs the full per-chain set
// (CawProfileL2, CawActions, CawActionsArchive, CawChallengeRelay) so any
// network can pick any of them as its storage chain. Adding a new L2 = append
// to this list + add a per-env CHAINS entry below.
//
// L1 is INTENTIONALLY NOT IN THIS LIST. L1 still gets a co-deployed
// CawProfileL2_L1 + CawActions_L1 (in `bypassLZ` mode — see Phase 2 below)
// so that a network can pick L1 as their `storageChainEid` at createNetwork
// time and have actions land natively on mainnet. But L1 doesn't get a
// CawActionsArchive or a CawChallengeRelay because:
//   * Archiving L1 to a cheaper chain is pointless — L1 is the most
//     permanent chain in the stack already.
//   * Without an archive, there's no fraud-proof channel needed; readers
//     verify L1 actions by reading the canonical chain directly.
// Validators that opt to replicate an L1-storage network should set
// SKIP_L1_REPLICATE_NETWORK_IDS=<id,id,...> in their .env so the
// optimistic-replication loop short-circuits for that network (otherwise
// it'd try to ship hashes from a chain with no relay and fail per cycle).
const L2_CHAIN_KEYS = ['L2', 'L2b'];

// Chain configurations. Env vars are role-named (L1_RPC_URL, L2_RPC_URL,
// L2B_RPC_URL, L2C_RPC_URL...) so the same names work across testnet/mainnet.
const CHAINS = {
  testnetL1: {
    name: 'Sepolia',
    rpc: process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io',
    chainId: 11155111,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40161,
    dvn: '0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193',
    // CawActions on L1 is the bypassLZ storage chain path — ZK path supported
    // but L1 is not the primary action chain. Look up canonical address at:
    // https://docs.succinct.xyz/onchain-verification
    sp1Verifier: '<TBD before testnetL1 deploy: look up canonical Succinct SP1Verifier on Sepolia>',
  },
  testnetL2: {
    name: 'Base Sepolia',
    rpc: process.env.L2_RPC_URL || 'https://sepolia.base.org',
    chainId: 84532,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40245,
    dvn: '0xe1a12515f9ab2764b887bf60b923ca494ebbb2d6',
    // Canonical Succinct SP1VerifierGateway on Base Sepolia. Confirmed working
    // on a fork (see docs/ZK_SIG_PATH.md). Verified 2026-05-16.
    sp1Verifier: '0x397A5f7f3dBd538f23DE225B51f532c34448dA9B',
  },
  testnetL2b: {
    name: 'Arbitrum Sepolia',
    rpc: process.env.L2B_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
    chainId: 421614,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40231,
    dvn: '0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193',
    // Look up canonical address at https://docs.succinct.xyz/onchain-verification
    sp1Verifier: '<TBD before testnetL2b deploy: look up canonical Succinct SP1Verifier on Arbitrum Sepolia>',
  },
  devL1: {
    name: 'Local L1',
    rpc: process.env.DEV_L1_RPC_URL || 'http://localhost:8545',
    chainId: 31337,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30101,
    dvn: '0x0000000000000000000000000000000000000000',
    sp1Verifier: null, // dev: MockSP1Verifier deployed at phase 1 (see CONTRACTS below)
  },
  devL2: {
    name: 'Local L2',
    rpc: process.env.DEV_L2_RPC_URL || 'http://localhost:8546',
    chainId: 31337,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 40161,
    dvn: '0x0000000000000000000000000000000000000000',
    sp1Verifier: null, // dev: MockSP1Verifier deployed at phase 1 (see CONTRACTS below)
  },
  devL2b: {
    name: 'Local L2b',
    rpc: process.env.DEV_L2B_RPC_URL || 'http://localhost:8547',
    chainId: 31337,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 40231,
    dvn: '0x0000000000000000000000000000000000000000',
    sp1Verifier: null, // dev: MockSP1Verifier deployed at phase 1 (see CONTRACTS below)
  },
  // Mainnet configurations
  mainnetL1: {
    name: 'Ethereum Mainnet',
    rpc: process.env.L1_RPC_URL || 'https://eth.public-rpc.com',
    chainId: 1,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30101,
    dvn: '0x589dedbd617e0cbcb916a9223f4d1300c294236b',
    // Look up canonical address at https://docs.succinct.xyz/onchain-verification
    sp1Verifier: '<TBD before mainnetL1 deploy: look up canonical Succinct SP1Verifier on Ethereum mainnet>',
  },
  mainnetL2: {
    name: 'Base Mainnet',
    rpc: process.env.L2_RPC_URL || 'https://mainnet.base.org',
    chainId: 8453,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30184,
    dvn: '0x9e059a54699a285714207b43b055483e78faac25',
    // Look up canonical address at https://docs.succinct.xyz/onchain-verification
    sp1Verifier: '<TBD before mainnetL2 deploy: look up canonical Succinct SP1Verifier on Base mainnet>',
  },
  mainnetL2b: {
    name: 'Arbitrum Mainnet',
    rpc: process.env.L2B_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    chainId: 42161,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30110,
    dvn: '0x2f55c492897526677c5b68fb199ea31e2c126416',
    // Look up canonical address at https://docs.succinct.xyz/onchain-verification
    sp1Verifier: '<TBD before mainnetL2b deploy: look up canonical Succinct SP1Verifier on Arbitrum mainnet>',
  },
};

// Returns true when a CHAINS key refers to a local dev chain. Dev chains
// use MockSP1Verifier instead of a canonical Succinct SP1VerifierGateway.
// The key is the full CHAINS key (e.g. 'devL2'), NOT the abstract logical chain
// key (e.g. 'L2') — do not call this with abstract keys.
function isDevChain(chainKey) {
  return chainKey.startsWith('dev');
}

// Returns the canonical sp1Verifier address for a chain, or throws if it has
// not been set (placeholder strings starting with '<' are rejected). Returns
// null for dev chains (MockSP1Verifier will be deployed instead).
//
// Called from constructorArgs callbacks where chainKey is the full CHAINS key.
function requireSp1Verifier(chainKey) {
  const v = CHAINS[chainKey]?.sp1Verifier;
  if (v === null) return null; // dev chain — MockSP1Verifier will be deployed
  if (!v || typeof v !== 'string' || v.startsWith('<')) {
    throw new Error(
      `CHAINS[${chainKey}].sp1Verifier is not set. ` +
      `Look up the canonical Succinct SP1Verifier address for this chain at ` +
      `https://docs.succinct.xyz/onchain-verification and update CHAINS in deploy.js.`
    );
  }
  return v;
}

// Pre-existing contracts (don't redeploy these)
const EXISTING_CONTRACTS = {
  testnet: {
    MintableCaw: '0x56817dc696448135203C0556f702c6a953260411',
  },
  dev: {
    MintableCaw: '0x5fe2f174fe51474Cd198939C96e7dB65983EA307',
  },
  mainnet: {
    MintableCaw: '0xf3b9569F82B18aEf890De263B84189bd33EBe452', // Real CAW token
  },
};

// Marketplace-allowed ERC20 payment tokens, by env. ETH (address(0)) is always
// allowed by the contract itself and is NOT in this list. CAW is added at deploy
// time from state.addresses.MintableCaw (per-env). Adding/removing tokens after
// deployment is impossible — the marketplace has no admin. To change the set,
// deploy a sibling marketplace.
const MARKETPLACE_PAYMENT_TOKENS = {
  mainnet: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
  ],
  testnet: [],
  dev: [],
};

// Contract definitions with dependencies. The L2-specific entries
// (CawProfileL2_<L>, CawActions_<L>, CawActionsArchive_<L>, CawChallengeRelay_<L>)
// are appended programmatically after this map is defined — see the
// `for (const L of L2_CHAIN_KEYS)` block below.
const CONTRACTS = {
  // Phase 2: L1 - Deploy everything on L1
  // CawFontDataA and CawFontDataB are pure-data contracts holding the vectorized
  // glyph paths for on-chain SVG rendering. CawProfileURI reads from them via
  // `ICawFontData.DATA()` to assemble each NFT image. Split across two contracts
  // because the combined path data exceeds the 24,576-byte per-contract limit.
  CawFontDataA: {
    chain: 'L1',
    phase: 2,
    dependencies: [],
    constructorArgs: () => [],
  },
  CawFontDataB: {
    chain: 'L1',
    phase: 2,
    dependencies: [],
    constructorArgs: () => [],
  },
  CawProfileURI: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawFontDataA', 'CawFontDataB'],
    constructorArgs: (state) => [
      state.addresses.CawFontDataA,
      state.addresses.CawFontDataB,
    ],
    // Dependents (CawProfile) have a runtime setter (`setUriGenerator`) so a
    // URI redeploy does NOT need to cascade. The post-deploy linking step
    // `Link CawProfile to CawProfileURI` handles rewiring. This breaks the normal
    // transitive-closure cascade at this node.
    cascadeBreak: true,
  },
  MockSwapRouter: {
    artifact: 'MockSwapRouter',
    chain: 'L1',
    phase: 2,
    dependencies: [],
    constructorArgs: (state) => [state.addresses.MintableCaw],
  },
  CawBuyAndBurn: {
    chain: 'L1',
    phase: 2,
    dependencies: ['MockSwapRouter'],
    constructorArgs: (state) => [
      state.addresses.MintableCaw,
      state.addresses.MockSwapRouter,
    ],
  },
  CawNetworkManager: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawBuyAndBurn'],
    constructorArgs: (state) => [state.addresses.CawBuyAndBurn],
  },
  CawProfile: {
    chain: 'L1',
    phase: 2,
    // CawProfile depends on every L2's CawProfileL2 (so we know each peer's
    // address at L1 deploy time for setL2Peer wiring later). Built from
    // L2_CHAIN_KEYS so adding a new L2 doesn't require editing this list.
    dependencies: [
      ...L2_CHAIN_KEYS.map(L => `CawProfileL2_${L}`),
      'CawProfileURI', 'CawNetworkManager', 'CawBuyAndBurn',
    ],
    constructorArgs: (state, chain) => [
      state.addresses.MintableCaw,
      state.addresses.CawProfileURI,
      state.addresses.CawBuyAndBurn,
      state.addresses.CawNetworkManager,
      CHAINS[chain].lzEndpoint,
      CHAINS[chain].lzEid,
    ],
  },
  CawProfileL2_L1: {
    // CawProfileL2 deployed on L1 (for local actions without cross-chain)
    artifact: 'CawProfileL2',
    chain: 'L1',
    phase: 2,
    dependencies: [],
    constructorArgs: (state, chain) => [
      CHAINS[chain.replace('L1', 'L2')].lzEid, // peer network eid (L2)
      CHAINS[chain].lzEndpoint,
    ],
  },
  CawProfileMinter: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawProfile', 'MockSwapRouter'],
    constructorArgs: (state) => [
      state.addresses.MintableCaw,
      state.addresses.CawProfile,
      state.addresses.MockSwapRouter,
    ],
  },
  CawProfileQuoter: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawProfile'],
    constructorArgs: (state) => [state.addresses.CawProfile],
  },
  CawProfileMarketplace: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawProfile'],
    constructorArgs: (state, _chainKey, env) => {
      const erc20Tokens = (MARKETPLACE_PAYMENT_TOKENS[env] || []).slice();
      // CAW (per env) — added on top of the static list. Skip if not deployed.
      const caw = state.addresses.MintableCaw || state.addresses.CAW;
      if (caw) erc20Tokens.push(caw);
      return [state.addresses.CawProfile, erc20Tokens];
    },
  },
  CawActions_L1: {
    artifact: 'CawActions',
    chain: 'L1',
    phase: 2,
    dependencies: ['CawProfileL2_L1'],
    constructorArgs: (state, chainKey) => [
      state.addresses.CawProfileL2_L1,
      state.addresses.MockSP1Verifier_L1 || requireSp1Verifier(chainKey),
      ZK_PROGRAM_VKEY,
    ],
  },
  MockSP1Verifier_L1: {
    artifact: 'MockSP1Verifier',
    chain: 'L1',
    phase: 1, // before CawActions_L1 in phase 2
    dependencies: [],
    constructorArgs: () => [],
    condition: (_state, _deployer, env) => env === 'dev',
  },
  // Phase 7: PathwayExpander on L1. Becomes the owner of CawProfile +
  // CawProfileL2_L1 in the linking step that follows. Owner of the
  // expander itself is the deployer EOA (constructor arg below);
  // transfer this to a multisig later if desired before the deployer
  // walks away completely.
  PathwayExpander_L1: {
    artifact: 'PathwayExpander',
    chain: 'L1',
    phase: 7,
    dependencies: [],
    constructorArgs: (state) => [state.deployerAddress],
    condition: () => RENOUNCE_ON_DEPLOY,
  },
};

// Per-L2 contracts: for each L2 in L2_CHAIN_KEYS, expand to four entries:
//   CawProfileL2_<L>     (phase 1, peered with L1)
//   CawActions_<L>       (phase 3, depends on CawProfileL2_<L>)
//   CawActionsArchive_<L>(phase 4, archive role on this chain)
//   CawChallengeRelay_<L>(phase 4, depends on CawActions_<L>)
//
// Adding a new L2 = append to L2_CHAIN_KEYS + a CHAINS entry per env. The
// peer wiring in LINKING_STEPS regenerates from this list too.
for (const L of L2_CHAIN_KEYS) {
  CONTRACTS[`CawProfileL2_${L}`] = {
    artifact: 'CawProfileL2',
    chain: L,
    phase: 1,
    dependencies: [],
    constructorArgs: (state, chain) => [
      CHAINS[chain.replace(/L2.*$/, 'L1')].lzEid, // peer eid (L1)
      CHAINS[chain].lzEndpoint,
    ],
  };
  CONTRACTS[`MockSP1Verifier_${L}`] = {
    artifact: 'MockSP1Verifier',
    chain: L,
    phase: 1, // before CawActions_${L} in phase 3
    dependencies: [],
    constructorArgs: () => [],
    condition: (_state, _deployer, env) => env === 'dev',
  };
  CONTRACTS[`CawActions_${L}`] = {
    artifact: 'CawActions',
    chain: L,
    phase: 3,
    dependencies: [`CawProfileL2_${L}`],
    constructorArgs: (state, chainKey) => [
      state.addresses[`CawProfileL2_${L}`],
      state.addresses[`MockSP1Verifier_${L}`] || requireSp1Verifier(chainKey),
      ZK_PROGRAM_VKEY,
    ],
  };
  CONTRACTS[`CawActionsArchive_${L}`] = {
    artifact: 'CawActionsArchive',
    chain: L,
    phase: 4,
    dependencies: [],
    constructorArgs: (state, chain) => [CHAINS[chain].lzEndpoint],
  };
  CONTRACTS[`CawChallengeRelay_${L}`] = {
    artifact: 'CawChallengeRelay',
    chain: L,
    phase: 4,
    dependencies: [`CawActions_${L}`],
    constructorArgs: (state, chain) => [
      CHAINS[chain].lzEndpoint,
      state.addresses[`CawActions_${L}`],
    ],
  };
  // Phase 7: per-L2 PathwayExpander. Becomes the owner of the three LZ
  // OApps on this chain (CawProfileL2_<L>, CawActionsArchive_<L>,
  // CawChallengeRelay_<L>).
  CONTRACTS[`PathwayExpander_${L}`] = {
    artifact: 'PathwayExpander',
    chain: L,
    phase: 7,
    dependencies: [],
    constructorArgs: (state) => [state.deployerAddress],
    condition: () => RENOUNCE_ON_DEPLOY,
  };
}

// Linking steps (run after deployments)
const LINKING_STEPS = [
  // Phase 2 linking (L1)
  {
    name: 'Create first network on NetworkManager',
    chain: 'L1',
    phase: 2,
    contract: 'CawNetworkManager',
    method: 'createNetwork',
    // Fees: ~$3 each at ETH=$2000 → 0.0015 ETH = 1500000000000000 wei
    args: (state, chainConfig) => ['CAW Protocol', state.deployerAddress, CHAINS[chainConfig.env + 'L2'].lzEid, '1500000000000000', '1500000000000000', '1500000000000000', '1500000000000000'],
    condition: (state) => state.addresses.CawNetworkManager,
    skipIf: async (state, deployer) => {
      return state.linking?.networkCreated === true;
    },
    onSuccess: (state) => {
      state.linking = state.linking || {};
      state.linking.networkCreated = true;
    },
  },
  {
    name: 'Set L1 peer on CawProfileL2_L1 (bypassLZ=true)',
    chain: 'L1',
    phase: 2,
    contract: 'CawProfileL2_L1',
    method: 'setL1Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawProfile,
      true, // bypassLZ for local
    ],
    condition: (state) => state.addresses.CawProfileL2_L1 && state.addresses.CawProfile,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawProfileL2_L1');
      if (!contract) return false;
      try {
        return await contract.bypassLZ();
      } catch { return false; }
    },
  },
  {
    name: 'Set L2 peer on CawProfile (to L1 local CawProfileL2)',
    chain: 'L1',
    phase: 2,
    contract: 'CawProfile',
    method: 'setL2Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawProfileL2_L1,
    ],
    condition: (state) => state.addresses.CawProfile && state.addresses.CawProfileL2_L1,
  },
  // L1 CawProfile setL2Peer to each L2's CawProfileL2 — generated in the
  // expansion block below for ['L2', 'L2b', ...].
  {
    name: 'Set minter on CawProfile',
    chain: 'L1',
    phase: 2,
    contract: 'CawProfile',
    method: 'setMinter',
    getter: 'minter',
    args: (state) => [state.addresses.CawProfileMinter],
    condition: (state) => state.addresses.CawProfile && state.addresses.CawProfileMinter,
  },
  {
    // This linking step exists because CawProfileURI has cascadeBreak=true:
    // redeploying CawProfileURI does NOT redeploy CawProfile, so we need to
    // rewire the URI generator address here via the setter.
    name: 'Link CawProfile to CawProfileURI',
    chain: 'L1',
    phase: 2,
    contract: 'CawProfile',
    method: 'setUriGenerator',
    args: (state) => [state.addresses.CawProfileURI],
    condition: (state) => state.addresses.CawProfile && state.addresses.CawProfileURI,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawProfile');
      if (!contract) return false;
      try {
        const current = await contract.uriGenerator();
        return current.toLowerCase() === state.addresses.CawProfileURI.toLowerCase();
      } catch { return false; }
    },
  },
  {
    name: 'Link CawProfileL2_L1 to CawActions_L1',
    chain: 'L1',
    phase: 2,
    contract: 'CawProfileL2_L1',
    method: 'setCawActions',
    getter: 'cawActions',
    args: (state) => [state.addresses.CawActions_L1],
    condition: (state) => state.addresses.CawProfileL2_L1 && state.addresses.CawActions_L1,
  },
  {
    name: 'Set CawProfile on BuyAndBurn',
    chain: 'L1',
    phase: 2,
    contract: 'CawBuyAndBurn',
    method: 'setCawProfile',
    args: (state) => [state.addresses.CawProfile],
    condition: (state) => state.addresses.CawBuyAndBurn && state.addresses.CawProfile,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawBuyAndBurn');
      const current = await contract.cawProfile();
      return current !== '0x0000000000000000000000000000000000000000';
    },
  },
  // Phase 3 + Phase 5 per-L2 linking is generated below from L2_CHAIN_KEYS.
  //   Phase 3: each L2's CawProfileL2 ← L1 peer + setCawActions wiring.
  //   Phase 5: full mesh — every storage L2's CawChallengeRelay peers with
  //            every other L2's CawActionsArchive (and vice versa).

  // Replication targets used to be on-chain (CCM.addReplication + LZ push to L2).
  // That's gone — REPLICATE_NETWORK_IDS env on each validator is the source of truth.

  // Phase 5: (was: marketplace payment-token whitelist via setAllowedPaymentToken)
  // The marketplace no longer has an admin. Allowed ERC20 payment tokens are
  // fixed at construction (see MARKETPLACE_PAYMENT_TOKENS + the constructorArgs
  // for CawProfileMarketplace above). ETH is always allowed.


  // -----------------------------------------------------------------
  // Phase 6: LZ DVN config — mainnet only, 3-of-3 required DVN set
  // (LayerZero Labs + Nethermind + Google Cloud) on every cross-chain
  // pathway. See scripts/lz-dvn-config.js for the rationale + address
  // provenance. Idempotent: reads on-chain config first and only sends
  // tx if a pathway is misconfigured.
  //
  // `chain: 'L1'` is just where the runner chooses to begin — the
  // custom handler itself hops across all relevant chains internally
  // via deployer.initChain(chainKey).
  // -----------------------------------------------------------------
  {
    name: 'Configure LZ DVN set (3-of-3: LayerZero Labs + Nethermind + Google Cloud)',
    chain: 'L1',
    phase: 6,
    // Mainnet-only: testnet/dev rely on LayerZero's default DVN config and
    // there's no `configureLzDvns` implementation here. Without this guard
    // every testnet run reports "Failed: configureLzDvns is not defined"
    // even though nothing went wrong.
    condition: (_state, _deployer, env) => env === 'mainnet',
    custom: async (state, deployer, chainConfig) => {
      await configureLzDvns(state, deployer, chainConfig, CHAINS, L2_CHAIN_KEYS);
    },
  },

  // -----------------------------------------------------------------
  // Phase 7: renounce / additions-only finalization
  // -----------------------------------------------------------------
  // Every step is gated on RENOUNCE_ON_DEPLOY. With it off, deployment
  // ends after phase 6 and the deployer remains owner of everything.
  //
  // Step style:
  //   - LZ OApps: transferOwnership(PathwayExpander_<chain>). The
  //     expander's addPeer is the only future write path (and even
  //     that's blocked by per-eid OnlyOnce on the OApps themselves).
  //   - Plain Ownables (CawActions_<chain>, CawProfileURI on L1):
  //     renounceOwnership(). No future admin operations needed.
  //
  // Each step has a skipIf that compares the live owner to the target
  // (expander address for transfers, address(0) for renounces), so a
  // re-run with RENOUNCE_ON_DEPLOY=1 is idempotent — the second run
  // sees "already done" and exits the step without sending a tx.
  // -----------------------------------------------------------------
  {
    name: '[Phase 7] Transfer CawProfile ownership → PathwayExpander_L1',
    chain: 'L1',
    phase: 7,
    contract: 'CawProfile',
    method: 'transferOwnership',
    args: (state) => [state.addresses.PathwayExpander_L1],
    condition: (state) => RENOUNCE_ON_DEPLOY
      && state.addresses.CawProfile
      && state.addresses.PathwayExpander_L1,
    skipIf: async (state, deployer) => {
      const c = deployer.getContract('CawProfile');
      if (!c) return false;
      const owner = await c.owner();
      return owner.toLowerCase() === state.addresses.PathwayExpander_L1.toLowerCase();
    },
  },
  {
    name: '[Phase 7] Transfer CawProfileL2_L1 ownership → PathwayExpander_L1',
    chain: 'L1',
    phase: 7,
    contract: 'CawProfileL2_L1',
    method: 'transferOwnership',
    args: (state) => [state.addresses.PathwayExpander_L1],
    condition: (state) => RENOUNCE_ON_DEPLOY
      && state.addresses.CawProfileL2_L1
      && state.addresses.PathwayExpander_L1,
    skipIf: async (state, deployer) => {
      const c = deployer.getContract('CawProfileL2_L1');
      if (!c) return false;
      const owner = await c.owner();
      return owner.toLowerCase() === state.addresses.PathwayExpander_L1.toLowerCase();
    },
  },
  {
    name: '[Phase 7] Renounce CawActions_L1',
    chain: 'L1',
    phase: 7,
    contract: 'CawActions_L1',
    method: 'renounceOwnership',
    args: () => [],
    condition: (state) => RENOUNCE_ON_DEPLOY && state.addresses.CawActions_L1,
    skipIf: async (state, deployer) => {
      const c = deployer.getContract('CawActions_L1');
      if (!c) return false;
      const owner = await c.owner();
      return owner === '0x0000000000000000000000000000000000000000';
    },
  },
  {
    name: '[Phase 7] Renounce CawProfileURI',
    chain: 'L1',
    phase: 7,
    contract: 'CawProfileURI',
    method: 'renounceOwnership',
    args: () => [],
    condition: (state) => RENOUNCE_ON_DEPLOY && state.addresses.CawProfileURI,
    skipIf: async (state, deployer) => {
      const c = deployer.getContract('CawProfileURI');
      if (!c) return false;
      const owner = await c.owner();
      return owner === '0x0000000000000000000000000000000000000000';
    },
  },
  // Per-L2 phase-7 entries (transfers + renounces) are appended below
  // from L2_CHAIN_KEYS — same pattern as phases 3/5.
];

// =============================================================================
// Per-L2 linking step generation
// =============================================================================
//
// For each L in L2_CHAIN_KEYS append:
//   * Phase 2 (on L1): setL2Peer to that L's CawProfileL2.
//   * Phase 3 (on L itself): setL1Peer + setCawActions wiring.
//   * Phase 5 (full mesh): for every other L2 L', wire CawChallengeRelay_L
//     ↔ CawActionsArchive_L'. N×(N-1) directed pairs total.
// =============================================================================

for (const L of L2_CHAIN_KEYS) {
  // Phase 2: L1's CawProfile setL2Peer for this L's CawProfileL2.
  LINKING_STEPS.push({
    name: `Set L2 peer on CawProfile (to CawProfileL2_${L})`,
    chain: 'L1',
    phase: 2,
    contract: 'CawProfile',
    method: 'setL2Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + L].lzEid,
      state.addresses[`CawProfileL2_${L}`],
    ],
    condition: (state) => state.addresses.CawProfile && state.addresses[`CawProfileL2_${L}`],
  });

  // Phase 3: this L's CawProfileL2 setL1Peer (for cross-chain mints/auths).
  LINKING_STEPS.push({
    name: `Set L1 peer on CawProfileL2_${L}`,
    chain: L,
    phase: 3,
    contract: `CawProfileL2_${L}`,
    method: 'setL1Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawProfile,
      false, // don't bypass LZ for cross-chain
    ],
    condition: (state) => state.addresses[`CawProfileL2_${L}`] && state.addresses.CawProfile,
  });

  // Phase 3: link this L's CawProfileL2 to its CawActions.
  LINKING_STEPS.push({
    name: `Link CawProfileL2_${L} to CawActions_${L}`,
    chain: L,
    phase: 3,
    contract: `CawProfileL2_${L}`,
    method: 'setCawActions',
    getter: 'cawActions',
    args: (state) => [state.addresses[`CawActions_${L}`]],
    condition: (state) => state.addresses[`CawProfileL2_${L}`] && state.addresses[`CawActions_${L}`],
  });

  // Phase 5: full-mesh archive ↔ relay wiring. For every other L2 L':
  //   - On L (storage), CawChallengeRelay_L peers L'.lzEid → CawActionsArchive_L'.
  //   - On L' (archive), CawActionsArchive_L' peers L.lzEid → CawChallengeRelay_L.
  // The "skipIf" reads on-chain peers() so re-running is idempotent across
  // partial deploys.
  for (const Lp of L2_CHAIN_KEYS) {
    if (Lp === L) continue; // a chain doesn't relay to its own archive

    // SEND side: CawChallengeRelay on L points to CawActionsArchive on L'.
    LINKING_STEPS.push({
      name: `Set LZ peer on CawChallengeRelay_${L} (targets CawActionsArchive_${Lp})`,
      chain: L,
      phase: 5,
      contract: `CawChallengeRelay_${L}`,
      method: 'setPeer',
      args: (state, chainConfig) => [
        CHAINS[chainConfig.env + Lp].lzEid,
        ethers.zeroPadValue(state.addresses[`CawActionsArchive_${Lp}`], 32),
      ],
      condition: (state) =>
        state.addresses[`CawChallengeRelay_${L}`] && state.addresses[`CawActionsArchive_${Lp}`],
      skipIf: async (state, deployer) => {
        const contract = deployer.getContract(`CawChallengeRelay_${L}`);
        if (!contract) return false;
        const peerEid = CHAINS[deployer.getChainKey(Lp)].lzEid;
        const expected = ethers.zeroPadValue(state.addresses[`CawActionsArchive_${Lp}`], 32);
        try {
          const peer = await contract.peers(peerEid);
          return peer.toLowerCase() === expected.toLowerCase();
        } catch { return false; }
      },
    });

    // RECEIVE side: CawActionsArchive on L' accepts from CawChallengeRelay on L.
    LINKING_STEPS.push({
      name: `Set LZ peer on CawActionsArchive_${Lp} (accepts from CawChallengeRelay_${L})`,
      chain: Lp,
      phase: 5,
      contract: `CawActionsArchive_${Lp}`,
      method: 'setPeer',
      args: (state, chainConfig) => [
        CHAINS[chainConfig.env + L].lzEid,
        ethers.zeroPadValue(state.addresses[`CawChallengeRelay_${L}`], 32),
      ],
      condition: (state) =>
        state.addresses[`CawActionsArchive_${Lp}`] && state.addresses[`CawChallengeRelay_${L}`],
      skipIf: async (state, deployer) => {
        const contract = deployer.getContract(`CawActionsArchive_${Lp}`);
        if (!contract) return false;
        const peerEid = CHAINS[deployer.getChainKey(L)].lzEid;
        const expected = ethers.zeroPadValue(state.addresses[`CawChallengeRelay_${L}`], 32);
        try {
          const peer = await contract.peers(peerEid);
          return peer.toLowerCase() === expected.toLowerCase();
        } catch { return false; }
      },
    });
  }

  // -----------------------------------------------------------------
  // Phase 7 per-L2 entries (mirror the L1 block's pattern).
  // -----------------------------------------------------------------
  // OApps owned by the per-L2 expander:
  //   CawProfileL2_<L>, CawActionsArchive_<L>, CawChallengeRelay_<L>
  // Plain Ownables to renounce on this chain:
  //   CawActions_<L>
  // -----------------------------------------------------------------
  for (const oapp of [`CawProfileL2_${L}`, `CawActionsArchive_${L}`, `CawChallengeRelay_${L}`]) {
    LINKING_STEPS.push({
      name: `[Phase 7] Transfer ${oapp} ownership → PathwayExpander_${L}`,
      chain: L,
      phase: 7,
      contract: oapp,
      method: 'transferOwnership',
      args: (state) => [state.addresses[`PathwayExpander_${L}`]],
      condition: (state) => RENOUNCE_ON_DEPLOY
        && state.addresses[oapp]
        && state.addresses[`PathwayExpander_${L}`],
      skipIf: async (state, deployer) => {
        const c = deployer.getContract(oapp);
        if (!c) return false;
        const owner = await c.owner();
        return owner.toLowerCase() === state.addresses[`PathwayExpander_${L}`].toLowerCase();
      },
    });
  }

  LINKING_STEPS.push({
    name: `[Phase 7] Renounce CawActions_${L}`,
    chain: L,
    phase: 7,
    contract: `CawActions_${L}`,
    method: 'renounceOwnership',
    args: () => [],
    condition: (state) => RENOUNCE_ON_DEPLOY && state.addresses[`CawActions_${L}`],
    skipIf: async (state, deployer) => {
      const c = deployer.getContract(`CawActions_${L}`);
      if (!c) return false;
      const owner = await c.owner();
      return owner === '0x0000000000000000000000000000000000000000';
    },
  });
}

// ============================================
// DEPLOYMENTS.TS WRITER
// ============================================
//
// Builds the per-env block string for client/src/abi/deployments.ts.
// The block shape matches the file's hand-written initial content so the
// regex replace stays simple. Per-chain contracts (CawActions et al) live
// inside L1/L2/L2b sub-blocks indexed by abstract chain key.
//
// L1 contains everything L1-only (Profile, CCM, Minter, Marketplace, etc.)
// PLUS the L1-side bypassLZ co-deployments (CawProfileL2_L1 → CawProfileL2,
// CawActions_L1 → CawActions). That's why a network choosing L1 as their
// storage chain still has CawActions to talk to.
//
// Each L2 in L2_CHAIN_KEYS contains the four per-chain roles. Empty strings
// for not-yet-deployed contracts so the manifest stays well-formed.

function buildDeploymentsBlock(env, addresses) {
  const lines = [`  ${env}: {`];

  // ----- L1 (always present) -----
  const l1 = {
    MintableCaw: addresses.MintableCaw,
    CawProfile: addresses.CawProfile,
    CawProfileL2: addresses.CawProfileL2_L1, // bypassLZ co-deployment on L1
    CawNetworkManager: addresses.CawNetworkManager,
    CawProfileMinter: addresses.CawProfileMinter,
    CawProfileQuoter: addresses.CawProfileQuoter,
    CawProfileMarketplace: addresses.CawProfileMarketplace,
    CawProfileURI: addresses.CawProfileURI,
    CawFontDataA: addresses.CawFontDataA,
    CawFontDataB: addresses.CawFontDataB,
    CawBuyAndBurn: addresses.CawBuyAndBurn,
    MockSwapRouter: addresses.MockSwapRouter,
    CawActions: addresses.CawActions_L1,
  };
  lines.push('    L1: {');
  for (const [name, addr] of Object.entries(l1)) {
    if (addr) lines.push(`      ${name}: '${addr}',`);
  }
  lines.push('    },');

  // ----- Each L2 -----
  for (const L of L2_CHAIN_KEYS) {
    const block = {
      CawProfileL2: addresses[`CawProfileL2_${L}`],
      CawActions: addresses[`CawActions_${L}`],
      CawActionsArchive: addresses[`CawActionsArchive_${L}`],
      CawChallengeRelay: addresses[`CawChallengeRelay_${L}`],
    };
    // Skip the chain block entirely if nothing's deployed there yet
    // (keeps the file tidy for partial deploys).
    if (!Object.values(block).some(Boolean)) continue;
    lines.push(`    ${L}: {`);
    for (const [name, addr] of Object.entries(block)) {
      if (addr) lines.push(`      ${name}: '${addr}',`);
    }
    lines.push('    },');
  }

  lines.push('  },');
  return lines.join('\n');
}

// ============================================
// DEPLOYER CLASS
// ============================================

class MultiChainDeployer {
  constructor(env = 'testnet') {
    this.env = env;
    this.providers = {};
    this.wallets = {};
    this.contracts = {};
    this.state = this.loadState();
    this.artifacts = {};
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        console.log('Loaded existing deployment state');
        return data;
      }
    } catch (e) {
      console.warn('Could not load state file:', e.message);
    }
    return { addresses: {}, linking: {}, deployerAddress: null };
  }

  saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    console.log('State saved');
  }

  resetState() {
    this.state = { addresses: {}, linking: {}, deployerAddress: null };
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
    console.log('State reset');
  }

  getChainKey(logicalChain) {
    return this.env + logicalChain;
  }

  async initChain(chainKey) {
    if (this.providers[chainKey]) return;

    const config = CHAINS[chainKey];
    if (!config) {
      throw new Error(`Unknown chain: ${chainKey}`);
    }

    console.log(`\nConnecting to ${config.name} (${chainKey})...`);

    // Disable request batching to avoid Infura rate-limit errors on batch responses
    const provider = new ethers.JsonRpcProvider(config.rpc, undefined, { batchMaxCount: 1 });

    await this.retry(async () => {
      const network = await provider.getNetwork();
      console.log(`   Connected to chain ID ${network.chainId}`);
    });

    const privateKeys = process.env.PRIVATE_KEYS?.split(',') || [];
    if (privateKeys.length === 0) {
      throw new Error('No PRIVATE_KEYS found in environment');
    }

    const wallet = new ethers.Wallet(privateKeys[0], provider);
    await this.retry(async () => {
      const balance = await provider.getBalance(wallet.address);
      console.log(`   Wallet: ${wallet.address} (${ethers.formatEther(balance)} ETH)`);
    });

    // Verify deployer address
    if (wallet.address.toLowerCase() !== EXPECTED_DEPLOYER.toLowerCase()) {
      throw new Error(`Wallet mismatch! Expected ${EXPECTED_DEPLOYER}, got ${wallet.address}`);
    }

    this.providers[chainKey] = provider;
    this.wallets[chainKey] = wallet;
    this.state.deployerAddress = wallet.address;

    // Load existing contracts for this environment
    const existing = EXISTING_CONTRACTS[this.env] || {};
    for (const [name, addr] of Object.entries(existing)) {
      if (!this.state.addresses[name]) {
        this.state.addresses[name] = addr;
        console.log(`   Using existing ${name}: ${addr}`);
      }
    }
  }

  loadArtifact(contractName) {
    if (this.artifacts[contractName]) {
      return this.artifacts[contractName];
    }

    // Check standard path, then mocks/ subdirectory
    let artifactPath = path.join(
      __dirname,
      '../artifacts/contracts',
      `${contractName}.sol`,
      `${contractName}.json`
    );

    if (!fs.existsSync(artifactPath)) {
      artifactPath = path.join(
        __dirname,
        '../artifacts/contracts/mocks',
        `${contractName}.sol`,
        `${contractName}.json`
      );
    }

    if (!fs.existsSync(artifactPath)) {
      artifactPath = path.join(
        __dirname,
        '../artifacts/contracts/test-helpers',
        `${contractName}.sol`,
        `${contractName}.json`
      );
    }

    if (!fs.existsSync(artifactPath)) {
      return null; // Contract not compiled yet — skip gracefully
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    this.artifacts[contractName] = artifact;
    return artifact;
  }

  async retry(fn, attempts = RETRY_ATTEMPTS) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
        const delay = RETRY_DELAY_MS * Math.pow(2, i);
        console.warn(`   Attempt ${i + 1}/${attempts} failed: ${e.message}`);
        if (i < attempts - 1) {
          console.log(`   Retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  async deploy(contractKey, force = false) {
    const config = CONTRACTS[contractKey];
    if (!config) {
      throw new Error(`Unknown contract: ${contractKey}`);
    }

    if (this.state.addresses[contractKey] && !force) {
      console.log(`  ${contractKey} already deployed at ${this.state.addresses[contractKey]}`);
      return this.state.addresses[contractKey];
    }

    const chainKey = this.getChainKey(config.chain);
    await this.initChain(chainKey);

    const artifactName = config.artifact || contractKey;
    const artifact = this.loadArtifact(artifactName);
    if (!artifact) {
      console.log(`  Skipping ${contractKey} — contract not compiled yet`);
      return null;
    }
    const wallet = this.wallets[chainKey];

    const args = config.constructorArgs(this.state, chainKey, this.env);
    console.log(`\nDeploying ${contractKey} to ${chainKey}...`);
    console.log(`   Constructor args:`, args);

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

    const contract = await this.retry(async () => {
      // Use higher gas limit for large contracts like CawProfile
      const overrides = {};
      if (contractKey === 'CawProfile') {
        overrides.gasLimit = 12000000n;
      }
      const deployed = await factory.deploy(...args, overrides);
      console.log(`   Tx hash: ${deployed.deploymentTransaction().hash}`);
      console.log(`   Waiting for confirmation...`);
      await deployed.waitForDeployment();
      return deployed;
    });

    const address = await contract.getAddress();
    console.log(`   Deployed at: ${address}`);

    this.state.addresses[contractKey] = address;
    this.contracts[contractKey] = contract;
    this.saveState();

    return address;
  }

  getContract(contractKey) {
    if (this.contracts[contractKey]) {
      return this.contracts[contractKey];
    }

    const address = this.state.addresses[contractKey];
    if (!address) return null;

    const config = CONTRACTS[contractKey];
    if (!config) return null;

    const chainKey = this.getChainKey(config.chain);
    const wallet = this.wallets[chainKey];
    if (!wallet) return null;

    const artifactName = config.artifact || contractKey;
    const artifact = this.loadArtifact(artifactName);

    this.contracts[contractKey] = new ethers.Contract(address, artifact.abi, wallet);
    return this.contracts[contractKey];
  }

  async executeLink(step) {
    const chainKey = this.getChainKey(step.chain);
    await this.initChain(chainKey);

    if (step.condition && !step.condition(this.state, this, this.env)) {
      console.log(`  Skipping "${step.name}" - condition not met`);
      return;
    }

    if (step.skipIf) {
      try {
        const shouldSkip = await step.skipIf(this.state, this);
        if (shouldSkip) {
          console.log(`  Skipping "${step.name}" - already done`);
          return;
        }
      } catch (e) {
        console.log(`   Skip check failed: ${e.message}, proceeding...`);
      }
    }

    // Auto-skip: if the step has a `getter` field, read the current on-chain
    // value and compare to args[0]. Saves a transaction when the setter would
    // be a no-op (e.g. setCawActions already pointing at the right address).
    if (step.getter && !step.skipIf) {
      try {
        const contract = this.getContract(step.contract);
        const chainConfig = { env: this.env, ...CHAINS[this.getChainKey(step.chain)] };
        const args = step.args(this.state, chainConfig);
        if (contract && contract[step.getter]) {
          // For setters like setL2Peer(eid, addr), the getter is peers(eid).
          // `getterArgs` optionally specifies which args to pass to the getter.
          const getterArgs = step.getterArgs
            ? step.getterArgs(this.state, chainConfig)
            : [];
          const current = await contract[step.getter](...getterArgs);
          const expected = args[step.getterCompareArgIndex || 0];
          const currentStr = String(current).toLowerCase();
          const expectedStr = String(expected).toLowerCase();
          if (currentStr === expectedStr || currentStr.endsWith(expectedStr.replace('0x', ''))) {
            console.log(`  Skipping "${step.name}" - already set`);
            return;
          }
        }
      } catch (e) {
        // Getter failed — proceed with the setter
      }
    }

    const chainConfig = { env: this.env, ...CHAINS[chainKey] };

    // Support fully custom steps (e.g. multi-contract operations like LZ config)
    if (step.custom) {
      console.log(`\n${step.name}...`);
      await step.custom(this.state, this, chainConfig);
      console.log(`   Done`);
      if (step.onSuccess) { step.onSuccess(this.state); this.saveState(); }
      return;
    }

    const contract = this.getContract(step.contract);
    if (!contract) {
      console.warn(`  Contract ${step.contract} not available, skipping "${step.name}"`);
      return;
    }

    let args = step.args(this.state, chainConfig);

    // Support async overrides (e.g. for payable calls that need fee quoting).
    // `overrides` may also return `{ args }` to replace the step.args output —
    // useful when args depend on async data (like an LZ fee quote).
    let overrides = {};
    if (step.overrides) {
      const raw = await step.overrides(this.state, this, chainConfig);
      if (raw && raw.args) { args = raw.args; }
      overrides = {};
      if (raw?.value !== undefined) overrides.value = raw.value;
      if (raw?.gasLimit !== undefined) overrides.gasLimit = raw.gasLimit;
      console.log(`\n${step.name}...`);
      console.log(`   Calling ${step.contract}.${step.method}(${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(', ')}) with value=${overrides.value ? ethers.formatEther(overrides.value) + ' ETH' : '0'}`);
    } else {
      console.log(`\n${step.name}...`);
      console.log(`   Calling ${step.contract}.${step.method}(${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(', ')})`);
    }

    await this.retry(async () => {
      const tx = await contract[step.method](...args, overrides);
      console.log(`   Tx hash: ${tx.hash}`);
      await tx.wait();
    });

    console.log(`   Done`);

    if (step.onSuccess) {
      step.onSuccess(this.state);
      this.saveState();
    }
  }

  async deployPhase(phase) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`PHASE ${phase}`);
    console.log(`${'='.repeat(50)}`);

    // Get contracts for this phase. A `condition` predicate on a
    // CONTRACTS entry lets us gate it on env / flags (e.g. phase 7's
    // PathwayExpander is only deployed when RENOUNCE_ON_DEPLOY=1).
    const phaseContracts = Object.entries(CONTRACTS)
      .filter(([_, config]) => config.phase === phase)
      .filter(([_, config]) => !config.condition || config.condition(this.state, this, this.env))
      .map(([key, _]) => key);

    // Deploy in dependency order. Contracts on DIFFERENT chains whose deps are
    // all satisfied can deploy in parallel — saves ~30-60s per parallel batch.
    const toDeploy = [...phaseContracts];

    while (toDeploy.length > 0) {
      // Find all contracts whose deps are ready AND that are on distinct chains
      // (can't parallelize two deploys on the same chain — nonce conflicts).
      const ready = toDeploy.filter(key =>
        CONTRACTS[key].dependencies.every(dep => this.state.addresses[dep])
      );
      if (ready.length === 0) {
        console.warn(`Could not deploy (missing dependencies): ${toDeploy.join(', ')}`);
        break;
      }

      // Group by chain, pick one per chain for parallel deployment
      const byChain = {};
      for (const key of ready) {
        const chain = CONTRACTS[key].chain;
        if (!byChain[chain]) byChain[chain] = key;
      }
      const batch = Object.values(byChain);

      if (batch.length > 1) {
        console.log(`\n   Deploying in parallel: ${batch.join(', ')}`);
      }

      const results = await Promise.allSettled(
        batch.map(key => this.deploy(key))
      );
      for (let i = 0; i < batch.length; i++) {
        if (results[i].status === 'rejected') {
          console.error(`Failed to deploy ${batch[i]}: ${results[i].reason.message}`);
          throw results[i].reason;
        }
        toDeploy.splice(toDeploy.indexOf(batch[i]), 1);
      }
    }

    // Run linking steps for this phase. Steps on different chains run in
    // parallel; steps on the same chain run sequentially (nonce ordering).
    const phaseLinks = LINKING_STEPS.filter(s => s.phase === phase);
    if (phaseLinks.length > 0) {
      // Group by chain
      const linksByChain = {};
      for (const step of phaseLinks) {
        const chain = step.chain;
        if (!linksByChain[chain]) linksByChain[chain] = [];
        linksByChain[chain].push(step);
      }

      // Run each chain's steps sequentially, but all chains in parallel
      await Promise.allSettled(
        Object.entries(linksByChain).map(async ([chain, steps]) => {
          for (const step of steps) {
            try {
              await this.executeLink(step);
            } catch (e) {
              console.error(`Failed: ${step.name} - ${e.message}`);
              // Continue with other steps on this chain
            }
          }
        })
      );
    }
  }

  async deployAll() {
    console.log('\nStarting full deployment...');
    console.log(`   Environment: ${this.env}`);
    console.log(`   Expected deployer: ${EXPECTED_DEPLOYER}`);

    // Pre-initialize all chains in parallel so later deploy/link steps don't
    // wait for serial RPC connections. Each initChain is ~2-3s of RPC round-trips.
    const allChainKeys = new Set();
    for (const [_, config] of Object.entries(CONTRACTS)) {
      allChainKeys.add(this.getChainKey(config.chain));
    }
    for (const step of LINKING_STEPS) {
      allChainKeys.add(this.getChainKey(step.chain));
    }
    console.log(`\nPre-connecting to ${allChainKeys.size} chains...`);
    // Stagger connections to avoid RPC rate limiting
    for (const k of allChainKeys) {
      await this.initChain(k);
      await new Promise(r => setTimeout(r, 3000)); // 3s between connections
    }

    // Deploy in phases. Phase 6 is LZ DVN reconciliation (mainnet only,
    // no-op on testnet/dev environments). Phase 7 is the renounce/
    // additions-only finalization (opt-in via RENOUNCE_ON_DEPLOY=1, and
    // a no-op when off so re-runs during dev don't accidentally lock
    // out the deployer).
    for (const phase of [1, 2, 3, 4, 5, 6, 7]) {
      await this.deployPhase(phase);
    }

    // Record the L2 deploy block so RawEventsGatherer's startBlock can be
    // updated post-deploy (mirrors the same step in redeploy()). Without
    // this, a fresh `--reset` deploy left the indexer replaying from a
    // stale startBlock that pre-dated the new contracts.
    try {
      const l2ChainKey = this.getChainKey('L2');
      await this.initChain(l2ChainKey);
      const currentBlock = await this.wallets[l2ChainKey].provider.getBlockNumber();
      this.state.l2DeployBlock = currentBlock;
      this.saveState();
      console.log(`\n   Recorded L2 deploy block: ${currentBlock}`);
    } catch (e) {
      console.warn('   Could not record L2 deploy block:', e.message);
    }
  }

  async redeploy(contractKey) {
    console.log(`\nRedeploying ${contractKey} and dependents...\n`);

    // Pre-initialize all chains in parallel
    const allChainKeys = new Set();
    for (const [_, config] of Object.entries(CONTRACTS)) {
      allChainKeys.add(this.getChainKey(config.chain));
    }
    for (const step of LINKING_STEPS) {
      allChainKeys.add(this.getChainKey(step.chain));
    }
    // Stagger connections to avoid RPC rate limiting
    for (const k of allChainKeys) {
      await this.initChain(k);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Find all contracts that depend on this one (transitive closure).
    // A dep that is flagged `cascadeBreak` halts the propagation — its
    // dependents stay deployed and get rewired via their runtime setter
    // (handled in the linking steps). This matters for e.g. CawProfileURI
    // where CawProfile.setUriGenerator() lets us swap the URI without
    // redeploying the whole name/actions tree.
    const toRedeploy = new Set([contractKey]);
    let changed = true;

    while (changed) {
      changed = false;
      for (const [key, config] of Object.entries(CONTRACTS)) {
        if (toRedeploy.has(key)) continue;
        for (const dep of config.dependencies) {
          if (!toRedeploy.has(dep)) continue;
          if (CONTRACTS[dep].cascadeBreak) continue;  // break propagation here
          toRedeploy.add(key);
          changed = true;
          break;
        }
      }
    }

    // If CawProfile (L1) is being redeployed, token IDs will change —
    // all CawProfileL2 and CawActions contracts must also be redeployed,
    // and the database must be reset (old actions reference stale token IDs).
    const nameContracts = ['CawProfile', 'CawProfileL2_L1', 'CawProfileL2_L2', 'CawProfileL2_L2b'];
    const isNameRedeploy = nameContracts.some(c => toRedeploy.has(c));
    if (isNameRedeploy) {
      // Force-include all CawActions and related contracts
      const forceInclude = [
        'CawProfileL2_L1', 'CawProfileL2_L2', 'CawProfileL2_L2b',
        'CawActions_L1', 'CawActions_L2', 'CawActions_L2b',
        'CawActionsArchive_L2b', 'CawChallengeRelay_L2',
        'CawProfileMinter', 'CawProfileQuoter', 'CawProfileMarketplace',
      ];
      for (const key of forceInclude) {
        if (CONTRACTS[key]) toRedeploy.add(key);
      }
      console.log('\n   ⚠️  CawProfile redeploy detected — forcing full contract redeploy.');
      console.log('   ⚠️  You MUST reset the database after this deployment!');
      console.log('   ⚠️  Run: cd client && npx prisma migrate reset\n');
    }

    console.log(`   Will redeploy: ${[...toRedeploy].join(', ')}`);

    // Clear addresses
    for (const key of toRedeploy) {
      delete this.state.addresses[key];
      delete this.contracts[key];
    }
    // Only clear networkCreated if CawNetworkManager itself is being redeployed
    if (toRedeploy.has('CawNetworkManager')) {
      this.state.linking = {};
    }
    this.saveState();

    // Redeploy by phase
    await this.deployAll();

    // Record the L2 deployment block so RawEventsGatherer starts from the right place.
    // Runs on any redeploy that touches an L2 contract whose events the indexer
    // watches (CawActions, or any of its prerequisites). Previously only fired
    // on a full CawProfile redeploy, which silently left `startBlock` stale when
    // we redeployed just CawActions_L2 — the indexer then missed every action
    // from the new contract until someone manually bumped `config.json`.
    const l2IndexedContracts = [
      'CawActions_L2', 'CawProfileL2_L2', 'CawChallengeRelay_L2',
    ];
    const isL2Redeploy = isNameRedeploy || l2IndexedContracts.some(c => toRedeploy.has(c));
    if (isL2Redeploy) {
      try {
        const l2ChainKey = this.getChainKey('L2');
        await this.initChain(l2ChainKey);
        const currentBlock = await this.wallets[l2ChainKey].provider.getBlockNumber();
        this.state.l2DeployBlock = currentBlock;
        this.saveState();
        console.log(`\n   Recorded L2 deploy block: ${currentBlock}`);
      } catch (e) {
        console.warn('   Could not record L2 deploy block:', e.message);
      }
    }
  }

  printState() {
    console.log('\nCurrent Deployment State:\n');
    console.log(`Environment: ${this.env}`);
    console.log(`Deployer: ${this.state.deployerAddress || 'Not connected'}\n`);

    console.log('Addresses:');
    const l2List = L2_CHAIN_KEYS.join(' + ');
    const phases = {
      1: `${l2List} CawProfileL2 (Phase 1)`,
      2: 'L1 (Phase 2)',
      3: `${l2List} CawActions (Phase 3)`,
      4: `${l2List} CawActionsArchive + CawChallengeRelay (Phase 4 — full mesh)`,
      5: 'Cross-chain peer wiring (Phase 5)',
      7: 'Renounce / additions-only (Phase 7 — opt-in via RENOUNCE_ON_DEPLOY=1)',
    };
    for (const phase of [1, 2, 3, 4, 5, 7]) {
      const phaseContracts = Object.entries(CONTRACTS).filter(([_, c]) => c.phase === phase);
      if (phaseContracts.length > 0) {
        console.log(`\n  ${phases[phase]}:`);
        for (const [key, _] of phaseContracts) {
          const addr = this.state.addresses[key];
          console.log(`    ${key}: ${addr || '(not deployed)'}`);
        }
      }
    }

    // Show MintableCaw separately
    if (this.state.addresses.MintableCaw) {
      console.log(`\n  Pre-existing:`);
      console.log(`    MintableCaw: ${this.state.addresses.MintableCaw}`);
    }

    console.log('\nLinking state:', JSON.stringify(this.state.linking || {}, null, 2));
  }
}

// ============================================
// Local install: per-network addresses.ts writer
// ============================================
//
// After a fresh deploy/redeploy the operator's addresses.ts still points at
// the OLD contracts — the indexer then watches the old address, pulls in
// stale events, and the action processor crashes trying to apply them
// against a freshly-reset DB. The CLI install step does this resolution
// for new operator installs; we mirror it here so a local-dev redeploy
// gets the same treatment without anyone having to re-run the CLI.
async function writeAddressesForLocalInstall(deployer) {
  const env = deployer.env;
  const envBlock = buildEnvBlock(env, deployer.state.addresses);
  if (!envBlock || !envBlock.L1?.CawNetworkManager) {
    console.warn('  Skipping addresses.ts (no CawNetworkManager in deploy state).');
    return;
  }

  // Resolve networkId=1's storage chain via on-chain CCM (canonical source).
  // Local dev always uses networkId=1 — the single network created by the
  // post-deploy linking step.
  const networkId = 1;
  const l1ChainKey = deployer.getChainKey('L1');
  await deployer.initChain(l1ChainKey);
  const ccm = new ethers.Contract(
    envBlock.L1.CawNetworkManager,
    ['function getStorageChainEid(uint32 networkId) view returns (uint32)'],
    deployer.wallets[l1ChainKey].provider,
  );
  let eid;
  try {
    eid = Number(await ccm.getStorageChainEid(networkId));
  } catch (e) {
    console.warn(`  Couldn't read storageChainEid for network : ${e.message}`);
    return;
  }

  // eid → chainKey (L2, L2b, ...)
  let storageChainKey = null;
  for (const L of L2_CHAIN_KEYS) {
    if (CHAINS[env + L]?.lzEid === eid) { storageChainKey = L; break; }
  }
  if (!storageChainKey) {
    // Could be L1 (networks can pick L1 as storage); resolve via CHAINS L1.
    if (CHAINS[env + 'L1']?.lzEid === eid) storageChainKey = 'L1';
  }
  if (!storageChainKey) {
    console.warn(`  Network  reports storage eid ${eid}; no matching chain in CHAINS — skipping addresses.ts`);
    return;
  }

  const l1 = envBlock.L1 || {};
  const l2 = envBlock[storageChainKey] || {};
  const consts = {
    CAW_ADDRESS: l1.MintableCaw,
    CAW_NAMES_ADDRESS: l1.CawProfile,
    CAW_NAME_QUOTER_ADDRESS: l1.CawProfileQuoter,
    CAW_NAMES_MINTER_ADDRESS: l1.CawProfileMinter,
    URI_GENERATOR_ADDRESS: l1.CawProfileURI,
    NETWORK_MANAGER_ADDRESS: l1.CawNetworkManager,
    CAW_NAME_MARKETPLACE_ADDRESS: l1.CawProfileMarketplace,
    CAW_NAMES_L2_MAINNET_ADDRESS: l1.CawProfileL2,
    CAW_ACTIONS_MAINNET_ADDRESS: l1.CawActions,
    // Per-network storage chain — for L1-storage networks these duplicate the
    // L1 entries above, which is fine; the codebase reads singular constants.
    CAW_NAMES_L2_ADDRESS: storageChainKey === 'L1' ? l1.CawProfileL2 : l2.CawProfileL2,
    CAW_ACTIONS_ADDRESS: storageChainKey === 'L1' ? l1.CawActions : l2.CawActions,
    CAW_ACTIONS_ARCHIVE_ADDRESS: l2.CawActionsArchive,
    CAW_CHALLENGE_RELAY_ADDRESS: l2.CawChallengeRelay,
  };
  const staticConsts = {
    WETH_ADDRESS: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    USDC_ADDRESS: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT_ADDRESS: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  };
  const lines = [
    `// Generated by solidity/scripts/deploy.js after the deploy run.`,
    `// Resolved for env=${env}, networkId=${networkId}, storage chain=${storageChainKey} (eid=${eid}).`,
    `// To rebuild without redeploying: rerun the CLI install for this network.`,
    ``,
  ];
  for (const [k, v] of Object.entries(staticConsts)) {
    lines.push(`export const ${k} = "${v}" as const;`);
  }
  for (const [k, v] of Object.entries(consts)) {
    if (v) lines.push(`export const ${k} = "${v}" as const;`);
    else lines.push(`// export const ${k} = '...' — not deployed for ${env}/${storageChainKey} yet`);
  }
  const out = lines.join('\n') + '\n';
  const outPath = path.join(__dirname, '../../client/src/abi/addresses.ts');
  fs.writeFileSync(outPath, out);
  console.log(`Wrote ${outPath} (network ${networkId} → ${storageChainKey}, eid ${eid})`);
}

/**
 * Build a structured {L1: {...}, L2: {...}, L2b: {...}} block from the
 * flat state.addresses map — same shape buildDeploymentsBlock emits, but
 * returned as JS instead of stringified TypeScript.
 */
function buildEnvBlock(env, addresses) {
  const block = { L1: {} };
  // L1 contracts (per the buildDeploymentsBlock layout)
  const l1Keys = [
    'MintableCaw', 'CawProfile', 'CawProfileL2_L1', 'CawNetworkManager',
    'CawProfileMinter', 'CawProfileQuoter', 'CawProfileMarketplace',
    'CawProfileURI', 'CawFontDataA', 'CawFontDataB', 'CawBuyAndBurn',
    'MockSwapRouter', 'CawActions_L1',
  ];
  for (const k of l1Keys) {
    if (addresses[k]) {
      // CawProfileL2_L1 → CawProfileL2 in the deployments block; CawActions_L1 → CawActions.
      const dst = k === 'CawProfileL2_L1' ? 'CawProfileL2'
                : k === 'CawActions_L1'  ? 'CawActions'
                : k;
      block.L1[dst] = addresses[k];
    }
  }
  for (const L of L2_CHAIN_KEYS) {
    block[L] = {};
    for (const role of ['CawProfileL2', 'CawActions', 'CawActionsArchive', 'CawChallengeRelay']) {
      const flatKey = `${role}_${L}`;
      if (addresses[flatKey]) block[L][role] = addresses[flatKey];
    }
  }
  return block;
}

// ============================================
// CLI
// ============================================

async function main() {
  // Branch guard — see file header. The Client→Network rename split the
  // contract surface from its FE/backend consumers; running this from
  // master would emit deployments.ts keys the FE doesn't recognize.
  if (!process.env.CAW_DEPLOY_FROM_MASTER) {
    try {
      const { execSync } = require('child_process');
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
      if (branch === 'master' || branch === 'main') {
        console.error('\n[deploy.js] Refusing to deploy from branch ' + branch + '.');
        console.error('  The contract rename (Client → Network) is on master, but the');
        console.error('  matching ABI + FE/backend rename lives on contract-support-v2.');
        console.error('  Switch branches, or set CAW_DEPLOY_FROM_MASTER=1 to override.\n');
        process.exit(1);
      }
    } catch (e) {
      if (e.code !== 1) console.warn('[deploy.js] branch guard skipped: ' + e.message);
    }
  }

  const args = process.argv.slice(2);

  let env = 'testnet';
  let contractToRedeploy = null;
  let reset = false;
  let dryRun = false;
  let showState = false;
  let skipAbi = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--env':
        env = args[++i];
        break;
      case '--contract':
        contractToRedeploy = args[++i];
        break;
      case '--reset':
        reset = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--state':
        showState = true;
        break;
      case '--skip-abi':
        skipAbi = true;
        break;
      case '--help':
        console.log(`
Multi-Chain Deployment Script

Usage:
  node scripts/deploy.js [options]

Options:
  --env <env>         Environment: testnet, dev, mainnet (default: testnet)
  --contract <name>   Redeploy specific contract and its dependents
  --reset             Clear all deployment state and start fresh
  --dry-run           Show what would be deployed without deploying
  --state             Print current deployment state
  --skip-abi          Skip ABI regeneration after deployment
  --help              Show this help

Deployment Phases:
  Phase 1: Deploy CawProfileL2 on L2 + L2b (needed by L1 contracts)
  Phase 2: Deploy all L1 contracts and link them
  Phase 3: Deploy CawActions on L2 + L2b and link them to CawProfileL2
  Phase 4: Deploy CawActionsArchive on L2b and CawChallengeRelay on L2
  Phase 5: LZ peering between archive and relay + register network replication targets

Architecture:
  L1 (Sepolia): CawProfile, CawNetworkManager, CawProfileMinter, CawProfileQuoter
  L2 (Base Sepolia): CawProfileL2, CawActions, CawChallengeRelay
  L2b (Arbitrum Sepolia): CawProfileL2, CawActions, CawActionsArchive

After deployment, ABIs are automatically regenerated for the frontend.
        `);
        process.exit(0);
    }
  }

  // Always compile before deploying to avoid stale artifacts
  console.log('Compiling contracts...');
  const { execSync } = require('child_process');
  try {
    execSync('npx hardhat compile --force', { cwd: __dirname + '/..', stdio: 'inherit' });
    // Truffle compile skipped — uses Hardhat artifacts. Truffle compile starts ganache
    // and can trigger RPC rate limiting on Infura.
    // execSync('npx truffle compile --all', { cwd: __dirname + '/..', stdio: 'inherit' });
    console.log('Compilation complete.\n');
  } catch (err) {
    console.error('Compilation failed:', err.message);
    process.exit(1);
  }

  const deployer = new MultiChainDeployer(env);

  if (reset) {
    deployer.resetState();
  }

  if (showState) {
    deployer.printState();
    return;
  }

  if (dryRun) {
    console.log('\nDry run mode - showing what would be deployed:\n');
    deployer.printState();

    console.log('\nContracts to deploy:');
    for (const phase of [1, 2, 3, 4, 5]) {
      const phaseContracts = Object.entries(CONTRACTS)
        .filter(([key, c]) => c.phase === phase && !deployer.state.addresses[key]);
      if (phaseContracts.length > 0) {
        console.log(`  Phase ${phase}: ${phaseContracts.map(([k]) => k).join(', ')}`);
      }
    }
    return;
  }

  if (contractToRedeploy) {
    await deployer.redeploy(contractToRedeploy);
  } else {
    await deployer.deployAll();
  }

  deployer.printState();
  console.log('\nDeployment complete!');

  // Update network deployment manifest + regenerate ABIs
  if (!skipAbi) {
    // Rewrite the env block in client/src/abi/deployments.ts. The CLI then
    // reads from there + the operator's networkId to write a per-install
    // addresses.ts. deploy.js never touches addresses.ts directly anymore.
    const deploymentsFile = path.join(__dirname, '../../client/src/abi/deployments.ts');
    try {
      const newBlock = buildDeploymentsBlock(deployer.env, deployer.state.addresses);
      let content = fs.readFileSync(deploymentsFile, 'utf8');
      // Match the entire `<env>: { ... },` block (the closing `},` at the
      // env-level indent) and replace it. Anchored at the env name so other
      // env blocks stay untouched.
      const blockRegex = new RegExp(
        `(  ${deployer.env}: \\{)[\\s\\S]*?(\\n  \\},)`,
        'm'
      );
      if (blockRegex.test(content)) {
        content = content.replace(blockRegex, newBlock);
        fs.writeFileSync(deploymentsFile, content);
        console.log(`\nUpdated ${deployer.env} block in client/src/abi/deployments.ts`);
      } else {
        console.warn(`\nCouldn't find ${deployer.env} block in deployments.ts; skipping update`);
      }
    } catch (e) {
      console.warn('\nFailed to update deployments.ts:', e.message);
    }

    // Update RawEventsGatherer startBlock in config.json if l2DeployBlock was recorded
    if (deployer.state.l2DeployBlock) {
      const configFile = path.join(__dirname, '../../client/config.json');
      try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const gatherer = config.find(s => s.service === 'RawEventsGatherer');
        if (gatherer) {
          gatherer.config.startBlock = deployer.state.l2DeployBlock;
          fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
          console.log(`Updated RawEventsGatherer startBlock to ${deployer.state.l2DeployBlock} in config.json`);
        }
      } catch (e) {
        console.warn('Failed to update config.json startBlock:', e.message);
      }
    }

    // Rewrite this install's per-network addresses.ts. The CLI's install step
    // does the same thing for fresh operator installs; we run it inline here
    // so the local dev environment doesn't keep pointing at the OLD contract
    // addresses after a redeploy and silently process stale events.
    try {
      await writeAddressesForLocalInstall(deployer);
    } catch (e) {
      console.warn('Failed to update local addresses.ts:', e.message);
    }

    // Regenerate ABIs
    console.log('Regenerating ABIs for frontend...');
    try {
      execSync('npx wagmi generate', {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
      console.log('ABIs regenerated successfully');
    } catch (e) {
      console.warn('Failed to regenerate ABIs:', e.message);
      console.warn('   You can manually run: cd solidity && npx wagmi generate');
    }
  } else {
    console.log('\nSkipping ABI/address update (--skip-abi flag)');
  }
}

main().catch(e => {
  console.error('\nDeployment failed:', e);
  process.exit(1);
});
