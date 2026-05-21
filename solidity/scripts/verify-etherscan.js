#!/usr/bin/env node
/**
 * verify-etherscan.js — verify deployed V2 contracts on each chain's Etherscan.
 *
 * Usage:
 *   node scripts/verify-etherscan.js              # Verify everything missing
 *   node scripts/verify-etherscan.js --dry-run    # Show what would be verified
 *   node scripts/verify-etherscan.js --contract CawProfile  # Specific contract
 *   node scripts/verify-etherscan.js --chain L1   # Only L1 contracts
 *   node scripts/verify-etherscan.js --env testnet  # Environment (default: testnet)
 *   node scripts/verify-etherscan.js --state-file .deploy-state.v1-pre-uruk.json  # Custom state file
 *
 * Reads .deploy-state.json for the address map, reconstructs constructor args
 * from the same logic deploy.js uses (same CHAINS/CONTRACTS tables, same
 * ZK_PROGRAM_VKEY constant), and submits Standard JSON verification to the
 * appropriate Etherscan API per chain.
 *
 * Records success in state.verification.<key> = { verified: true, ts: <iso> }
 * so re-runs are idempotent. Etherscan "already verified" responses are also
 * treated as success and recorded.
 *
 * Verification method: Etherscan Standard-JSON-input API
 *   POST https://api-<chain>.etherscan.io/api
 *   action=verifysourcecode
 *   codeformat=solidity-standard-json-input
 *
 * This sends the same hardhat build-info input that produced the deployed
 * bytecode (same compiler version, optimizer settings, viaIR, evmVersion).
 * Constructor args are ABI-encoded from each contract's CONTRACTS entry.
 *
 * Prerequisites:
 *   - ETHERSCAN_API_KEY (or per-chain: ETHERSCAN_API_KEY_L1, ETHERSCAN_API_KEY_L2,
 *     ETHERSCAN_API_KEY_L2b) in solidity/.env
 *   - Contracts already deployed via scripts/deploy.js
 *   - Hardhat artifacts present (run `npx hardhat compile` first)
 *
 * API key per chain:
 *   L1  (Sepolia)          — ETHERSCAN_API_KEY_L1  or ETHERSCAN_API_KEY
 *   L2  (Base Sepolia)     — ETHERSCAN_API_KEY_L2  or BASESCAN_API_KEY or ETHERSCAN_API_KEY
 *   L2b (Arbitrum Sepolia) — ETHERSCAN_API_KEY_L2B or ARBISCAN_API_KEY or ETHERSCAN_API_KEY
 */

'use strict';

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
require('dotenv').config();

// ============================================================
// CONSTANTS — must stay in sync with deploy.js
// ============================================================

const ZK_PROGRAM_VKEY = '0x00197b568ede30c47de32e462b8f4b99897351568da36e5aad94cfbf6da94770';

// L2 abstract chain keys (same list as deploy.js)
const L2_CHAIN_KEYS = ['L2', 'L2b'];

