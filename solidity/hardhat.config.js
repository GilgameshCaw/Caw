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
      ...(FORK_RPC ? {
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
          84532: {
            hardforkHistory: { cancun: 0 },
          },
        },
      } : {}),
    },
  },
};
