var HDWalletProvider = require("@truffle/hdwallet-provider");
require('dotenv').config();

// Load private keys from environment variable or use Hardhat defaults for development
var pems = process.env.PRIVATE_KEYS
  ? process.env.PRIVATE_KEYS.split(',')
  : [
      // Hardhat default test accounts (safe to use for local development)
      '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
      '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
      '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
      '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
      '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'
    ];

// RPC URLs from environment variables. Role-named (L1_RPC_URL, L2_RPC_URL,
// L2B_RPC_URL, L2C_RPC_URL...) so the same .env works across testnet/mainnet.
const rpcUrls = {
  // Testnets
  sepolia: process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io',
  baseSepolia: process.env.L2_RPC_URL || 'https://sepolia.base.org',
  arbitrumSepolia: process.env.L2B_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
  // Mainnets — same env names; --network selects which truffle profile uses them.
  ethereum: process.env.L1_RPC_URL || 'https://eth.public-rpc.com',
  base: process.env.L2_RPC_URL || 'https://mainnet.base.org',
  arbitrum: process.env.L2B_RPC_URL || 'https://arb1.arbitrum.io/rpc',
  // Local development
  devL1: process.env.DEV_L1_RPC_URL || 'http://localhost:8545',
  devL2: process.env.DEV_L2_RPC_URL || 'http://localhost:8546',
  devArchive: process.env.DEV_L2B_RPC_URL || 'http://localhost:8547',
};

console.log("RPC URLs configured for networks");
/**
 * Use this file to configure your truffle project. It's seeded with some
 * common settings for different networks and features like migrations,
 * compilation and testing. Uncomment the ones you need or modify
 * them to suit your project as necessary.
 *
 * More information about configuration can be found at:
 *
 * trufflesuite.com/docs/advanced/configuration
 *
 * To deploy via Infura you'll need a wallet provider (like @truffle/hdwallet-provider)
 * to sign your transactions before they're sent to a remote public node. Infura accounts
 * are available for free at: infura.io/register.
 *
 * You'll also need a mnemonic - the twelve word phrase the wallet uses to generate
 * public/private key pairs. If you're publishing your code to GitHub make sure you load this
 * phrase from a file you've .gitignored so it doesn't accidentally become public.
 *
 */

// const HDWalletProvider = require('@truffle/hdwallet-provider');
//
// const fs = require('fs');
// const mnemonic = fs.readFileSync(".secret").toString().trim();