// Chain configurations (same as deploy.js — only the fields needed for
// constructor arg reconstruction are kept here).
const CHAINS = {
  testnetL1: {
    name: 'Sepolia',
    chainId: 11155111,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40161,
    sp1Verifier: '0x0000000000000000000000000000000000000000',
    uniswapV2Router: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3',
    etherscanApi: 'https://api-sepolia.etherscan.io/api',
    etherscanBrowser: 'https://sepolia.etherscan.io',
  },
  testnetL2: {
    name: 'Base Sepolia',
    chainId: 84532,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40245,
    sp1Verifier: '0x397A5f7f3dBd538f23DE225B51f532c34448dA9B',
    etherscanApi: 'https://api-sepolia.basescan.org/api',
    etherscanBrowser: 'https://sepolia.basescan.org',
  },
  testnetL2b: {
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    lzEndpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    lzEid: 40231,
    sp1Verifier: '0x0000000000000000000000000000000000000000',
    etherscanApi: 'https://api-sepolia.arbiscan.io/api',
    etherscanBrowser: 'https://sepolia.arbiscan.io',
  },
  mainnetL1: {
    name: 'Ethereum Mainnet',
    chainId: 1,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30101,
    sp1Verifier: null, // set before mainnet deploy
    uniswapV2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    etherscanApi: 'https://api.etherscan.io/api',
    etherscanBrowser: 'https://etherscan.io',
  },
  mainnetL2: {
    name: 'Base Mainnet',
    chainId: 8453,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30184,
    sp1Verifier: null, // set before mainnet deploy
    etherscanApi: 'https://api.basescan.org/api',
    etherscanBrowser: 'https://basescan.org',
  },
  mainnetL2b: {
    name: 'Arbitrum Mainnet',
    chainId: 42161,
    lzEndpoint: '0x1a44076050125825900e736c501f859c50fe728c',
    lzEid: 30110,
    sp1Verifier: null, // set before mainnet deploy
    etherscanApi: 'https://api.arbiscan.io/api',
    etherscanBrowser: 'https://arbiscan.io',
  },
};

// Resolve the canonical sp1Verifier address for a chain, or address(0) if
// not set (disables ZK path). Matches deploy.js requireSp1Verifier logic.
function resolvesp1Verifier(chainKey, state) {
  // Dev MockSP1Verifier: address would be in state
  const mockKey = chainKey.replace(/^(testnet|mainnet)/, 'MockSP1Verifier_').replace('testnet', '').replace('mainnet', '');
  // e.g. chainKey=testnetL2 → abstract=L2 → state.addresses.MockSP1Verifier_L2
  const abstract = chainKey.replace(/^(testnet|mainnet)/, '');
  const mock = state.addresses[`MockSP1Verifier_${abstract}`];
  if (mock) return mock;

  const v = CHAINS[chainKey]?.sp1Verifier;
  if (v === null || v === undefined) return ethers.ZeroAddress;
  if (typeof v === 'string' && v.startsWith('<')) return ethers.ZeroAddress;
  return v || ethers.ZeroAddress;
}

function resolveUniswapRouter(chainKey, state) {
  const abstract = chainKey.replace(/^(testnet|mainnet)/, '');
  const mock = state.addresses['MockSwapRouter'];
  if (mock && abstract === 'L1') return mock;
  const v = CHAINS[chainKey]?.uniswapV2Router;
  if (!v || typeof v !== 'string' || v.startsWith('<')) return ethers.ZeroAddress;
  return v;
}

// ============================================================
// CONTRACT TABLE
// Mirrors CONTRACTS in deploy.js for constructor arg reconstruction.
// Each entry:
//   chain      — abstract chain key: 'L1', 'L2', 'L2b'
//   artifact   — artifact name (defaults to the key name, minus _<L> suffix)
//   constructorArgs(state, chainKey, env) — returns array of values
//   skipVerify — true for mock/test-only contracts not worth verifying
// ============================================================

