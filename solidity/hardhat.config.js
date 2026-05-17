require('dotenv').config();

// Forking config (Base Sepolia) used by the ZK fork test. Set
// FORK_BASE_SEPOLIA_RPC_URL in .env to enable; otherwise hardhat starts
// in normal in-memory mode and the fork-only tests skip themselves.
// RPC_BASE_SEPOLIA is the canonical name in solidity/.env, fall back to
// L2_RPC_URL or FORK_BASE_SEPOLIA_RPC_URL for flexibility.
const FORK_RPC = process.env.FORK_BASE_SEPOLIA_RPC_URL
  || process.env.RPC_BASE_SEPOLIA
  || process.env.L2_RPC_URL
  || '';
// Optional pin to a specific block. If unset, fork from latest at start time.
const FORK_BLOCK = process.env.FORK_BASE_SEPOLIA_BLOCK ? Number(process.env.FORK_BASE_SEPOLIA_BLOCK) : undefined;

// Forking config (Ethereum mainnet) used by the cost-cap oracle fork tests.
// Set FORK_MAINNET_RPC_URL in .env to enable. Tests skip cleanly when unset.
// FORK_MAINNET_BLOCK pins to a specific block for determinism; default 22500000.
//
// Usage:
//   FORK_MAINNET_RPC_URL=<url> npx hardhat test test-fork/cap-oracle-fork-test.js
//
// The mainnet fork is applied to the `hardhat` in-process network.
// If both FORK_MAINNET_RPC_URL and a Base Sepolia RPC are set, mainnet fork
// takes precedence (cap-oracle tests have their own skip guard for Base Sepolia
// tests, and vice versa for the ZK fork test).
const FORK_MAINNET_RPC = process.env.FORK_MAINNET_RPC_URL || '';
const FORK_MAINNET_BLOCK = process.env.FORK_MAINNET_BLOCK
  ? Number(process.env.FORK_MAINNET_BLOCK)
  : 22500000;

// Build the forking config for the `hardhat` network.
// Priority: mainnet > Base Sepolia > none.
function buildForkingConfig() {
  if (FORK_MAINNET_RPC) {
    return {
      forking: { url: FORK_MAINNET_RPC, blockNumber: FORK_MAINNET_BLOCK },
      chainId: 1,
      hardfork: 'cancun',
      chains: {
        1: { hardforkHistory: { cancun: 0 } },
      },
    };
  }
  if (FORK_RPC) {
    return {
      forking: { url: FORK_RPC, ...(FORK_BLOCK ? { blockNumber: FORK_BLOCK } : {}) },
      chainId: 84532, // Base Sepolia
      // Hardhat's EVM needs to know which hardfork rules to apply at the
      // forked block. Without this, eth_call on historical blocks errors
      // with "No known hardfork for execution on historical block ...".
      // Base Sepolia activated Cancun via the Dencun upgrade in early 2024,
      // well before any v6.x SP1Verifier was deployed — so all fork
      // scenarios we care about run under cancun rules.
      hardfork: 'cancun',
      chains: {
        84532: { hardforkHistory: { cancun: 0 } },
      },
    };
  }
  return {};
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.30",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 1,
      },
      // Pin to Cancun — see truffle-config.js for rationale; must match
      // exactly so Truffle and Hardhat produce identical bytecode.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      mining: {
        auto: true,
        interval: 5000,
      },
      ...buildForkingConfig(),
    },
  },
};