module.exports = {
  /**
   * Networks define how you connect to your ethereum client and let you set the
   * defaults web3 uses to send transactions. If you don't specify one truffle
   * will spin up a development blockchain for you on port 9545 when you
   * run `develop` or `test`. You can ask a truffle command to use a specific
   * network from the command line, e.g
   *
   * $ truffle test --network <network-name>
   */

  networks: {
    // Development network for local testing with Ganache
    // Uses direct connection (no HDWalletProvider) for simpler setup
    development: {
      host: "127.0.0.1",
      port: 8545,
      network_id: "*",
    },
    dev: {
      host: "localhost",
      port: 8545,
      network_id: "*", // Match any network id
      provider: function() {
        return new HDWalletProvider(
          pems.slice(1, pems.length-1),
          "http://localhost:8545",
          0, // Active address index
          pems.length,
        );
      },
    },
    devL2: {
      host: "localhost",
      port: 8546,
      network_id: "*", // Match any network id
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.devL2,
          0, // Active address index
          pems.length,
        );
      },
    },
    devL1: {
      host: "localhost",
      port: 8545,
      network_id: "*", // Match any network id
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.devL1,
          0, // Active address index
          pems.length,
        );
      },
    },
    testnetL1: {
      network_id: 11155111,
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.sepolia,
          0, // Active address index
          pems.length,
        );
      },
      networkCheckTimeout: 160000,  // 60 seconds
      timeoutBlocks: 600,
      skipDryRun: true,
    },
    testnetL2: {
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.baseSepolia,
          0, // Active address index
          pems.length,
        );
      },
      network_id: 84532,
    },
    // Archive chain - Arbitrum Sepolia for censorship-resistant action storage
    testnetArchive: {
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.arbitrumSepolia,
          0,
          pems.length,
        );
      },
      network_id: 421614,
    },
    devArchive: {
      host: "localhost",
      port: 8547,
      network_id: "*",
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.devArchive,
          0,
          pems.length,
        );
      },
    },
    eth: {
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.ethereum,
          0, // Active address index
          pems.length,
        );
      },
      network_id: 1,
      gasPrice: 190000010000,
      skipDryRun: true
    },
    // Mainnet L2 (Base)
    L2: {
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.base,
          0,
          pems.length,
        );
      },
      network_id: 8453,
    },
    // Mainnet Archive (Arbitrum)
    Archive: {
      provider: function() {
        return new HDWalletProvider(
          pems,
          rpcUrls.arbitrum,
          0,
          pems.length,
        );
      },
      network_id: 42161,
    },
      //
    // Another network with more advanced options...
    // advanced: {
    // port: 8777,             // Custom port
    // network_id: 1342,       // Custom network
    // gas: 8500000,           // Gas sent with each transaction (default: ~6700000)
    // gasPrice: 20000000000,  // 20 gwei (in wei) (default: 100 gwei)
    // from: <address>,        // Account to send txs from (default: accounts[0])
    // websocket: true        // Enable EventEmitter interface for web3 (default: false)
    // },
    // Useful for deploying to a public network.
    // NB: It's important to wrap the provider as a function.
    // ropsten: {
    // provider: () => new HDWalletProvider(mnemonic, `https://ropsten.infura.io/v3/YOUR-PROJECT-ID`),
    // network_id: 3,       // Ropsten's id
    // gas: 5500000,        // Ropsten has a lower block limit than mainnet
    // confirmations: 2,    // # of confs to wait between deployments. (default: 0)
    // timeoutBlocks: 200,  // # of blocks before a deployment times out  (minimum/default: 50)
    // skipDryRun: true     // Skip dry run before migrations? (default: false for public nets )
    // },
    // Useful for private networks
    // private: {
    // provider: () => new HDWalletProvider(mnemonic, `https://network.io`),
    // network_id: 2111,   // This network is yours, in the cloud.
    // production: true    // Treats this network as if it was a public net. (default: false)
    // }
  },

  // Set default mocha options here, use special reporters etc.
  mocha: {
    // timeout: 100000
  },

  // Configure your compilers
  compilers: {
    solc: {
      version: "0.8.22",    // Fetch exact version from solc-bin (default: truffle's version)
      // docker: true,        // Use "0.5.1" you've installed locally with docker (default: false)
      settings: {          // See the solidity docs for advice about optimization and evmVersion
       optimizer: {
         enabled: true,
         // runs=1 favors smaller deployed bytecode over runtime-call efficiency.
         // Matches hardhat.config.js so tests and deploys produce identical binaries;
         // required because CawProfile sits within ~400 bytes of the 24,576 EIP-170 cap.
         runs: 1
       },
       viaIR: true,
       // evmVersion: "byzantium"
      }
    }
  },

  // Truffle DB is currently disabled by default; to enable it, change enabled:
  // false to enabled: true. The default storage location can also be
  // overridden by specifying the adapter settings, as shown in the commented code below.
  //
  // NOTE: It is not possible to migrate your contracts to truffle DB and you should
  // make a backup of your artifacts to a safe location before enabling this feature.
  //
  // After you backed up your artifacts you can utilize db by running migrate as follows: 
  // $ truffle migrate --reset --compile-all
  //
  // db: {
    // enabled: false,
    // host: "127.0.0.1",
    // adapter: {
    //   name: "sqlite",
    //   settings: {
    //     directory: ".db"
    //   }
    // }
  // }
  plugins: ['truffle-plugin-verify'],


  api_keys: {
    etherscan: 'XXXXXXXXXX'
  }
};
;