const CONTRACTS = {
  CawFontDataA: {
    chain: 'L1',
    constructorArgs: () => [],
  },
  CawFontDataB: {
    chain: 'L1',
    constructorArgs: () => [],
  },
  CawProfileURI: {
    chain: 'L1',
    constructorArgs: (state) => [
      state.addresses.CawFontDataA,
      state.addresses.CawFontDataB,
    ],
  },
  MockSwapRouter: {
    artifact: 'MockSwapRouter',
    chain: 'L1',
    skipVerify: true, // dev-only
    constructorArgs: (state) => [state.addresses.MintableCaw],
  },
  CawBuyAndBurn: {
    chain: 'L1',
    constructorArgs: (state, chainKey) => [
      state.addresses.MintableCaw,
      resolveUniswapRouter(chainKey, state),
    ],
  },
  CawNetworkManager: {
    chain: 'L1',
    constructorArgs: (state) => [state.addresses.CawBuyAndBurn],
  },
  CawL1PriceReader: {
    chain: 'L1',
    constructorArgs: (state) => {
      const cawToken = state.addresses.MintableCaw;
      const pairAddr = process.env.CAW_WETH_PAIR || ethers.ZeroAddress;
      if (!cawToken || pairAddr === ethers.ZeroAddress) return [ethers.ZeroAddress, ethers.ZeroAddress];
      return [pairAddr, cawToken];
    },
  },
  CawProfile: {
    chain: 'L1',
    constructorArgs: (state, chainKey) => [
      state.addresses.MintableCaw,
      state.addresses.CawProfileURI,
      state.addresses.CawBuyAndBurn,
      // V2 renames CawClientManager → CawNetworkManager; fall back for V1 state files
      state.addresses.CawNetworkManager || state.addresses.CawClientManager,
      CHAINS[chainKey].lzEndpoint,
      CHAINS[chainKey].lzEid,
      state.addresses.CawL1PriceReader || ethers.ZeroAddress,
    ],
  },
  // CawProfileL2 deployed on L1 (bypassLZ mode)
  CawProfileL2_L1: {
    artifact: 'CawProfileL2',
    chain: 'L1',
    constructorArgs: (state, chainKey) => {
      const l2ChainKey = chainKey.replace('L1', 'L2');
      return [
        CHAINS[l2ChainKey]?.lzEid || CHAINS.testnetL2.lzEid,
        CHAINS[chainKey].lzEndpoint,
        state.addresses.CawCapOracle_L1
          || state.predictedAddresses?.CawCapOracle_L1
          || ethers.ZeroAddress,
      ];
    },
  },
  CawCapOracle_L1: {
    artifact: 'CawCapOracle',
    chain: 'L1',
    constructorArgs: (state) => [
      state.addresses.CawProfileL2_L1,
      state.addresses.CawActions_L1
        || state.predictedAddresses?.CawActions_L1
        || ethers.ZeroAddress,
    ],
  },
  CawProfileMinter: {
    chain: 'L1',
    constructorArgs: (state, chainKey) => [
      state.addresses.MintableCaw,
      state.addresses.CawProfile,
      resolveUniswapRouter(chainKey, state),
    ],
  },
  CawProfileQuoter: {
    chain: 'L1',
    constructorArgs: (state) => [state.addresses.CawProfile],
  },
  CawProfileMarketplace: {
    chain: 'L1',
    constructorArgs: (state, chainKey, env) => {
      // Marketplace payment tokens — same logic as deploy.js.
      // ETH (address(0)) is always allowed by the contract itself.
      const MARKETPLACE_PAYMENT_TOKENS = {
        mainnet: [
          '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
          '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
        ],
        testnet: [],
        dev: [],
      };
      const erc20Tokens = (MARKETPLACE_PAYMENT_TOKENS[env] || []).slice();
      const caw = state.addresses.MintableCaw || state.addresses.CAW;
      if (caw) erc20Tokens.push(caw);
      return [state.addresses.CawProfile, erc20Tokens];
    },
  },
  SmartEOA: {
    chain: 'L1',
    constructorArgs: () => [],
  },
  CawActions_L1: {
    artifact: 'CawActions',
    chain: 'L1',
    constructorArgs: (state, chainKey) => [
      state.addresses.CawProfileL2_L1,
      resolvesp1Verifier(chainKey, state),
      ZK_PROGRAM_VKEY,
      state.addresses.CawActionsERC1271_L1
        || state.predictedAddresses?.CawActionsERC1271_L1
        || ethers.ZeroAddress,
      state.addresses.CawCapOracle_L1 || ethers.ZeroAddress,
    ],
  },
  CawActionsERC1271_L1: {
    artifact: 'CawActionsERC1271',
    chain: 'L1',
    constructorArgs: (state) => [state.addresses.CawActions_L1],
  },
  // Phase 7 expander on L1 — only present if RENOUNCE_ON_DEPLOY was set
  PathwayExpander_L1: {
    artifact: 'PathwayExpander',
    chain: 'L1',
    constructorArgs: (state) => [state.deployerAddress],
  },
};

