#!/usr/bin/env node
/**
 * Multi-Chain Deployment Script for CAW Protocol
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
 *   PRIVATE_KEYS        - Comma-separated private keys (defaults to test keys)
 *   RPC_SEPOLIA         - Sepolia RPC URL
 *   RPC_BASE_SEPOLIA    - Base Sepolia RPC URL
 *   RPC_ARBITRUM_SEPOLIA - Arbitrum Sepolia RPC URL
 *   RPC_ETHEREUM        - Ethereum mainnet RPC URL
 *   RPC_BASE            - Base mainnet RPC URL
 *   RPC_ARBITRUM        - Arbitrum mainnet RPC URL
 *
 * DEPLOYMENT PHASES:
 *   Phase 1: L2a + L2b - Deploy CawProfileL2 on both L2 chains
 *   Phase 2: L1 - Deploy all L1 contracts (CawProfile, CawClientManager, etc.)
 *   Phase 3: L2a + L2b - Deploy remaining L2 contracts (CawActions)
 *   Phase 4: L2b - Deploy CawActionsArchive; L2 - Deploy CawChallengeRelay
 *   Phase 5: Wire up the L2 challenge relay as an LZ peer of the L2b archive
 *
 * ARCHITECTURE (testnet):
 *   L1 (Sepolia): CawProfile, CawClientManager, CawProfileMinter, CawProfileQuoter
 *   L2 (Base Sepolia): CawProfileL2, CawActions, CawChallengeRelay
 *   L2b (Arbitrum Sepolia): CawProfileL2, CawActions, CawActionsArchive
 *   Replication: validators submit checkpoint merkle roots directly to L2b's
 *   CawActionsArchive with a stake. Fraud proofs go L2 → LZ → L2b
 *   via CawChallengeRelay and are resolved on L2b.
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
require('dotenv').config();

// ============================================
// CONFIGURATION
// ============================================

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3000;
const STATE_FILE = path.join(__dirname, '../.deploy-state.json');

// The deployer wallet address (for verification)
const EXPECTED_DEPLOYER = '0xF71338f3eAa483aA66125598B09BA1988e694a95';

// Chain configurations
// L2 = Base Sepolia, L2b = Arbitrum Sepolia (both are full L2s that cross-replicate)
const CHAINS = {
  testnetL1: {
    name: 'Sepolia',
    rpc: process.env.RPC_SEPOLIA || 'https://eth-sepolia.public.blastapi.io',
    chainId: 11155111,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40161,
    dvn: '0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193',
  },
  testnetL2: {
    name: 'Base Sepolia',
    rpc: process.env.RPC_BASE_SEPOLIA || 'https://sepolia.base.org',
    chainId: 84532,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40245,
    dvn: '0xe1a12515f9ab2764b887bf60b923ca494ebbb2d6',
  },
  testnetL2b: {
    name: 'Arbitrum Sepolia',
    rpc: process.env.RPC_ARBITRUM_SEPOLIA || 'https://sepolia-rollup.arbitrum.io/rpc',
    chainId: 421614,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40231,
    dvn: '0x8eebf8b423b73bfca51a1db4b7354aa0bfca9193',
  },
  devL1: {
    name: 'Local L1',
    rpc: process.env.RPC_DEV_L1 || 'http://localhost:8545',
    chainId: 31337,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30101,
    dvn: '0x0000000000000000000000000000000000000000',
  },
  devL2: {
    name: 'Local L2',
    rpc: process.env.RPC_DEV_L2 || 'http://localhost:8546',
    chainId: 31337,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 40161,
    dvn: '0x0000000000000000000000000000000000000000',
  },
  devL2b: {
    name: 'Local L2b',
    rpc: process.env.RPC_DEV_L2B || 'http://localhost:8547',
    chainId: 31337,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 40231,
    dvn: '0x0000000000000000000000000000000000000000',
  },
  // Mainnet configurations
  mainnetL1: {
    name: 'Ethereum Mainnet',
    rpc: process.env.RPC_ETHEREUM || 'https://eth.public-rpc.com',
    chainId: 1,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30101,
    dvn: '0x589dedbd617e0cbcb916a9223f4d1300c294236b',
  },
  mainnetL2: {
    name: 'Base Mainnet',
    rpc: process.env.RPC_BASE || 'https://mainnet.base.org',
    chainId: 8453,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30184,
    dvn: '0x9e059a54699a285714207b43b055483e78faac25',
  },
  mainnetL2b: {
    name: 'Arbitrum Mainnet',
    rpc: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
    chainId: 42161,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30110,
    dvn: '0x2f55c492897526677c5b68fb199ea31e2c126416',
  },
};

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

// Contract definitions with dependencies
const CONTRACTS = {
  // Phase 1: Deploy CawProfileL2 on both L2 chains (needed by L1 CawProfile for cross-chain setup)
  CawProfileL2_L2: {
    artifact: 'CawProfileL2',
    chain: 'L2',
    phase: 1,
    dependencies: [],
    constructorArgs: (state, chain) => [
      CHAINS[chain.replace('L2', 'L1')].lzEid, // peer network eid (L1)
      CHAINS[chain].lzEndpoint,
    ],
  },
  CawProfileL2_L2b: {
    artifact: 'CawProfileL2',
    chain: 'L2b',
    phase: 1,
    dependencies: [],
    constructorArgs: (state, chain) => [
      CHAINS[chain.replace('L2b', 'L1')].lzEid, // peer network eid (L1)
      CHAINS[chain].lzEndpoint,
    ],
  },

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
  CawClientManager: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawBuyAndBurn'],
    constructorArgs: (state) => [state.addresses.CawBuyAndBurn],
  },
  CawProfile: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawProfileL2_L2', 'CawProfileL2_L2b', 'CawProfileURI', 'CawClientManager', 'CawBuyAndBurn'],
    constructorArgs: (state, chain) => [
      state.addresses.MintableCaw,
      state.addresses.CawProfileURI,
      state.addresses.CawBuyAndBurn,
      state.addresses.CawClientManager,
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
    dependencies: ['CawProfile'],
    constructorArgs: (state) => [
      state.addresses.MintableCaw,
      state.addresses.CawProfile,
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
    constructorArgs: (state) => [state.addresses.CawProfile],
  },
  CawActions_L1: {
    artifact: 'CawActions',
    chain: 'L1',
    phase: 2,
    dependencies: ['CawProfileL2_L1'],
    constructorArgs: (state) => [state.addresses.CawProfileL2_L1],
  },
  // Phase 3: Deploy remaining L2 contracts on both chains
  CawActions_L2: {
    artifact: 'CawActions',
    chain: 'L2',
    phase: 3,
    dependencies: ['CawProfileL2_L2'],
    constructorArgs: (state) => [state.addresses.CawProfileL2_L2],
  },
  CawActions_L2b: {
    artifact: 'CawActions',
    chain: 'L2b',
    phase: 3,
    dependencies: ['CawProfileL2_L2b'],
    constructorArgs: (state) => [state.addresses.CawProfileL2_L2b],
  },

  // Phase 4: Optimistic replication infrastructure
  //   - L2b (Arbitrum Sepolia) hosts the stake-based archive that validators
  //     write checkpoint merkle roots to.
  //   - L2 (Base Sepolia) hosts the challenge relay that reads CawActions and
  //     forwards the canonical hash via LayerZero to the L2b archive for
  //     fraud resolution.
  CawActionsArchive_L2b: {
    artifact: 'CawActionsArchive',
    chain: 'L2b',
    phase: 4,
    dependencies: [],
    constructorArgs: (state, chain) => [CHAINS[chain].lzEndpoint],
  },
  CawChallengeRelay_L2: {
    artifact: 'CawChallengeRelay',
    chain: 'L2',
    phase: 4,
    dependencies: ['CawActions_L2'],
    constructorArgs: (state, chain) => [
      CHAINS[chain].lzEndpoint,
      state.addresses.CawActions_L2,
    ],
  },
};

// Linking steps (run after deployments)
const LINKING_STEPS = [
  // Phase 2 linking (L1)
  {
    name: 'Create first client on ClientManager',
    chain: 'L1',
    phase: 2,
    contract: 'CawClientManager',
    method: 'createClient',
    // Fees: ~$3 each at ETH=$2000 → 0.0015 ETH = 1500000000000000 wei
    args: (state, chainConfig) => ['CAW Protocol', state.deployerAddress, CHAINS[chainConfig.env + 'L2'].lzEid, '1500000000000000', '1500000000000000', '1500000000000000', '1500000000000000'],
    condition: (state) => state.addresses.CawClientManager,
    skipIf: async (state, deployer) => {
      return state.linking?.clientCreated === true;
    },
    onSuccess: (state) => {
      state.linking = state.linking || {};
      state.linking.clientCreated = true;
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
  {
    name: 'Set L2 peer on CawProfile (to L2 CawProfileL2)',
    chain: 'L1',
    phase: 2,
    contract: 'CawProfile',
    method: 'setL2Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2'].lzEid,
      state.addresses.CawProfileL2_L2,
    ],
    condition: (state) => state.addresses.CawProfile && state.addresses.CawProfileL2_L2,
  },
  {
    name: 'Set L2b peer on CawProfile (to L2b CawProfileL2)',
    chain: 'L1',
    phase: 2,
    contract: 'CawProfile',
    method: 'setL2Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2b'].lzEid,
      state.addresses.CawProfileL2_L2b,
    ],
    condition: (state) => state.addresses.CawProfile && state.addresses.CawProfileL2_L2b,
  },
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
  {
    name: 'Set CawProfile on ClientManager',
    chain: 'L1',
    phase: 2,
    contract: 'CawClientManager',
    method: 'setCawProfile',
    args: (state) => [
      state.addresses.CawProfile,
    ],
    condition: (state) => state.addresses.CawClientManager && state.addresses.CawProfile,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawClientManager');
      if (!contract) return false;
      try {
        const current = await contract.cawProfile();
        return current !== '0x0000000000000000000000000000000000000000';
      } catch { return false; }
    },
  },

  // Phase 3 linking (L2 - Base Sepolia)
  {
    name: 'Set L1 peer on CawProfileL2_L2',
    chain: 'L2',
    phase: 3,
    contract: 'CawProfileL2_L2',
    method: 'setL1Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawProfile,
      false, // don't bypass LZ for cross-chain
    ],
    condition: (state) => state.addresses.CawProfileL2_L2 && state.addresses.CawProfile,
  },
  {
    name: 'Link CawProfileL2_L2 to CawActions_L2',
    chain: 'L2',
    phase: 3,
    contract: 'CawProfileL2_L2',
    method: 'setCawActions',
    getter: 'cawActions',
    args: (state) => [state.addresses.CawActions_L2],
    condition: (state) => state.addresses.CawProfileL2_L2 && state.addresses.CawActions_L2,
  },
  // Phase 3 linking (L2b - Arbitrum Sepolia)
  {
    name: 'Set L1 peer on CawProfileL2_L2b',
    chain: 'L2b',
    phase: 3,
    contract: 'CawProfileL2_L2b',
    method: 'setL1Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawProfile,
      false,
    ],
    condition: (state) => state.addresses.CawProfileL2_L2b && state.addresses.CawProfile,
  },
  {
    name: 'Link CawProfileL2_L2b to CawActions_L2b',
    chain: 'L2b',
    phase: 3,
    contract: 'CawProfileL2_L2b',
    method: 'setCawActions',
    getter: 'cawActions',
    args: (state) => [state.addresses.CawActions_L2b],
    condition: (state) => state.addresses.CawProfileL2_L2b && state.addresses.CawActions_L2b,
  },
  // Phase 5: Fraud-proof LZ wiring.
  //   Archive ↔ relay are pinned as each other's sole LZ peers. Once these are
  //   set, the archive owner can renounce — from then on every challenge MUST
  //   come from the canonical CawChallengeRelay via LZ, nothing else is accepted.
  {
    name: 'Set LZ peer on CawActionsArchive_L2b (accepts from L2 CawChallengeRelay)',
    chain: 'L2b',
    phase: 5,
    contract: 'CawActionsArchive_L2b',
    method: 'setPeer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2'].lzEid,
      ethers.zeroPadValue(state.addresses.CawChallengeRelay_L2, 32),
    ],
    condition: (state) => state.addresses.CawActionsArchive_L2b && state.addresses.CawChallengeRelay_L2,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawActionsArchive_L2b');
      if (!contract) return false;
      const l2Eid = CHAINS[deployer.getChainKey('L2')].lzEid;
      const expected = ethers.zeroPadValue(deployer.state.addresses.CawChallengeRelay_L2, 32);
      try {
        const peer = await contract.peers(l2Eid);
        return peer.toLowerCase() === expected.toLowerCase();
      } catch { return false; }
    },
  },
  {
    name: 'Set LZ peer on CawChallengeRelay_L2 (targets L2b CawActionsArchive)',
    chain: 'L2',
    phase: 5,
    contract: 'CawChallengeRelay_L2',
    method: 'setPeer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2b'].lzEid,
      ethers.zeroPadValue(state.addresses.CawActionsArchive_L2b, 32),
    ],
    condition: (state) => state.addresses.CawChallengeRelay_L2 && state.addresses.CawActionsArchive_L2b,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawChallengeRelay_L2');
      if (!contract) return false;
      const l2bEid = CHAINS[deployer.getChainKey('L2b')].lzEid;
      const expected = ethers.zeroPadValue(deployer.state.addresses.CawActionsArchive_L2b, 32);
      try {
        const peer = await contract.peers(l2bEid);
        return peer.toLowerCase() === expected.toLowerCase();
      } catch { return false; }
    },
  },

  // Client replication registry. `CawClientManager.addReplication` records each
  // destination chain on L1 and emits `ClientChainsSet` on L2 via LayerZero so
  // indexers pick up the config. The new optimistic archive doesn't gate on this
  // registry, but it's load-bearing metadata for the multi-chain replication
  // roadmap and for any L2-side indexer.
  // Register client 1's replication destinations. Each addReplication call fires
  // a single L1 → L2-storage LZ message with the updated chain list so indexers
  // on L2 see the change. msg.value funds that LZ message.
  {
    name: 'Add replication for client 1 → L2b (archive chain)',
    chain: 'L1',
    phase: 5,
    contract: 'CawClientManager',
    method: 'addReplication',
    args: (state, chainConfig) => [
      1, // clientId
      CHAINS[chainConfig.env + 'L2b'].lzEid,
    ],
    condition: (state) => state.addresses.CawClientManager
      && state.addresses.CawActionsArchive_L2b
      && state.addresses.CawProfile,
    skipIf: async (state, deployer, chainConfig) => {
      const cm = deployer.getContract('CawClientManager');
      if (!cm) return false;
      const l2bEid = CHAINS[chainConfig.env + 'L2b'].lzEid;
      try {
        const eids = await cm.getClientChainEids(1);
        return eids.map(e => Number(e)).includes(l2bEid);
      } catch { return false; }
    },
    overrides: async (state, deployer, chainConfig) => {
      const quoter = deployer.getContract('CawProfileQuoter');
      if (!quoter) return { value: ethers.parseEther('0.0002') };
      try {
        const l2bEid = CHAINS[chainConfig.env + 'L2b'].lzEid;
        const l2Eid = CHAINS[chainConfig.env + 'L2'].lzEid;
        const quote = await quoter.syncReplicationQuote(1, [l2bEid], l2Eid, false);
        return { value: (quote.nativeFee * 120n) / 100n };
      } catch {
        return { value: ethers.parseEther('0.0002') };
      }
    },
  },
  {
    name: 'Add replication for client 1 → L2 (storage chain)',
    chain: 'L1',
    phase: 5,
    contract: 'CawClientManager',
    method: 'addReplication',
    args: (state, chainConfig) => [1, CHAINS[chainConfig.env + 'L2'].lzEid],
    condition: (state) => state.addresses.CawClientManager
      && state.addresses.CawActions_L2
      && state.addresses.CawProfile,
    skipIf: async (state, deployer, chainConfig) => {
      const cm = deployer.getContract('CawClientManager');
      if (!cm) return false;
      const l2Eid = CHAINS[chainConfig.env + 'L2'].lzEid;
      try {
        const eids = await cm.getClientChainEids(1);
        return eids.map(e => Number(e)).includes(l2Eid);
      } catch { return false; }
    },
    overrides: async (state, deployer, chainConfig) => {
      const quoter = deployer.getContract('CawProfileQuoter');
      if (!quoter) return { value: ethers.parseEther('0.0002') };
      try {
        const l2Eid = CHAINS[chainConfig.env + 'L2'].lzEid;
        const quote = await quoter.syncReplicationQuote(1, [l2Eid], l2Eid, false);
        return { value: (quote.nativeFee * 120n) / 100n };
      } catch {
        return { value: ethers.parseEther('0.0002') };
      }
    },
  },

  // Phase 5: Marketplace payment token configuration
  // WETH
  {
    name: 'Allow WETH as marketplace payment token',
    chain: 'L1',
    phase: 5,
    contract: 'CawProfileMarketplace',
    method: 'setAllowedPaymentToken',
    args: () => ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', true], // Mainnet WETH
    condition: (state) => !!state.addresses.CawProfileMarketplace,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawProfileMarketplace');
      if (!contract) return false;
      try { return await contract.allowedPaymentTokens('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'); } catch { return false; }
    },
  },
  // USDC
  {
    name: 'Allow USDC as marketplace payment token',
    chain: 'L1',
    phase: 5,
    contract: 'CawProfileMarketplace',
    method: 'setAllowedPaymentToken',
    args: () => ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', true], // Mainnet USDC
    condition: (state) => !!state.addresses.CawProfileMarketplace,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawProfileMarketplace');
      if (!contract) return false;
      try { return await contract.allowedPaymentTokens('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'); } catch { return false; }
    },
  },
  // USDT
  {
    name: 'Allow USDT as marketplace payment token',
    chain: 'L1',
    phase: 5,
    contract: 'CawProfileMarketplace',
    method: 'setAllowedPaymentToken',
    args: () => ['0xdAC17F958D2ee523a2206206994597C13D831ec7', true], // Mainnet USDT
    condition: (state) => !!state.addresses.CawProfileMarketplace,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawProfileMarketplace');
      if (!contract) return false;
      try { return await contract.allowedPaymentTokens('0xdAC17F958D2ee523a2206206994597C13D831ec7'); } catch { return false; }
    },
  },
  // CAW
  {
    name: 'Allow CAW as marketplace payment token',
    chain: 'L1',
    phase: 5,
    contract: 'CawProfileMarketplace',
    method: 'setAllowedPaymentToken',
    args: (state) => [state.addresses.MintableCaw || state.addresses.CAW, true],
    condition: (state) => !!state.addresses.CawProfileMarketplace && !!(state.addresses.MintableCaw || state.addresses.CAW),
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawProfileMarketplace');
      if (!contract) return false;
      const cawAddr = state.addresses.MintableCaw || state.addresses.CAW;
      if (!cawAddr) return false;
      try { return await contract.allowedPaymentTokens(cawAddr); } catch { return false; }
    },
  },

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
    custom: async (state, deployer, chainConfig) => {
      await configureLzDvns(state, deployer, chainConfig, CHAINS);
    },
  },
];

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

    const args = config.constructorArgs(this.state, chainKey);
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

    if (step.condition && !step.condition(this.state)) {
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

    // Get contracts for this phase
    const phaseContracts = Object.entries(CONTRACTS)
      .filter(([_, config]) => config.phase === phase)
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
    // no-op on testnet/dev environments).
    for (const phase of [1, 2, 3, 4, 5, 6]) {
      await this.deployPhase(phase);
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
    // Only clear clientCreated if CawClientManager itself is being redeployed
    if (toRedeploy.has('CawClientManager')) {
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
    const phases = {
      1: 'L2 + L2b CawProfileL2 (Phase 1)',
      2: 'L1 (Phase 2)',
      3: 'L2 + L2b CawActions (Phase 3)',
      4: 'Optimistic replication (L2b archive, L2 challenge relay) (Phase 4)',
      5: 'Cross-chain wiring + client replication registry (Phase 5)',
    };
    for (const phase of [1, 2, 3, 4, 5]) {
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
// CLI
// ============================================

async function main() {
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
  Phase 5: LZ peering between archive and relay + register client replication targets

Architecture:
  L1 (Sepolia): CawProfile, CawClientManager, CawProfileMinter, CawProfileQuoter
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

  // Update client addresses and regenerate ABIs
  if (!skipAbi) {
    // Update addresses.ts with new deployment addresses
    const addressesFile = path.join(__dirname, '../../client/src/abi/addresses.ts');
    const addressMap = {
      MintableCaw: 'CAW_ADDRESS',
      CawProfile: 'CAW_NAMES_ADDRESS',
      CawProfileQuoter: 'CAW_NAME_QUOTER_ADDRESS',
      CawProfileMinter: 'CAW_NAMES_MINTER_ADDRESS',
      CawProfileURI: 'URI_GENERATOR_ADDRESS',
      CawClientManager: 'CLIENT_MANAGER_ADDRESS',
      CawProfileL2_L2: 'CAW_NAMES_L2_ADDRESS',
      CawProfileL2_L1: 'CAW_NAMES_L2_MAINNET_ADDRESS',
      CawActions_L1: 'CAW_ACTIONS_MAINNET_ADDRESS',
      CawActions_L2: 'CAW_ACTIONS_ADDRESS',
      CawActionsArchive_L2b: 'CAW_ACTIONS_ARCHIVE_OPTIMISTIC_ADDRESS',
      CawChallengeRelay_L2: 'CAW_CHALLENGE_RELAY_ADDRESS',
      CawProfileMarketplace: 'CAW_NAME_MARKETPLACE_ADDRESS',
    };

    try {
      let content = fs.readFileSync(addressesFile, 'utf8');
      for (const [stateKey, constName] of Object.entries(addressMap)) {
        const addr = deployer.state.addresses[stateKey];
        if (addr) {
          const regex = new RegExp(`(export const ${constName} = ['"])0x[a-fA-F0-9]+(['"])`);
          content = content.replace(regex, `$1${addr}$2`);
        }
      }
      fs.writeFileSync(addressesFile, content);
      console.log('\nUpdated client/src/abi/addresses.ts');
    } catch (e) {
      console.warn('\nFailed to update addresses.ts:', e.message);
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
