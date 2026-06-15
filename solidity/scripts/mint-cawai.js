/**
 * mint-cawai.js — one-shot script to mint the @cawai profile on testnet
 *
 * Usage:
 *   cd solidity && node scripts/mint-cawai.js
 *
 * What it does:
 *   Calls mintAndDepositZap on CawProfileMinter to register the username
 *   "cawai", swap 0.005 ETH for CAW via Uniswap, burn the name cost, and
 *   deposit the remainder into the profile. The resulting tokenId is printed
 *   in copy-paste form for use in CawAI service config.
 *
 * Idempotent:
 *   Reads idByUsername('cawai') on-chain first. If non-zero, prints the
 *   existing tokenId and exits 0 without sending any transaction.
 *
 * Cost:
 *   ~0.006 ETH (~$10–$15 at typical ETH prices) plus gas on Sepolia.
 *
 * Required env vars (in solidity/.env or environment):
 *   L1_RPC_URL    — Sepolia RPC endpoint
 *   PRIVATE_KEYS  — Comma-separated private keys; first entry is used
 *                   (OR PRIVATE_KEY as a single-key fallback)
 *   CAW_WETH_PAIR — Uniswap V2 CAW/WETH pair address (must be a live pool)
 */

'use strict';

const { ethers } = require('ethers');
const fs         = require('fs');
const path       = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Testnet L1 (Sepolia) CawProfileMinter — source: deployments.ts testnet.L1
// and confirmed in .deploy-state.json addresses.CawProfileMinter.
const MINTER_ADDRESS = '0xe6eF1c8705a28DF44FA5F04c8B282b545A454Fed';

// Sepolia lzEid — matches CHAINS.testnetL1.lzEid in deploy.js.
// Passing L1's own lzEid as lzDestId activates the bypassLZ path inside
// mintAndDepositZap (no actual LayerZero message; deposit applied on L1).
const LZ_DEST_ID = 40161;

// Mint parameters — identical to Phase 8 in deploy.js lines 1389-1406.
const NETWORK_ID      = 1;                          // Uruk (first registered network)
const USERNAME        = 'cawai';
const SWAP_ETH_AMOUNT = ethers.parseEther('0.005'); // ~$10 worth of CAW at ETH=$2000
const MIN_CAW_OUT     = 0n;                         // no slippage guard; deployer is sole caller
const LZ_TOKEN_AMOUNT = 0n;                         // no LZ fee for bypassLZ path
const TX_VALUE        = ethers.parseEther('0.006'); // swap + LZ/storage buffer

// Minimal ABI — only the two functions this script calls.
const MINTER_ABI = [
  'function idByUsername(string) external view returns (uint32)',
  'function mintAndDepositZap(uint32 networkId, string username, uint256 swapEthAmount, uint256 minCawOut, uint32 lzDestId, uint256 lzTokenAmount) external payable',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadArtifactAbi(contractName) {
  const artifactPath = path.join(
    __dirname,
    '../artifacts/contracts',
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  if (fs.existsSync(artifactPath)) {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8')).abi;
  }
  // Fall back to inline minimal ABI defined above (no compile step required).
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- env guards ---
  if (!process.env.CAW_WETH_PAIR) {
    console.error('ERROR: CAW_WETH_PAIR is not set. A live Uniswap V2 CAW/WETH pool is required.');
    console.error('       Set CAW_WETH_PAIR=<pair address> in solidity/.env before running.');
    process.exit(1);
  }

  // --- provider ---
  const rpc = process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io';
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const network = await provider.getNetwork();
  console.log(`Connected to chain ID ${network.chainId} (${rpc})`);

  // --- wallet ---
  const rawKeys = process.env.PRIVATE_KEYS
    ? process.env.PRIVATE_KEYS.split(',')
    : process.env.PRIVATE_KEY
      ? [process.env.PRIVATE_KEY]
      : [];

  if (rawKeys.length === 0) {
    console.error('ERROR: No private key found. Set PRIVATE_KEYS (comma-separated) or PRIVATE_KEY in solidity/.env.');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(rawKeys[0].trim(), provider);
  const balance = await provider.getBalance(wallet.address);
  console.log(`Wallet: ${wallet.address} (${ethers.formatEther(balance)} ETH)`);

  if (balance < TX_VALUE) {
    console.error(`ERROR: Insufficient balance. Need at least ${ethers.formatEther(TX_VALUE)} ETH, have ${ethers.formatEther(balance)} ETH.`);
    process.exit(1);
  }

  // --- contract handle ---
  // Prefer the fully-compiled artifact ABI when available (more complete for
  // future-proofing); fall back to the inline minimal ABI defined above.
  const abi = loadArtifactAbi('CawProfileMinter') || MINTER_ABI;
  const minter = new ethers.Contract(MINTER_ADDRESS, abi, wallet);

  // --- idempotency check ---
  const existingId = await minter.idByUsername(USERNAME);
  if (existingId !== 0n) {
    console.log(`@${USERNAME} already minted — tokenId=${existingId}`);
    console.log('');
    console.log(`CAW_AI_PROFILE_TOKEN_ID=${existingId}`);
    process.exit(0);
  }

  // --- mint ---
  console.log(
    `Minting @${USERNAME} (networkId=${NETWORK_ID}, swapEth=${ethers.formatEther(SWAP_ETH_AMOUNT)} ETH, ` +
    `lzDestId=${LZ_DEST_ID}, value=${ethers.formatEther(TX_VALUE)} ETH)...`,
  );

  const tx = await minter.mintAndDepositZap(
    NETWORK_ID,
    USERNAME,
    SWAP_ETH_AMOUNT,
    MIN_CAW_OUT,
    LZ_DEST_ID,
    LZ_TOKEN_AMOUNT,
    { value: TX_VALUE },
  );

  console.log(`Tx submitted: ${tx.hash}`);
  console.log('Waiting for confirmation...');
  await tx.wait();
  console.log('Confirmed.');

  // --- read back ---
  const tokenId = await minter.idByUsername(USERNAME);
  console.log(`@${USERNAME} minted as tokenId=${tokenId}`);
  console.log('');
  console.log(`CAW_AI_PROFILE_TOKEN_ID=${tokenId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