// Append per-L2 contracts (mirrors the for-loop in deploy.js)
for (const L of L2_CHAIN_KEYS) {
  CONTRACTS[`MockSP1Verifier_${L}`] = {
    artifact: 'MockSP1Verifier',
    chain: L,
    skipVerify: true,
    constructorArgs: () => [],
  };
  CONTRACTS[`CawProfileL2_${L}`] = {
    artifact: 'CawProfileL2',
    chain: L,
    constructorArgs: (state, chainKey) => {
      const l1ChainKey = chainKey.replace(/L2.*$/, 'L1');
      return [
        CHAINS[l1ChainKey]?.lzEid || CHAINS.testnetL1.lzEid,
        CHAINS[chainKey].lzEndpoint,
        state.addresses[`CawCapOracle_${L}`]
          || state.predictedAddresses?.[`CawCapOracle_${L}`]
          || ethers.ZeroAddress,
      ];
    },
  };
  CONTRACTS[`CawCapOracle_${L}`] = {
    artifact: 'CawCapOracle',
    chain: L,
    constructorArgs: (state) => [
      state.addresses[`CawProfileL2_${L}`],
      state.addresses[`CawActions_${L}`]
        || state.predictedAddresses?.[`CawActions_${L}`]
        || ethers.ZeroAddress,
    ],
  };
  CONTRACTS[`CawActions_${L}`] = {
    artifact: 'CawActions',
    chain: L,
    constructorArgs: (state, chainKey) => [
      state.addresses[`CawProfileL2_${L}`],
      resolvesp1Verifier(chainKey, state),
      ZK_PROGRAM_VKEY,
      state.addresses[`CawActionsERC1271_${L}`]
        || state.predictedAddresses?.[`CawActionsERC1271_${L}`]
        || ethers.ZeroAddress,
      state.addresses[`CawCapOracle_${L}`] || ethers.ZeroAddress,
    ],
  };
  CONTRACTS[`CawActionsERC1271_${L}`] = {
    artifact: 'CawActionsERC1271',
    chain: L,
    constructorArgs: (state) => [state.addresses[`CawActions_${L}`]],
  };
  CONTRACTS[`CawActionsArchive_${L}`] = {
    artifact: 'CawActionsArchive',
    chain: L,
    constructorArgs: (state, chainKey) => [CHAINS[chainKey].lzEndpoint],
  };
  CONTRACTS[`CawChallengeRelay_${L}`] = {
    artifact: 'CawChallengeRelay',
    chain: L,
    constructorArgs: (state, chainKey) => [
      CHAINS[chainKey].lzEndpoint,
      state.addresses[`CawActions_${L}`],
    ],
  };
  CONTRACTS[`PathwayExpander_${L}`] = {
    artifact: 'PathwayExpander',
    chain: L,
    constructorArgs: (state) => [state.deployerAddress],
  };
}

// Contracts that are external / pre-existing — never verify these
const SKIP_VERIFY_KEYS = new Set([
  'MintableCaw',
  'MockSP1Verifier_L1',
  'MockSP1Verifier_L2',
  'MockSP1Verifier_L2b',
  'MockSwapRouter',
]);

// ============================================================
// ARTIFACT LOADING
// ============================================================

const ARTIFACTS_DIR = path.join(__dirname, '../artifacts/contracts');
const BUILD_INFO_DIR = path.join(__dirname, '../artifacts/build-info');

function loadArtifact(contractName) {
  const searchPaths = [
    path.join(ARTIFACTS_DIR, `${contractName}.sol`, `${contractName}.json`),
    path.join(ARTIFACTS_DIR, 'mocks', `${contractName}.sol`, `${contractName}.json`),
    path.join(ARTIFACTS_DIR, 'test-helpers', `${contractName}.sol`, `${contractName}.json`),
  ];
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  return null;
}

