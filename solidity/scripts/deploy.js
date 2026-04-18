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
 *   Phase 1: L2a + L2b - Deploy CawNameL2 on both L2 chains
 *   Phase 2: L1 - Deploy all L1 contracts (CawName, CawClientManager, etc.)
 *   Phase 3: L2a + L2b - Deploy remaining L2 contracts (CawActions, Replicator)
 *   Phase 4: L2a + L2b - Deploy CawActionsArchive on each chain (for cross-replication)
 *   Phase 5: Cross-chain - Register archive chains, set LZ peers, addReplication
 *
 * ARCHITECTURE (testnet):
 *   L1 (Sepolia): CawName, CawClientManager, CawNameMinter, CawNameQuoter
 *   L2 (Base Sepolia): CawNameL2, CawActions, CawActionsReplicator, CawActionsArchive
 *   L2b (Arbitrum Sepolia): CawNameL2, CawActions, CawActionsReplicator, CawActionsArchive
 *   Each L2's Replicator archives to the other L2's CawActionsArchive.
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
  // Phase 1: Deploy CawNameL2 on both L2 chains (needed by L1 CawName for cross-chain setup)
  CawNameL2_L2: {
    artifact: 'CawNameL2',
    chain: 'L2',
    phase: 1,
    dependencies: [],
    constructorArgs: (state, chain) => [
      CHAINS[chain.replace('L2', 'L1')].lzEid, // peer network eid (L1)
      CHAINS[chain].lzEndpoint,
    ],
  },
  CawNameL2_L2b: {
    artifact: 'CawNameL2',
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
  // glyph paths for on-chain SVG rendering. CawNameURI reads from them via
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
  CawNameURI: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawFontDataA', 'CawFontDataB'],
    constructorArgs: (state) => [
      state.addresses.CawFontDataA,
      state.addresses.CawFontDataB,
    ],
    // Dependents (CawName) have a runtime setter (`setUriGenerator`) so a
    // URI redeploy does NOT need to cascade. The post-deploy linking step
    // `Link CawName to CawNameURI` handles rewiring. This breaks the normal
    // transitive-closure cascade at this node.
    cascadeBreak: true,
  },
  CawClientManager: {
    chain: 'L1',
    phase: 2,
    dependencies: [],
    constructorArgs: (state) => [state.deployerAddress], // buyAndBurnAddress
  },
  CawName: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawNameL2_L2', 'CawNameL2_L2b', 'CawNameURI', 'CawClientManager'],
    constructorArgs: (state, chain) => [
      state.addresses.MintableCaw,
      state.addresses.CawNameURI,
      state.deployerAddress, // buyAndBurnAddress
      state.addresses.CawClientManager,
      CHAINS[chain].lzEndpoint,
      CHAINS[chain].lzEid,
    ],
  },
  CawNameL2_L1: {
    // CawNameL2 deployed on L1 (for local actions without cross-chain)
    artifact: 'CawNameL2',
    chain: 'L1',
    phase: 2,
    dependencies: [],
    constructorArgs: (state, chain) => [
      CHAINS[chain.replace('L1', 'L2')].lzEid, // peer network eid (L2)
      CHAINS[chain].lzEndpoint,
    ],
  },
  CawNameMinter: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawName'],
    constructorArgs: (state) => [
      state.addresses.MintableCaw,
      state.addresses.CawName,
    ],
  },
  CawNameQuoter: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawName'],
    constructorArgs: (state) => [state.addresses.CawName],
  },
  CawNameMarketplace: {
    chain: 'L1',
    phase: 2,
    dependencies: ['CawName'],
    constructorArgs: (state) => [state.addresses.CawName],
  },
  CawActions_L1: {
    artifact: 'CawActions',
    chain: 'L1',
    phase: 2,
    dependencies: ['CawNameL2_L1'],
    constructorArgs: (state) => [state.addresses.CawNameL2_L1],
  },
  CawActionsReplicator_L1: {
    artifact: 'CawActionsReplicator',
    chain: 'L1',
    phase: 2,
    dependencies: ['CawActions_L1', 'CawNameL2_L1'],
    constructorArgs: (state, chain) => [
      CHAINS[chain].lzEndpoint,
      state.addresses.CawActions_L1,
      state.addresses.CawNameL2_L1,
    ],
  },

  // Phase 3: Deploy remaining L2 contracts on both chains
  CawActions_L2: {
    artifact: 'CawActions',
    chain: 'L2',
    phase: 3,
    dependencies: ['CawNameL2_L2'],
    constructorArgs: (state) => [state.addresses.CawNameL2_L2],
  },
  CawActionsReplicator_L2: {
    artifact: 'CawActionsReplicator',
    chain: 'L2',
    phase: 3,
    dependencies: ['CawActions_L2', 'CawNameL2_L2'],
    constructorArgs: (state, chain) => [
      CHAINS[chain].lzEndpoint,
      state.addresses.CawActions_L2,
      state.addresses.CawNameL2_L2,
    ],
  },
  CawActions_L2b: {
    artifact: 'CawActions',
    chain: 'L2b',
    phase: 3,
    dependencies: ['CawNameL2_L2b'],
    constructorArgs: (state) => [state.addresses.CawNameL2_L2b],
  },
  CawActionsReplicator_L2b: {
    artifact: 'CawActionsReplicator',
    chain: 'L2b',
    phase: 3,
    dependencies: ['CawActions_L2b', 'CawNameL2_L2b'],
    constructorArgs: (state, chain) => [
      CHAINS[chain].lzEndpoint,
      state.addresses.CawActions_L2b,
      state.addresses.CawNameL2_L2b,
    ],
  },

  // Phase 4: Deploy CawActionsArchive on each L2 (receives replications from the other)
  CawActionsArchive_L2: {
    artifact: 'CawActionsArchive',
    chain: 'L2',
    phase: 4,
    dependencies: [],
    constructorArgs: (state, chain) => [CHAINS[chain].lzEndpoint],
  },
  CawActionsArchive_L2b: {
    artifact: 'CawActionsArchive',
    chain: 'L2b',
    phase: 4,
    dependencies: [],
    constructorArgs: (state, chain) => [CHAINS[chain].lzEndpoint],
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
    name: 'Set L1 peer on CawNameL2_L1 (bypassLZ=true)',
    chain: 'L1',
    phase: 2,
    contract: 'CawNameL2_L1',
    method: 'setL1Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawName,
      true, // bypassLZ for local
    ],
    condition: (state) => state.addresses.CawNameL2_L1 && state.addresses.CawName,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawNameL2_L1');
      if (!contract) return false;
      try {
        return await contract.bypassLZ();
      } catch { return false; }
    },
  },
  {
    name: 'Set L2 peer on CawName (to L1 local CawNameL2)',
    chain: 'L1',
    phase: 2,
    contract: 'CawName',
    method: 'setL2Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawNameL2_L1,
    ],
    condition: (state) => state.addresses.CawName && state.addresses.CawNameL2_L1,
  },
  {
    name: 'Set L2 peer on CawName (to L2 CawNameL2)',
    chain: 'L1',
    phase: 2,
    contract: 'CawName',
    method: 'setL2Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2'].lzEid,
      state.addresses.CawNameL2_L2,
    ],
    condition: (state) => state.addresses.CawName && state.addresses.CawNameL2_L2,
  },
  {
    name: 'Set L2b peer on CawName (to L2b CawNameL2)',
    chain: 'L1',
    phase: 2,
    contract: 'CawName',
    method: 'setL2Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2b'].lzEid,
      state.addresses.CawNameL2_L2b,
    ],
    condition: (state) => state.addresses.CawName && state.addresses.CawNameL2_L2b,
  },
  {
    name: 'Set minter on CawName',
    chain: 'L1',
    phase: 2,
    contract: 'CawName',
    method: 'setMinter',
    args: (state) => [state.addresses.CawNameMinter],
    condition: (state) => state.addresses.CawName && state.addresses.CawNameMinter,
  },
  {
    // This linking step exists because CawNameURI has cascadeBreak=true:
    // redeploying CawNameURI does NOT redeploy CawName, so we need to
    // rewire the URI generator address here via the setter.
    name: 'Link CawName to CawNameURI',
    chain: 'L1',
    phase: 2,
    contract: 'CawName',
    method: 'setUriGenerator',
    args: (state) => [state.addresses.CawNameURI],
    condition: (state) => state.addresses.CawName && state.addresses.CawNameURI,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawName');
      if (!contract) return false;
      try {
        const current = await contract.uriGenerator();
        return current.toLowerCase() === state.addresses.CawNameURI.toLowerCase();
      } catch { return false; }
    },
  },
  {
    name: 'Link CawNameL2_L1 to CawActions_L1',
    chain: 'L1',
    phase: 2,
    contract: 'CawNameL2_L1',
    method: 'setCawActions',
    args: (state) => [state.addresses.CawActions_L1],
    condition: (state) => state.addresses.CawNameL2_L1 && state.addresses.CawActions_L1,
  },
  {
    name: 'Link CawNameL2_L1 to replicator',
    chain: 'L1',
    phase: 2,
    contract: 'CawNameL2_L1',
    method: 'setCawActionsReplicator',
    args: (state) => [state.addresses.CawActionsReplicator_L1],
    condition: (state) => state.addresses.CawNameL2_L1 && state.addresses.CawActionsReplicator_L1,
  },
  {
    name: 'Set CawName on ClientManager',
    chain: 'L1',
    phase: 2,
    contract: 'CawClientManager',
    method: 'setCawName',
    args: (state) => [
      state.addresses.CawName,
    ],
    condition: (state) => state.addresses.CawClientManager && state.addresses.CawName,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawClientManager');
      if (!contract) return false;
      try {
        const current = await contract.cawName();
        return current !== '0x0000000000000000000000000000000000000000';
      } catch { return false; }
    },
  },

  // Phase 3 linking (L2 - Base Sepolia)
  {
    name: 'Set L1 peer on CawNameL2_L2',
    chain: 'L2',
    phase: 3,
    contract: 'CawNameL2_L2',
    method: 'setL1Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawName,
      false, // don't bypass LZ for cross-chain
    ],
    condition: (state) => state.addresses.CawNameL2_L2 && state.addresses.CawName,
  },
  {
    name: 'Link CawNameL2_L2 to CawActions_L2',
    chain: 'L2',
    phase: 3,
    contract: 'CawNameL2_L2',
    method: 'setCawActions',
    args: (state) => [state.addresses.CawActions_L2],
    condition: (state) => state.addresses.CawNameL2_L2 && state.addresses.CawActions_L2,
  },
  {
    name: 'Link CawNameL2_L2 to replicator',
    chain: 'L2',
    phase: 3,
    contract: 'CawNameL2_L2',
    method: 'setCawActionsReplicator',
    args: (state) => [state.addresses.CawActionsReplicator_L2],
    condition: (state) => state.addresses.CawNameL2_L2 && state.addresses.CawActionsReplicator_L2,
  },

  // Phase 3 linking (L2b - Arbitrum Sepolia)
  {
    name: 'Set L1 peer on CawNameL2_L2b',
    chain: 'L2b',
    phase: 3,
    contract: 'CawNameL2_L2b',
    method: 'setL1Peer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L1'].lzEid,
      state.addresses.CawName,
      false,
    ],
    condition: (state) => state.addresses.CawNameL2_L2b && state.addresses.CawName,
  },
  {
    name: 'Link CawNameL2_L2b to CawActions_L2b',
    chain: 'L2b',
    phase: 3,
    contract: 'CawNameL2_L2b',
    method: 'setCawActions',
    args: (state) => [state.addresses.CawActions_L2b],
    condition: (state) => state.addresses.CawNameL2_L2b && state.addresses.CawActions_L2b,
  },
  {
    name: 'Link CawNameL2_L2b to replicator',
    chain: 'L2b',
    phase: 3,
    contract: 'CawNameL2_L2b',
    method: 'setCawActionsReplicator',
    args: (state) => [state.addresses.CawActionsReplicator_L2b],
    condition: (state) => state.addresses.CawNameL2_L2b && state.addresses.CawActionsReplicator_L2b,
  },

  // Phase 5: Cross-chain replication setup
  // L2's archive (on L2b) receives from L2's replicator
  {
    name: 'Set LZ peer on CawActionsArchive_L2b (accepts from L2 Replicator)',
    chain: 'L2b',
    phase: 5,
    contract: 'CawActionsArchive_L2b',
    method: 'setPeer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2'].lzEid,
      ethers.zeroPadValue(state.addresses.CawActionsReplicator_L2, 32),
    ],
    condition: (state) => state.addresses.CawActionsArchive_L2b && state.addresses.CawActionsReplicator_L2,
    skipIf: async (state, deployer) => {
      // Skip only if the peer already matches the CURRENT replicator address.
      // A previous "skip if peer != ZeroHash" here left stale peers pointing
      // at pre-redeploy replicators, silently breaking replication.
      const contract = deployer.getContract('CawActionsArchive_L2b');
      if (!contract) return false;
      const l2Eid = CHAINS[deployer.getChainKey('L2')].lzEid;
      const expected = ethers.zeroPadValue(deployer.state.addresses.CawActionsReplicator_L2, 32);
      try {
        const peer = await contract.peers(l2Eid);
        return peer.toLowerCase() === expected.toLowerCase();
      } catch { return false; }
    },
  },
  // L2b's archive (on L2) receives from L2b's replicator
  {
    name: 'Set LZ peer on CawActionsArchive_L2 (accepts from L2b Replicator)',
    chain: 'L2',
    phase: 5,
    contract: 'CawActionsArchive_L2',
    method: 'setPeer',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2b'].lzEid,
      ethers.zeroPadValue(state.addresses.CawActionsReplicator_L2b, 32),
    ],
    condition: (state) => state.addresses.CawActionsArchive_L2 && state.addresses.CawActionsReplicator_L2b,
    skipIf: async (state, deployer) => {
      // Skip only if already pointed at the current replicator — see note above.
      const contract = deployer.getContract('CawActionsArchive_L2');
      if (!contract) return false;
      const l2bEid = CHAINS[deployer.getChainKey('L2b')].lzEid;
      const expected = ethers.zeroPadValue(deployer.state.addresses.CawActionsReplicator_L2b, 32);
      try {
        const peer = await contract.peers(l2bEid);
        return peer.toLowerCase() === expected.toLowerCase();
      } catch { return false; }
    },
  },
  // Register L2b as archive chain on L2's replicator (L2 replicates TO L2b)
  {
    name: 'Register L2b archive chain on CawActionsReplicator_L2',
    chain: 'L2',
    phase: 5,
    contract: 'CawActionsReplicator_L2',
    method: 'addArchiveChain',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2b'].lzEid,
      state.addresses.CawActionsArchive_L2b,
    ],
    condition: (state) => state.addresses.CawActionsReplicator_L2 && state.addresses.CawActionsArchive_L2b,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawActionsReplicator_L2');
      if (!contract) return false;
      const l2bEid = CHAINS[deployer.getChainKey('L2b')].lzEid;
      try {
        return await contract.isAvailableChain(l2bEid);
      } catch { return false; }
    },
  },
  // Register L2 as archive chain on L2b's replicator (L2b replicates TO L2)
  {
    name: 'Register L2 archive chain on CawActionsReplicator_L2b',
    chain: 'L2b',
    phase: 5,
    contract: 'CawActionsReplicator_L2b',
    method: 'addArchiveChain',
    args: (state, chainConfig) => [
      CHAINS[chainConfig.env + 'L2'].lzEid,
      state.addresses.CawActionsArchive_L2,
    ],
    condition: (state) => state.addresses.CawActionsReplicator_L2b && state.addresses.CawActionsArchive_L2,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawActionsReplicator_L2b');
      if (!contract) return false;
      const l2Eid = CHAINS[deployer.getChainKey('L2')].lzEid;
      try {
        return await contract.isAvailableChain(l2Eid);
      } catch { return false; }
    },
  },
  // Bump LZ maxMessageSize on replicators so 256-action batches can be sent.
  // Default is 10KB but a full checkpoint with text can be ~120KB.
  {
    name: 'Set LZ maxMessageSize on CawActionsReplicator_L2 → L2b',
    chain: 'L2',
    phase: 5,
    custom: async (state, deployer, chainConfig) => {
      const chainKey = deployer.getChainKey('L2');
      const LZ_ENDPOINT = CHAINS[chainKey].lzEndpoint;
      const replicator = state.addresses.CawActionsReplicator_L2;
      const destEid = CHAINS[chainConfig.env + 'L2b'].lzEid;
      const MAX_MESSAGE_SIZE = 300000; // 300KB — fits worst-case 256 actions with 420-char text + recipients arrays
      const EXECUTOR_CONFIG_TYPE = 1;

      const endpointAbi = [
        'function getSendLibrary(address,uint32) view returns (address)',
        'function getConfig(address,address,uint32,uint32) view returns (bytes)',
        'function setConfig(address,address,tuple(uint32 eid,uint32 configType,bytes config)[]) external',
      ];
      const wallet = deployer.wallets[chainKey];
      const endpoint = new ethers.Contract(LZ_ENDPOINT, endpointAbi, wallet);
      const sendLib = await endpoint.getSendLibrary(replicator, destEid);

      // Check current config
      const currentBytes = await endpoint.getConfig(replicator, sendLib, destEid, EXECUTOR_CONFIG_TYPE);
      const [currentMax, executor] = ethers.AbiCoder.defaultAbiCoder().decode(['uint32', 'address'], currentBytes);
      if (Number(currentMax) >= MAX_MESSAGE_SIZE) {
        console.log(`   Already ${currentMax} >= ${MAX_MESSAGE_SIZE}, skipping`);
        return;
      }

      const newConfig = ethers.AbiCoder.defaultAbiCoder().encode(['uint32', 'address'], [MAX_MESSAGE_SIZE, executor]);
      const tx = await endpoint.setConfig(replicator, sendLib, [{ eid: destEid, configType: EXECUTOR_CONFIG_TYPE, config: newConfig }]);
      await tx.wait();
      console.log(`   Set maxMessageSize to ${MAX_MESSAGE_SIZE} on L2 replicator → L2b`);
    },
    condition: (state) => state.addresses.CawActionsReplicator_L2,
  },
  {
    name: 'Set LZ maxMessageSize on CawActionsReplicator_L2b → L2',
    chain: 'L2b',
    phase: 5,
    custom: async (state, deployer, chainConfig) => {
      const chainKey = deployer.getChainKey('L2b');
      const LZ_ENDPOINT = CHAINS[chainKey].lzEndpoint;
      const replicator = state.addresses.CawActionsReplicator_L2b;
      const destEid = CHAINS[chainConfig.env + 'L2'].lzEid;
      const MAX_MESSAGE_SIZE = 200000;
      const EXECUTOR_CONFIG_TYPE = 1;

      const endpointAbi = [
        'function getSendLibrary(address,uint32) view returns (address)',
        'function getConfig(address,address,uint32,uint32) view returns (bytes)',
        'function setConfig(address,address,tuple(uint32 eid,uint32 configType,bytes config)[]) external',
      ];
      const wallet = deployer.wallets[chainKey];
      const endpoint = new ethers.Contract(LZ_ENDPOINT, endpointAbi, wallet);
      const sendLib = await endpoint.getSendLibrary(replicator, destEid);

      const currentBytes = await endpoint.getConfig(replicator, sendLib, destEid, EXECUTOR_CONFIG_TYPE);
      const [currentMax, executor] = ethers.AbiCoder.defaultAbiCoder().decode(['uint32', 'address'], currentBytes);
      if (Number(currentMax) >= MAX_MESSAGE_SIZE) {
        console.log(`   Already ${currentMax} >= ${MAX_MESSAGE_SIZE}, skipping`);
        return;
      }

      const newConfig = ethers.AbiCoder.defaultAbiCoder().encode(['uint32', 'address'], [MAX_MESSAGE_SIZE, executor]);
      const tx = await endpoint.setConfig(replicator, sendLib, [{ eid: destEid, configType: EXECUTOR_CONFIG_TYPE, config: newConfig }]);
      await tx.wait();
      console.log(`   Set maxMessageSize to ${MAX_MESSAGE_SIZE} on L2b replicator → L2`);
    },
    condition: (state) => state.addresses.CawActionsReplicator_L2b,
  },
  // Add replication for client 1 on L2 (syncs to L2 via LZ — client replicates to L2b's archive)
  //
  // This runs once when the client is first enrolled. The skipIf compares
  // against the clientManager's state: if this client is already enrolled for
  // the archive EID, we skip the enrollment. The separate "Force sync" step
  // below handles the case where the REPLICATOR was just redeployed and needs
  // a fresh `setClientChains` LZ message even though the clientManager's
  // enrollment is unchanged.
  {
    name: 'Add replication for client 1 on L2 (archive to L2b)',
    chain: 'L1',
    phase: 5,
    contract: 'CawClientManager',
    method: 'addReplication',
    args: (state, chainConfig) => [
      1, // clientId
      CHAINS[chainConfig.env + 'L2b'].lzEid,
    ],
    condition: (state) => state.addresses.CawClientManager && state.addresses.CawActionsArchive_L2b && state.addresses.CawName,
    skipIf: async (state, deployer, chainConfig) => {
      const cm = deployer.getContract('CawClientManager');
      if (!cm) return false;
      const l2bEid = CHAINS[chainConfig.env + 'L2b'].lzEid;
      try {
        // Skip only if this SPECIFIC eid is already in the client's chain list.
        // Previously compared only `clientReplicationEnabled(1)` (true if ANY
        // eid is enrolled) which wrongly skipped on subsequent target chains.
        const eids = await cm.getClientChainEids(1);
        return eids.map(e => Number(e)).includes(l2bEid);
      } catch { return false; }
    },
    overrides: async (state, deployer, chainConfig) => {
      const quoter = deployer.getContract('CawNameQuoter');
      if (!quoter) {
        console.log('   CawNameQuoter not available, using 0.0002 ETH as fallback');
        return { value: ethers.parseEther('0.0002') };
      }
      try {
        const l2bEid = CHAINS[chainConfig.env + 'L2b'].lzEid;
        const l2Eid = CHAINS[chainConfig.env + 'L2'].lzEid;
        const quote = await quoter.syncReplicationQuote(1, [l2bEid], l2Eid, false);
        const feeWithBuffer = (quote.nativeFee * 120n) / 100n;
        console.log(`   LZ fee quoted: ${ethers.formatEther(quote.nativeFee)} ETH (sending ${ethers.formatEther(feeWithBuffer)} with buffer)`);
        return { value: feeWithBuffer };
      } catch (e) {
        console.log(`   Fee quote failed: ${e.message}, using 0.0002 ETH as fallback`);
        return { value: ethers.parseEther('0.0002') };
      }
    },
  },
  // Add the reverse direction: client 1 also replicates FROM L2b TO L2's archive.
  // The ClientManager stores a global chain list; each replicator's setClientChains
  // now skips EIDs it doesn't have registered (graceful filter instead of revert).
  {
    name: 'Add replication for client 1 on L2b (archive to L2)',
    chain: 'L1',
    phase: 5,
    contract: 'CawClientManager',
    method: 'addReplication',
    args: (state, chainConfig) => [
      1, // clientId
      CHAINS[chainConfig.env + 'L2'].lzEid,
    ],
    condition: (state) => state.addresses.CawClientManager && state.addresses.CawActionsArchive_L2 && state.addresses.CawName,
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
      const quoter = deployer.getContract('CawNameQuoter');
      if (!quoter) return { value: ethers.parseEther('0.0002') };
      try {
        const l2Eid = CHAINS[chainConfig.env + 'L2'].lzEid;
        const quote = await quoter.syncReplicationQuote(1, [l2Eid], l2Eid, false);
        const feeWithBuffer = (quote.nativeFee * 120n) / 100n;
        return { value: feeWithBuffer };
      } catch {
        return { value: ethers.parseEther('0.0002') };
      }
    },
  },
  // Force-sync replication config to L2 when the replicator was redeployed.
  // `clientManager.addReplication` already auto-syncs to L2 when called, but
  // only fires when the CLIENT MANAGER's state needs updating. If we just
  // redeployed the L2 replicator with the clientManager untouched, the new
  // replicator has `clientChainEnabled[1][destEid] = false` until the next
  // sync. This step checks the replicator directly and calls
  // `CawName.syncReplication` on L1 if the flag isn't set.
  {
    name: 'Force syncReplication if new replicator missing clientChainEnabled',
    chain: 'L1',
    phase: 5,
    contract: 'CawName',
    method: 'syncReplication',
    args: (state, chainConfig) => [
      1, // clientId
      CHAINS[chainConfig.env + 'L2'].lzEid, // storage chain — where CawNameL2 lives
      0, // lzTokenAmount
    ],
    condition: (state) => state.addresses.CawName && state.addresses.CawActionsReplicator_L2,
    skipIf: async (state, deployer, chainConfig) => {
      // Query the L2 replicator directly to see if the client/dest pair is
      // already enabled there. If yes, skip — no LZ sync needed.
      const chainKey = deployer.getChainKey('L2');
      await deployer.initChain(chainKey);
      const replicatorAddr = deployer.state.addresses.CawActionsReplicator_L2;
      if (!replicatorAddr) return true; // Not yet deployed — earlier step will handle
      const provider = deployer.wallets[chainKey].provider;
      const replicator = new ethers.Contract(
        replicatorAddr,
        ['function clientChainEnabled(uint32,uint32) view returns (bool)'],
        provider,
      );
      const l2bEid = CHAINS[chainConfig.env + 'L2b'].lzEid;
      try {
        const enabled = await replicator.clientChainEnabled(1, l2bEid);
        if (enabled) console.log(`   clientChainEnabled(1, ${l2bEid}) = true on replicator — skipping sync`);
        return enabled;
      } catch { return false; }
    },
    overrides: async (state, deployer, chainConfig) => {
      const quoter = deployer.getContract('CawNameQuoter');
      if (!quoter) return { value: ethers.parseEther('0.0002') };
      try {
        const l2bEid = CHAINS[chainConfig.env + 'L2b'].lzEid;
        const l2Eid = CHAINS[chainConfig.env + 'L2'].lzEid;
        const quote = await quoter.syncReplicationQuote(1, [l2bEid], l2Eid, false);
        const feeWithBuffer = (quote.nativeFee * 120n) / 100n;
        console.log(`   syncReplication LZ fee: ${ethers.formatEther(quote.nativeFee)} ETH (sending ${ethers.formatEther(feeWithBuffer)} with buffer)`);
        return { value: feeWithBuffer };
      } catch {
        return { value: ethers.parseEther('0.0002') };
      }
    },
  },
  // Mirror of the Force sync above but targeting L2b's replicator. Client 1's
  // storage chain is L2, but client 1 ALSO replicates FROM L2b (to L2's archive).
  // After a L2b replicator redeploy, its clientChainEnabled mapping is empty.
  // Sending syncReplication to L2b's CawNameL2 makes it call setClientChains
  // on the new L2b replicator.
  {
    name: 'Force syncReplication on L2b if new replicator missing clientChainEnabled',
    chain: 'L1',
    phase: 5,
    contract: 'CawName',
    method: 'syncReplication',
    args: (state, chainConfig) => [
      1, // clientId
      CHAINS[chainConfig.env + 'L2b'].lzEid, // target L2b's CawNameL2
      0, // lzTokenAmount
    ],
    condition: (state) => state.addresses.CawName && state.addresses.CawActionsReplicator_L2b,
    skipIf: async (state, deployer, chainConfig) => {
      const chainKey = deployer.getChainKey('L2b');
      await deployer.initChain(chainKey);
      const replicatorAddr = deployer.state.addresses.CawActionsReplicator_L2b;
      if (!replicatorAddr) return true;
      const provider = deployer.wallets[chainKey].provider;
      const replicator = new ethers.Contract(
        replicatorAddr,
        ['function clientChainEnabled(uint32,uint32) view returns (bool)'],
        provider,
      );
      const l2Eid = CHAINS[chainConfig.env + 'L2'].lzEid;
      try {
        const enabled = await replicator.clientChainEnabled(1, l2Eid);
        if (enabled) console.log(`   clientChainEnabled(1, ${l2Eid}) = true on L2b replicator — skipping sync`);
        return enabled;
      } catch { return false; }
    },
    overrides: async (state, deployer, chainConfig) => {
      const quoter = deployer.getContract('CawNameQuoter');
      if (!quoter) return { value: ethers.parseEther('0.0002') };
      try {
        const l2Eid = CHAINS[chainConfig.env + 'L2'].lzEid;
        const l2bEid = CHAINS[chainConfig.env + 'L2b'].lzEid;
        const quote = await quoter.syncReplicationQuote(1, [l2Eid], l2bEid, false);
        const feeWithBuffer = (quote.nativeFee * 120n) / 100n;
        console.log(`   syncReplication L2b LZ fee: ${ethers.formatEther(quote.nativeFee)} ETH (sending ${ethers.formatEther(feeWithBuffer)} with buffer)`);
        return { value: feeWithBuffer };
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
    contract: 'CawNameMarketplace',
    method: 'setAllowedPaymentToken',
    args: () => ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', true], // Mainnet WETH
    condition: (state) => !!state.addresses.CawNameMarketplace,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawNameMarketplace');
      if (!contract) return false;
      try { return await contract.allowedPaymentTokens('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'); } catch { return false; }
    },
  },
  // USDC
  {
    name: 'Allow USDC as marketplace payment token',
    chain: 'L1',
    phase: 5,
    contract: 'CawNameMarketplace',
    method: 'setAllowedPaymentToken',
    args: () => ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', true], // Mainnet USDC
    condition: (state) => !!state.addresses.CawNameMarketplace,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawNameMarketplace');
      if (!contract) return false;
      try { return await contract.allowedPaymentTokens('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'); } catch { return false; }
    },
  },
  // USDT
  {
    name: 'Allow USDT as marketplace payment token',
    chain: 'L1',
    phase: 5,
    contract: 'CawNameMarketplace',
    method: 'setAllowedPaymentToken',
    args: () => ['0xdAC17F958D2ee523a2206206994597C13D831ec7', true], // Mainnet USDT
    condition: (state) => !!state.addresses.CawNameMarketplace,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawNameMarketplace');
      if (!contract) return false;
      try { return await contract.allowedPaymentTokens('0xdAC17F958D2ee523a2206206994597C13D831ec7'); } catch { return false; }
    },
  },
  // CAW
  {
    name: 'Allow CAW as marketplace payment token',
    chain: 'L1',
    phase: 5,
    contract: 'CawNameMarketplace',
    method: 'setAllowedPaymentToken',
    args: (state) => [state.addresses.MintableCaw || state.addresses.CAW, true],
    condition: (state) => !!state.addresses.CawNameMarketplace && !!(state.addresses.MintableCaw || state.addresses.CAW),
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawNameMarketplace');
      if (!contract) return false;
      const cawAddr = state.addresses.MintableCaw || state.addresses.CAW;
      if (!cawAddr) return false;
      try { return await contract.allowedPaymentTokens(cawAddr); } catch { return false; }
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

    const provider = new ethers.JsonRpcProvider(config.rpc);

    await this.retry(async () => {
      const network = await provider.getNetwork();
      console.log(`   Connected to chain ID ${network.chainId}`);
    });

    const privateKeys = process.env.PRIVATE_KEYS?.split(',') || [];
    if (privateKeys.length === 0) {
      throw new Error('No PRIVATE_KEYS found in environment');
    }

    const wallet = new ethers.Wallet(privateKeys[0], provider);
    const balance = await provider.getBalance(wallet.address);
    console.log(`   Wallet: ${wallet.address} (${ethers.formatEther(balance)} ETH)`);

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

    const artifactPath = path.join(
      __dirname,
      '../artifacts/contracts',
      `${contractName}.sol`,
      `${contractName}.json`
    );

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
      // Use higher gas limit for large contracts like CawName
      const overrides = {};
      if (contractKey === 'CawName') {
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

    const args = step.args(this.state, chainConfig);

    // Support async overrides (e.g. for payable calls that need fee quoting)
    let overrides = {};
    if (step.overrides) {
      overrides = await step.overrides(this.state, this, chainConfig);
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

    // Get contracts for this phase, sorted by dependencies
    const phaseContracts = Object.entries(CONTRACTS)
      .filter(([_, config]) => config.phase === phase)
      .map(([key, _]) => key);

    // Deploy in dependency order
    const deployed = new Set(Object.keys(this.state.addresses));
    const toDeploy = [...phaseContracts];

    let progress = true;
    while (toDeploy.length > 0 && progress) {
      progress = false;
      for (let i = toDeploy.length - 1; i >= 0; i--) {
        const key = toDeploy[i];
        const config = CONTRACTS[key];
        const depsReady = config.dependencies.every(dep => this.state.addresses[dep]);

        if (depsReady) {
          try {
            await this.deploy(key);
            deployed.add(key);
            toDeploy.splice(i, 1);
            progress = true;
          } catch (e) {
            console.error(`Failed to deploy ${key}: ${e.message}`);
            throw e;
          }
        }
      }
    }

    if (toDeploy.length > 0) {
      console.warn(`Could not deploy (missing dependencies): ${toDeploy.join(', ')}`);
    }

    // Run linking steps for this phase
    const phaseLinks = LINKING_STEPS.filter(s => s.phase === phase);
    for (const step of phaseLinks) {
      try {
        await this.executeLink(step);
      } catch (e) {
        console.error(`Failed: ${step.name} - ${e.message}`);
        // Continue with other steps
      }
    }
  }

  async deployAll() {
    console.log('\nStarting full deployment...');
    console.log(`   Environment: ${this.env}`);
    console.log(`   Expected deployer: ${EXPECTED_DEPLOYER}`);

    // Deploy in phases
    for (const phase of [1, 2, 3, 4, 5]) {
      await this.deployPhase(phase);
    }
  }

  async redeploy(contractKey) {
    console.log(`\nRedeploying ${contractKey} and dependents...\n`);

    // Find all contracts that depend on this one (transitive closure).
    // A dep that is flagged `cascadeBreak` halts the propagation — its
    // dependents stay deployed and get rewired via their runtime setter
    // (handled in the linking steps). This matters for e.g. CawNameURI
    // where CawName.setUriGenerator() lets us swap the URI without
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

    // If CawName (L1) is being redeployed, token IDs will change —
    // all CawNameL2 and CawActions contracts must also be redeployed,
    // and the database must be reset (old actions reference stale token IDs).
    const nameContracts = ['CawName', 'CawNameL2_L1', 'CawNameL2_L2', 'CawNameL2_L2b'];
    const isNameRedeploy = nameContracts.some(c => toRedeploy.has(c));
    if (isNameRedeploy) {
      // Force-include all CawActions and related contracts
      const forceInclude = [
        'CawNameL2_L1', 'CawNameL2_L2', 'CawNameL2_L2b',
        'CawActions_L1', 'CawActions_L2', 'CawActions_L2b',
        'CawActionsReplicator_L1', 'CawActionsReplicator_L2', 'CawActionsReplicator_L2b',
        'CawActionsArchive_L2', 'CawActionsArchive_L2b',
        'CawNameMinter', 'CawNameQuoter', 'CawNameMarketplace',
      ];
      for (const key of forceInclude) {
        if (CONTRACTS[key]) toRedeploy.add(key);
      }
      console.log('\n   ⚠️  CawName redeploy detected — forcing full contract redeploy.');
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
    // on a full CawName redeploy, which silently left `startBlock` stale when
    // we redeployed just CawActions_L2 — the indexer then missed every action
    // from the new contract until someone manually bumped `config.json`.
    const l2IndexedContracts = [
      'CawActions_L2', 'CawActionsReplicator_L2', 'CawNameL2_L2', 'CawActionsArchive_L2',
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
      1: 'L2 + L2b CawNameL2 (Phase 1)',
      2: 'L1 (Phase 2)',
      3: 'L2 + L2b Contracts (Phase 3)',
      4: 'Archives (Phase 4)',
      5: 'Cross-chain Linking (Phase 5)',
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
  Phase 1: Deploy CawNameL2 on L2 + L2b (needed by L1 contracts)
  Phase 2: Deploy all L1 contracts and link them
  Phase 3: Deploy remaining L2 + L2b contracts and link them
  Phase 4: Deploy CawActionsArchive on each L2 chain
  Phase 5: Cross-chain replication setup (archive peers, addArchiveChain, addReplication)

Architecture:
  L1 (Sepolia): CawName, CawClientManager, CawNameMinter, CawNameQuoter
  L2 (Base Sepolia): Full L2 stack + CawActionsArchive (receives from L2b)
  L2b (Arbitrum Sepolia): Full L2 stack + CawActionsArchive (receives from L2)

After deployment, ABIs are automatically regenerated for the frontend.
        `);
        process.exit(0);
    }
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
      CawName: 'CAW_NAMES_ADDRESS',
      CawNameQuoter: 'CAW_NAME_QUOTER_ADDRESS',
      CawNameMinter: 'CAW_NAMES_MINTER_ADDRESS',
      CawNameURI: 'URI_GENERATOR_ADDRESS',
      CawClientManager: 'CLIENT_MANAGER_ADDRESS',
      CawNameL2_L2: 'CAW_NAMES_L2_ADDRESS',
      CawNameL2_L1: 'CAW_NAMES_L2_MAINNET_ADDRESS',
      CawActions_L1: 'CAW_ACTIONS_MAINNET_ADDRESS',
      CawActions_L2: 'CAW_ACTIONS_ADDRESS',
      CawActionsReplicator_L1: 'CAW_ACTIONS_REPLICATOR_L1_ADDRESS',
      CawActionsReplicator_L2: 'CAW_ACTIONS_REPLICATOR_L2_ADDRESS',
      CawActionsArchive_L2: 'CAW_ACTIONS_ARCHIVE_L2_ADDRESS',
      CawActionsArchive_L2b: 'CAW_ACTIONS_ARCHIVE_L2B_ADDRESS',
      CawNameMarketplace: 'CAW_NAME_MARKETPLACE_ADDRESS',
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
