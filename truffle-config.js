var HDWalletProvider = require("@truffle/hdwallet-provider");
var pems = [
  // HARD HAT:
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', //hard hat #1
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', //hard hat #2
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', //hard hat #3
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', //hard hat #4
];
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
    // Useful for testing. The `development` name is special - truffle uses it by default
    // if it's defined here and no other network is specified at the command line.
    // You should run a client (like ganache-cli, geth or parity) in a separate terminal
    // tab if you use this network and you must also set the `host`, `port` and `network_id`
    // options below to some value.
    //
    // development: {
    //  host: "127.0.0.1",     // Localhost (default: none)
    //  port: 8545,            // Standard Ethereum port (default: none)
    //  network_id: "*",       // Any network (default: none)
    // },
    dev: {
      host: "localhost",
      port: 8545,
      network_id: "*", // Match any network id
      provider: function() {
        return new HDWalletProvider(
          pems,
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
          "http://localhost:8546",
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
          "http://localhost:8545",
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
          "https://1rpc.io/sepolia",
          // "https://sepolia.drpc.org",
          // "wss://sepolia.drpc.org",
          0, // Active address index
          pems.length,
        );
      },
      // gas: 1000000,
      // gasPrice: 500000000000,
      // gas: 4500000,
      // networkCheckTimeout: 1200000,
      // gasPrice: 45000010000,
    },
    testnetL2: {
      provider: function() {
        return new HDWalletProvider(
          pems,
          "https://sepolia.base.org",
          0, // Active address index
          pems.length,
        );
      },
      network_id: 84532,
      // gas: 4500000,
      // networkCheckTimeout: 1200000,
      // gasPrice: 45000010000,
    },
    rinkeby: {
      provider: function() {
        return new HDWalletProvider(
          pems,
          "https://rinkeby.infura.io/v3/INFURA_ID",
          0, // Active address index
          pems.length,
        );
      },
      network_id: 4,
      // gas: 4500000,
      // networkCheckTimeout: 1200000,
      // gasPrice: 45000010000,
    },
    eth: {
      provider: function() {
        return new HDWalletProvider(
          pems,
          "https://rinkeby.infura.io/v3/INFURA_ID",
          0, // Active address index
          pems.length,
        );
      },
      network_id: 1,
      // gas: 4500000,
      // networkCheckTimeout: 1200000,
      gasPrice: 190000010000,
      skipDryRun: true     // Skip dry run before migrations? (default: false for public nets )
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
         runs: 200
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