// Load the single build-info file produced by `npx hardhat compile`.
// Hardhat writes one per compilation run; we expect exactly one here.
function loadBuildInfo() {
  if (!fs.existsSync(BUILD_INFO_DIR)) {
    throw new Error(`build-info directory not found at ${BUILD_INFO_DIR}. Run: npx hardhat compile`);
  }
  const files = fs.readdirSync(BUILD_INFO_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error('No build-info files found. Run: npx hardhat compile');
  }
  if (files.length > 1) {
    // Multiple build-info files means incremental compilation split runs.
    // Use the most-recently modified one (most likely to contain all contracts).
    files.sort((a, b) => {
      const sa = fs.statSync(path.join(BUILD_INFO_DIR, a));
      const sb = fs.statSync(path.join(BUILD_INFO_DIR, b));
      return sb.mtimeMs - sa.mtimeMs;
    });
    console.warn(`Warning: multiple build-info files found; using most recent: ${files[0]}`);
  }
  const buildInfo = JSON.parse(fs.readFileSync(path.join(BUILD_INFO_DIR, files[0]), 'utf8'));
  return buildInfo;
}

// ============================================================
// ABI ENCODING FOR CONSTRUCTOR ARGS
// ============================================================

// Given a contract's ABI and the raw constructor arg values, return the
// ABI-encoded constructor args as a hex string (no 0x prefix) suitable for
// the `constructorArguements` field in the Etherscan API request.
function encodeConstructorArgs(abi, args) {
  const ctorEntry = abi.find(e => e.type === 'constructor');
  if (!ctorEntry || ctorEntry.inputs.length === 0) return '';
  if (args.length === 0) return '';

  const iface = new ethers.Interface(abi);
  const encoded = iface.encodeDeploy(args);
  // encodeDeploy returns the full encoded args (without bytecode prefix).
  // Strip the 0x prefix.
  return encoded.startsWith('0x') ? encoded.slice(2) : encoded;
}

// ============================================================
// ETHERSCAN API
// ============================================================

// Resolve the API key for a given chain.
function getApiKey(chainKey) {
  const abstract = chainKey.replace(/^(testnet|mainnet)/, '');
  // Per-chain keys take priority
  if (abstract === 'L1' && process.env.ETHERSCAN_API_KEY_L1) return process.env.ETHERSCAN_API_KEY_L1;
  if (abstract === 'L2' && (process.env.ETHERSCAN_API_KEY_L2 || process.env.BASESCAN_API_KEY)) {
    return process.env.ETHERSCAN_API_KEY_L2 || process.env.BASESCAN_API_KEY;
  }
  if (abstract === 'L2b' && (process.env.ETHERSCAN_API_KEY_L2B || process.env.ARBISCAN_API_KEY)) {
    return process.env.ETHERSCAN_API_KEY_L2B || process.env.ARBISCAN_API_KEY;
  }
  // Fall back to shared key
  return process.env.ETHERSCAN_API_KEY || '';
}

// Build the Standard-JSON-input verification payload.
// Etherscan accepts the full `input` field from the build-info file.
function buildVerifyPayload(params) {
  const {
    apiKey,
    address,
    contractName,   // e.g. "CawActions"
    sourceName,     // e.g. "contracts/CawActions.sol"
    solcVersion,    // e.g. "v0.8.30+commit.73712a01"
    standardJsonInput, // the build-info `input` object (will be JSON-stringified)
    encodedArgs,    // hex string, no 0x prefix
  } = params;

  const body = new URLSearchParams();
  body.append('apikey', apiKey);
  body.append('module', 'contract');
  body.append('action', 'verifysourcecode');
  body.append('contractaddress', address);
  body.append('sourceCode', JSON.stringify(standardJsonInput));
  body.append('codeformat', 'solidity-standard-json-input');
  body.append('contractname', `${sourceName}:${contractName}`);
  body.append('compilerversion', solcVersion);
  // constructorArguements — note Etherscan's intentional misspelling
  if (encodedArgs) body.append('constructorArguements', encodedArgs);
  return body;
}

