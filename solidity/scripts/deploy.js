#!/usr/bin/env node
/**
 * Multi-Chain Deployment Script for CAW Protocol
 *
 * This script replaces the old Truffle migrations (migrations/1_initial_migration.js).
 *
 * FEATURES:
 * - Multi-chain deployment (L1, L2, Archive chains)
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
 *   Phase 1: L2 - Deploy CawNameL2 (needed for cross-chain setup)
 *   Phase 2: L1 - Deploy all L1 contracts (CawName, CawClientManager, etc.)
 *   Phase 3: L2 - Deploy remaining L2 contracts (CawActions, Replicator)
 *   Phase 4: Archive - Deploy CawActionsArchive
 *
 * STATE FILE:
 *   Deployment state is saved to .deploy-state.json in the solidity directory.
 *   This allows resuming failed deployments. Delete this file to start fresh.
 *
 * PREREQUISITES:
 *   1. Run `npx truffle compile` first to generate contract artifacts
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
  testnetArchive: {
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
  devArchive: {
    name: 'Local Archive',
    rpc: process.env.RPC_DEV_ARCHIVE || 'http://localhost:8547',
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
  mainnetArchive: {
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
  // Phase 1: L2 - Deploy CawNameL2 first (needed by L1 CawName for cross-chain setup)
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

  // Phase 2: L1 - Deploy everything on L1
  CawNameURI: {
    chain: 'L1',
    phase: 2,
    dependencies: [],
    constructorArgs: () => [],
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
    dependencies: ['CawNameL2_L2', 'CawNameURI', 'CawClientManager'],
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

  // Phase 3: L2 - Deploy remaining L2 contracts
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

  // Phase 4: Archive chain
  CawActionsArchive: {
    chain: 'Archive',
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
    args: (state) => [state.deployerAddress, 1, 1, 1, 1],
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
    name: 'Set L2 peer on CawName (to actual L2 CawNameL2)',
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
    name: 'Set minter on CawName',
    chain: 'L1',
    phase: 2,
    contract: 'CawName',
    method: 'setMinter',
    args: (state) => [state.addresses.CawNameMinter],
    condition: (state) => state.addresses.CawName && state.addresses.CawNameMinter,
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
    name: 'Set replicator on CawActions_L1',
    chain: 'L1',
    phase: 2,
    contract: 'CawActions_L1',
    method: 'setReplicator',
    args: (state) => [state.addresses.CawActionsReplicator_L1],
    condition: (state) => state.addresses.CawActions_L1 && state.addresses.CawActionsReplicator_L1,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawActions_L1');
      if (!contract) return false;
      try {
        const current = await contract.replicator();
        return current !== '0x0000000000000000000000000000000000000000';
      } catch { return false; }
    },
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
    args: (state, chainConfig) => [
      state.addresses.CawName,
      CHAINS[chainConfig.env + 'L2'].lzEid,
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

  // Phase 3 linking (L2)
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
    name: 'Set replicator on CawActions_L2',
    chain: 'L2',
    phase: 3,
    contract: 'CawActions_L2',
    method: 'setReplicator',
    args: (state) => [state.addresses.CawActionsReplicator_L2],
    condition: (state) => state.addresses.CawActions_L2 && state.addresses.CawActionsReplicator_L2,
    skipIf: async (state, deployer) => {
      const contract = deployer.getContract('CawActions_L2');
      if (!contract) return false;
      try {
        const current = await contract.replicator();
        return current !== '0x0000000000000000000000000000000000000000';
      } catch { return false; }
    },
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
        console.log('📂 Loaded existing deployment state');
        return data;
      }
    } catch (e) {
      console.warn('⚠️  Could not load state file:', e.message);
    }
    return { addresses: {}, linking: {}, deployerAddress: null };
  }

  saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    console.log('💾 State saved');
  }

  resetState() {
    this.state = { addresses: {}, linking: {}, deployerAddress: null };
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
    console.log('🗑️  State reset');
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

    console.log(`\n🔗 Connecting to ${config.name} (${chainKey})...`);

    const provider = new ethers.JsonRpcProvider(config.rpc);

    await this.retry(async () => {
      const network = await provider.getNetwork();
      console.log(`   ✓ Connected to chain ID ${network.chainId}`);
    });

    const privateKeys = process.env.PRIVATE_KEYS?.split(',') || [];
    if (privateKeys.length === 0) {
      throw new Error('No PRIVATE_KEYS found in environment');
    }

    const wallet = new ethers.Wallet(privateKeys[0], provider);
    const balance = await provider.getBalance(wallet.address);
    console.log(`   ✓ Wallet: ${wallet.address} (${ethers.formatEther(balance)} ETH)`);

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
        console.log(`   ✓ Using existing ${name}: ${addr}`);
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
      throw new Error(`Artifact not found: ${artifactPath}. Run 'npx hardhat compile' first.`);
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
        console.warn(`   ⚠️  Attempt ${i + 1}/${attempts} failed: ${e.message}`);
        if (i < attempts - 1) {
          console.log(`   ⏳ Retrying in ${delay / 1000}s...`);
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
      console.log(`⏭️  ${contractKey} already deployed at ${this.state.addresses[contractKey]}`);
      return this.state.addresses[contractKey];
    }

    const chainKey = this.getChainKey(config.chain);
    await this.initChain(chainKey);

    const artifactName = config.artifact || contractKey;
    const artifact = this.loadArtifact(artifactName);
    const wallet = this.wallets[chainKey];

    const args = config.constructorArgs(this.state, chainKey);
    console.log(`\n📦 Deploying ${contractKey} to ${chainKey}...`);
    console.log(`   Constructor args:`, args);

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

    const contract = await this.retry(async () => {
      // Use higher gas limit for large contracts like CawName
      const overrides = {};
      if (contractKey === 'CawName') {
        overrides.gasLimit = 8000000n;
      }
      const deployed = await factory.deploy(...args, overrides);
      console.log(`   ⏳ Tx hash: ${deployed.deploymentTransaction().hash}`);
      console.log(`   ⏳ Waiting for confirmation...`);
      await deployed.waitForDeployment();
      return deployed;
    });

    const address = await contract.getAddress();
    console.log(`   ✅ Deployed at: ${address}`);

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
      console.log(`⏭️  Skipping "${step.name}" - condition not met`);
      return;
    }

    if (step.skipIf) {
      try {
        const shouldSkip = await step.skipIf(this.state, this);
        if (shouldSkip) {
          console.log(`⏭️  Skipping "${step.name}" - already done`);
          return;
        }
      } catch (e) {
        console.log(`   ⚠️  Skip check failed: ${e.message}, proceeding...`);
      }
    }

    const contract = this.getContract(step.contract);
    if (!contract) {
      console.warn(`⚠️  Contract ${step.contract} not available, skipping "${step.name}"`);
      return;
    }

    const chainConfig = { env: this.env, ...CHAINS[chainKey] };
    const args = step.args(this.state, chainConfig);

    console.log(`\n🔗 ${step.name}...`);
    console.log(`   Calling ${step.contract}.${step.method}(${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(', ')})`);

    await this.retry(async () => {
      const tx = await contract[step.method](...args);
      console.log(`   ⏳ Tx hash: ${tx.hash}`);
      await tx.wait();
    });

    console.log(`   ✅ Done`);

    if (step.onSuccess) {
      step.onSuccess(this.state);
      this.saveState();
    }
  }

  async deployPhase(phase) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📍 PHASE ${phase}`);
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
            console.error(`❌ Failed to deploy ${key}: ${e.message}`);
            throw e;
          }
        }
      }
    }

    if (toDeploy.length > 0) {
      console.warn(`⚠️  Could not deploy (missing dependencies): ${toDeploy.join(', ')}`);
    }

    // Run linking steps for this phase
    const phaseLinks = LINKING_STEPS.filter(s => s.phase === phase);
    for (const step of phaseLinks) {
      try {
        await this.executeLink(step);
      } catch (e) {
        console.error(`❌ Failed: ${step.name} - ${e.message}`);
        // Continue with other steps
      }
    }
  }

  async deployAll() {
    console.log('\n🚀 Starting full deployment...');
    console.log(`   Environment: ${this.env}`);
    console.log(`   Expected deployer: ${EXPECTED_DEPLOYER}`);

    // Deploy in phases
    for (const phase of [1, 2, 3, 4]) {
      await this.deployPhase(phase);
    }
  }

  async redeploy(contractKey) {
    console.log(`\n🔄 Redeploying ${contractKey} and dependents...\n`);

    // Find all contracts that depend on this one
    const toRedeploy = new Set([contractKey]);
    let changed = true;

    while (changed) {
      changed = false;
      for (const [key, config] of Object.entries(CONTRACTS)) {
        if (toRedeploy.has(key)) continue;
        for (const dep of config.dependencies) {
          if (toRedeploy.has(dep)) {
            toRedeploy.add(key);
            changed = true;
            break;
          }
        }
      }
    }

    console.log(`   Will redeploy: ${[...toRedeploy].join(', ')}`);

    // Clear addresses
    for (const key of toRedeploy) {
      delete this.state.addresses[key];
      delete this.contracts[key];
    }
    // Clear linking state since we're redeploying
    this.state.linking = {};
    this.saveState();

    // Redeploy by phase
    await this.deployAll();
  }

  printState() {
    console.log('\n📋 Current Deployment State:\n');
    console.log(`Environment: ${this.env}`);
    console.log(`Deployer: ${this.state.deployerAddress || 'Not connected'}\n`);

    console.log('Addresses:');
    const phases = { 1: 'L2 (Phase 1)', 2: 'L1 (Phase 2)', 3: 'L2 (Phase 3)', 4: 'Archive (Phase 4)' };
    for (const phase of [1, 2, 3, 4]) {
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
  Phase 1: Deploy CawNameL2 on L2 (needed by L1 contracts)
  Phase 2: Deploy all L1 contracts and link them
  Phase 3: Deploy remaining L2 contracts and link them
  Phase 4: Deploy Archive chain contracts

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
    console.log('\n🔍 Dry run mode - showing what would be deployed:\n');
    deployer.printState();

    console.log('\nContracts to deploy:');
    for (const phase of [1, 2, 3, 4]) {
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
  console.log('\n✅ Deployment complete!');

  // Regenerate ABIs for frontend
  if (!skipAbi) {
    console.log('\n🔄 Regenerating ABIs for frontend...');
    try {
      execSync('npx wagmi generate', {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
      console.log('✅ ABIs regenerated successfully');
    } catch (e) {
      console.warn('⚠️  Failed to regenerate ABIs:', e.message);
      console.warn('   You can manually run: cd solidity && npx wagmi generate');
    }
  } else {
    console.log('\n⏭️  Skipping ABI regeneration (--skip-abi flag)');
  }
}

main().catch(e => {
  console.error('\n❌ Deployment failed:', e);
  process.exit(1);
});