// POST to Etherscan and return the parsed JSON response.
function postForm(url, formBody) {
  return new Promise((resolve, reject) => {
    const bodyStr = formBody.toString();
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// GET Etherscan to poll the verification status of a submitted GUID.
function getVerifyStatus(apiUrl, apiKey, guid) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl);
    url.searchParams.set('module', 'contract');
    url.searchParams.set('action', 'checkverifystatus');
    url.searchParams.set('guid', guid);
    url.searchParams.set('apikey', apiKey);
    const fullUrl = url.toString();

    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    lib.get(fullUrl, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

// Wait up to ~3 minutes polling Etherscan for the verification result.
async function pollUntilDone(apiUrl, apiKey, guid, contractKey) {
  const MAX_POLLS = 18;
  const POLL_INTERVAL_MS = 10_000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const status = await getVerifyStatus(apiUrl, apiKey, guid);
    const result = status.result || '';
    console.log(`   [${contractKey}] Poll ${i + 1}/${MAX_POLLS}: ${result}`);

    if (result === 'Pass - Verified') return { ok: true, message: result };
    if (result.startsWith('Fail')) return { ok: false, message: result };
    if (result === 'Already Verified') return { ok: true, message: result };
    // "Pending in queue" / "In queue" — keep polling
  }
  return { ok: false, message: 'Timed out waiting for verification result' };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// VERIFY ONE CONTRACT
// ============================================================

async function verifyOne(contractKey, config, address, chainKey, state, buildInfo, dryRun) {
  const artifactName = config.artifact || contractKey;
  const artifact = loadArtifact(artifactName);
  if (!artifact) {
    return { status: 'skip', reason: `artifact not found for ${artifactName}` };
  }

  const chain = CHAINS[chainKey];
  if (!chain) {
    return { status: 'skip', reason: `no CHAINS entry for ${chainKey}` };
  }

  // Reconstruct constructor args
  let args;
  try {
    const envPrefix = chainKey.replace(/L1$|L2b$|L2$/, '').toLowerCase() || 'testnet';
    const env = chainKey.startsWith('testnet') ? 'testnet'
      : chainKey.startsWith('mainnet') ? 'mainnet'
      : 'dev';
    args = config.constructorArgs(state, chainKey, env);
  } catch (err) {
    return { status: 'skip', reason: `constructor args error: ${err.message}` };
  }

  let encodedArgs = '';
  try {
    encodedArgs = encodeConstructorArgs(artifact.abi, args);
  } catch (err) {
    return { status: 'error', reason: `ABI encoding failed: ${err.message}` };
  }

  const contractName = artifact.contractName;
  const sourceName   = artifact.sourceName;
  const solcVersion  = `v${buildInfo.solcLongVersion}`;

  // Strip outputSelection from the input before sending — Etherscan rejects
  // input objects that contain outputSelection keys it doesn't recognise.
  const standardJsonInput = JSON.parse(JSON.stringify(buildInfo.input));
  if (standardJsonInput.settings?.outputSelection) {
    delete standardJsonInput.settings.outputSelection;
  }

  const apiUrl = chain.etherscanApi;
  const apiKey = getApiKey(chainKey);

  if (dryRun) {
    console.log(`\n[DRY-RUN] ${contractKey}`);
    console.log(`   Address   : ${address}`);
    console.log(`   Chain     : ${chain.name} (${chainKey})`);
    console.log(`   API URL   : ${apiUrl}`);
    console.log(`   Contract  : ${sourceName}:${contractName}`);
    console.log(`   Compiler  : ${solcVersion}`);
    console.log(`   Args raw  :`, args.length ? args : '(none)');
    console.log(`   Args enc  : ${encodedArgs ? encodedArgs.slice(0, 80) + (encodedArgs.length > 80 ? '…' : '') : '(none)'}`);
    console.log(`   API key   : ${apiKey ? apiKey.slice(0, 6) + '…' : '(MISSING)'}`);
    return { status: 'dry-run' };
  }

  if (!apiKey) {
    return { status: 'error', reason: `No Etherscan API key for chain ${chainKey}. Set ETHERSCAN_API_KEY_L1 / ETHERSCAN_API_KEY_L2 / ETHERSCAN_API_KEY_L2B or ETHERSCAN_API_KEY in .env` };
  }

  console.log(`\n[VERIFY] ${contractKey} @ ${address} on ${chain.name}`);

  // Submit verification
  const payload = buildVerifyPayload({
    apiKey,
    address,
    contractName,
    sourceName,
    solcVersion,
    standardJsonInput,
    encodedArgs,
  });

  let submitResponse;
  try {
    submitResponse = await postForm(apiUrl, payload);
  } catch (err) {
    return { status: 'error', reason: `HTTP error submitting: ${err.message}` };
  }

  console.log(`   Submit response: status=${submitResponse.status} result=${submitResponse.result}`);

  // Etherscan returns status=1 with a GUID when queued, or specific strings for already-verified.
  const result = submitResponse.result || '';

  if (
    result === 'Contract source code already verified' ||
    result === 'Already Verified' ||
    result.toLowerCase().includes('already verified')
  ) {
    console.log(`   Already verified — treating as success`);
    return { status: 'ok', message: 'already verified' };
  }

  if (submitResponse.status !== '1') {
    return { status: 'error', reason: `Submission rejected: ${result}` };
  }

  // GUID returned — poll for result
  const guid = result;
  console.log(`   Queued with GUID: ${guid} — polling…`);
  const pollResult = await pollUntilDone(apiUrl, apiKey, guid, contractKey);
  if (pollResult.ok) {
    console.log(`   Verified: ${chain.etherscanBrowser}/address/${address}#code`);
    return { status: 'ok', message: pollResult.message };
  }
  return { status: 'error', reason: pollResult.message };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const argv = process.argv.slice(2);

  let dryRun         = false;
  let filterContract = null;
  let filterChain    = null;
  let env            = 'testnet';
  let stateFile      = path.join(__dirname, '../.deploy-state.json');

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run':    dryRun         = true;          break;
      case '--contract':  filterContract = argv[++i];     break;
      case '--chain':     filterChain    = argv[++i];     break;
      case '--env':       env            = argv[++i];     break;
      case '--state-file':stateFile      = path.resolve(argv[++i]); break;
      case '--help':
        console.log(`Usage: node scripts/verify-etherscan.js [options]

Options:
  --dry-run                Preview what would be verified, don't submit
  --contract <key>         Verify a specific contract key (e.g. CawProfile)
  --chain <L1|L2|L2b>      Verify only contracts on the given abstract chain
  --env <testnet|mainnet>  Environment (default: testnet)
  --state-file <path>      Path to deploy state JSON (default: .deploy-state.json)
  --help                   Show this help

API keys (in solidity/.env):
  ETHERSCAN_API_KEY        Shared fallback key for all chains
  ETHERSCAN_API_KEY_L1     Sepolia Etherscan
  ETHERSCAN_API_KEY_L2     Base Sepolia Basescan
  ETHERSCAN_API_KEY_L2B    Arbitrum Sepolia Arbiscan
  BASESCAN_API_KEY         Alias for L2
  ARBISCAN_API_KEY         Alias for L2b
`);
        process.exit(0);
    }
  }

  // Load state
  if (!fs.existsSync(stateFile)) {
    console.error(`State file not found: ${stateFile}`);
    console.error('Run scripts/deploy.js first, or pass --state-file <path>');
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  console.log(`Loaded state from ${stateFile}`);
  console.log(`Addresses in state: ${Object.keys(state.addresses || {}).length}`);

  // Load build info
  let buildInfo;
  try {
    buildInfo = loadBuildInfo();
    console.log(`Build info: solc ${buildInfo.solcLongVersion}`);
  } catch (err) {
    console.error(`Error loading build info: ${err.message}`);
    process.exit(1);
  }

  state.verification = state.verification || {};

  // Build the list of contracts to process
  const todo = [];

  for (const [key, config] of Object.entries(CONTRACTS)) {
    // Filter by --contract
    if (filterContract && key !== filterContract) continue;

    // Filter by --chain (abstract chain key: L1, L2, L2b)
    if (filterChain && config.chain !== filterChain) continue;

    // Skip pre-existing / external contracts not in this deploy
    if (SKIP_VERIFY_KEYS.has(key)) continue;
    if (config.skipVerify) continue;

    // Skip if no address in state
    const address = state.addresses[key];
    if (!address) continue;

    // Skip if already verified (idempotency) — unless in dry-run mode
    if (!dryRun && state.verification[key]?.verified) {
      console.log(`Skipping ${key} — already verified (${state.verification[key].ts})`);
      continue;
    }

    // Resolve the full chain key (e.g. 'testnetL2')
    const chainKey = env + config.chain;
    if (!CHAINS[chainKey]) {
      console.warn(`Skipping ${key} — no CHAINS entry for ${chainKey}`);
      continue;
    }

    todo.push({ key, config, address, chainKey });
  }

  if (todo.length === 0) {
    console.log('\nNothing to verify.');
    if (dryRun) console.log('(All deployed contracts may already be recorded as verified in state — re-run without --dry-run to check)');
    return;
  }

  console.log(`\nContracts to verify: ${todo.length}`);

  // ---- Results tracking ----
  const results = { ok: [], error: [], skip: [] };

  for (let idx = 0; idx < todo.length; idx++) {
    const { key, config, address, chainKey } = todo[idx];
    const result = await verifyOne(key, config, address, chainKey, state, buildInfo, dryRun);

    if (result.status === 'ok') {
      results.ok.push(key);
      if (!dryRun) {
        state.verification[key] = { verified: true, ts: new Date().toISOString(), message: result.message };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      }
    } else if (result.status === 'dry-run') {
      // no-op for dry-run
    } else if (result.status === 'skip') {
      results.skip.push({ key, reason: result.reason });
      console.log(`   Skipping ${key}: ${result.reason}`);
    } else {
      results.error.push({ key, reason: result.reason });
      console.error(`   ERROR ${key}: ${result.reason}`);
    }

    // Etherscan rate-limit: ~5 requests/sec on free tier; add a short pause
    // between submissions when verifying multiple contracts to avoid 429s.
    if (!dryRun && idx < todo.length - 1) {
      await sleep(1500);
    }
  }

  // ---- Summary table ----
  console.log('\n' + '='.repeat(60));
  console.log(dryRun ? 'DRY-RUN SUMMARY' : 'VERIFICATION SUMMARY');
  console.log('='.repeat(60));

  if (!dryRun) {
    if (results.ok.length > 0) {
      console.log(`\nVerified (${results.ok.length}):`);
      for (const key of results.ok) {
        const addr = state.addresses[key];
        const chainKey = env + CONTRACTS[key].chain;
        const browser = CHAINS[chainKey]?.etherscanBrowser || '';
        console.log(`  [OK] ${key.padEnd(35)} ${addr}  ${browser}/address/${addr}#code`);
      }
    }
    if (results.error.length > 0) {
      console.log(`\nFailed (${results.error.length}):`);
      for (const { key, reason } of results.error) {
        console.log(`  [FAIL] ${key.padEnd(33)} ${reason}`);
      }
    }
    if (results.skip.length > 0) {
      console.log(`\nSkipped (${results.skip.length}):`);
      for (const { key, reason } of results.skip) {
        console.log(`  [SKIP] ${key.padEnd(33)} ${reason}`);
      }
    }
  } else {
    console.log(`\nDry-run complete — ${todo.length} contracts would be submitted for verification.`);
    console.log('Re-run without --dry-run to submit.');
  }

  if (!dryRun) {
    const failed = results.error.filter(e => !e.reason.includes('already verified')).length;
    if (failed > 0) {
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
