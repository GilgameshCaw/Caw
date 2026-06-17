/**
 * mint-cawai.js — one-shot script to mint the @cawai profile on testnet
 *
 * Usage:
 *   cd solidity && node scripts/mint-cawai.js
 *
 * What it does:
 *   Calls mintAndDepositZap on CawProfileMinter to register the username
 *   "cawai", swap ETH for CAW via Uniswap, burn the name cost, and deposit the
 *   remainder into the profile — targeting the Network's L2 (lzDestId = L2 eid)
 *   so the deposit BRIDGES to L2 and stakes. The resulting tokenId is printed in
 *   copy-paste form for use in CawAI service config.
 *
 *   IMPORTANT: this deposits to L2, not L1. An earlier version passed L1's own
 *   eid (bypassLZ), which left the deposit parked on L1 and showed 0 staked on
 *   L2. The LayerZero fee for the L2 message is quoted at runtime and added to
 *   the tx value. (If a profile ever ends up with an L1-parked balance, see
 *   stake-cawai.js to push it to L2.)
 *
 * Idempotent:
 *   Reads idByUsername('cawai') on-chain first. If non-zero, prints the
 *   existing tokenId and exits 0 without sending any transaction.
 *
 * Cost:
 *   ~0.03 ETH swap (tuned to cover the 200M CAW name burn) + the quoted
 *   LayerZero fee (~0.001 ETH) + gas. Override swap via MINT_SWAP_ETH.
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

// LayerZero destination for the deposit. This MUST be the Network's L2 eid, not
// L1's own eid: passing L1's eid (40161) triggers the bypassLZ path, which keeps
// the deposit ON L1 and never credits the L2 ledger — so the profile shows 0
// staked on L2 (staking is an L2 balance). The original version of this script
// used 40161 and left @cawai's deposit parked on L1; see stake-cawai.js for the
// remediation. 40245 = Base Sepolia, the testnet Network's L2, so the deposit
// bridges to L2 and stakes. Override with MINT_LZ_DEST_ID for other Networks.
const L2_EID     = Number(process.env.MINT_LZ_DEST_ID || 40245);
const LZ_DEST_ID = L2_EID;

// Quoter — used to price the LayerZero fee for the L2-bound deposit message.
const QUOTER_ADDRESS = '0xB5E6415EDffCe9480dB1188125cd45abe0Bd501F'; // deployments.ts testnet.L1

// Mint parameters.
// The swap must yield at least costOfName('cawai') CAW. "cawai" is 5 chars →
// burn cost = 200,000,000 CAW. The ETH→CAW rate depends on live pool reserves,
// so SWAP_ETH_AMOUNT is tuned to the current testnet CAW/WETH pool: 0.005 ETH
// only swaps to ~70M CAW (reverts "Swap output < burn cost"); ~0.03 ETH yields
// ~370M CAW, covering the burn with surplus deposited into the profile.
// Override via env for different pool conditions: MINT_SWAP_ETH / MINT_TX_VALUE.
const NETWORK_ID      = 1;                          // Uruk (first registered network)
const USERNAME        = 'cawai';
const SWAP_ETH_AMOUNT = ethers.parseEther(process.env.MINT_SWAP_ETH || '0.03');
const MIN_CAW_OUT     = 0n;                         // no slippage guard; deployer is sole caller
const LZ_TOKEN_AMOUNT = 0n;                         // pay LZ fee in native ETH, not LZ token
// TX_VALUE = swap ETH + the LayerZero fee for the L2-bound deposit message.
// The LZ fee is QUOTED at runtime (see main); MINT_TX_VALUE can override the
// whole value if you need to force a specific amount.

// Minimal ABI — only the functions this script calls.
const MINTER_ABI = [
  'function idByUsername(string) external view returns (uint32)',
  'function mintAndDepositZap(uint32 networkId, string username, uint256 swapEthAmount, uint256 minCawOut, uint32 lzDestId, uint256 lzTokenAmount) external payable',
];
const QUOTER_ABI = [
  'function mintAndDepositZapQuote(uint32 networkId, uint32 lzDestId, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
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

  // --- compute value: swap ETH + LayerZero fee for the L2-bound deposit ---
  // Because the deposit targets L2 (not bypassLZ), the mint fires a LayerZero
  // message and must be funded with its fee. Quote it and add to the swap ETH.
  let lzFee;
  try {
    const quoter = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);
    const q = await quoter.mintAndDepositZapQuote(NETWORK_ID, LZ_DEST_ID, false);
    lzFee = q.nativeFee;
  } catch (e) {
    console.error(`ERROR: failed to quote LayerZero fee: ${e.shortMessage || e.message}`);
    process.exit(1);
  }
  // value = swap + LZ fee, plus a 15% buffer (CawProfile refunds unused LZ ETH).
  // MINT_TX_VALUE overrides the computed value entirely if set.
  const TX_VALUE = process.env.MINT_TX_VALUE
    ? ethers.parseEther(process.env.MINT_TX_VALUE)
    : SWAP_ETH_AMOUNT + (lzFee * 115n) / 100n;

  if (balance < TX_VALUE) {
    console.error(`ERROR: Insufficient balance. Need at least ${ethers.formatEther(TX_VALUE)} ETH, have ${ethers.formatEther(balance)} ETH.`);
    process.exit(1);
  }

  // --- mint ---
  console.log(
    `Minting @${USERNAME} (networkId=${NETWORK_ID}, swapEth=${ethers.formatEther(SWAP_ETH_AMOUNT)} ETH, ` +
    `lzDestId=${LZ_DEST_ID} [L2], lzFee=${ethers.formatEther(lzFee)} ETH, value=${ethers.formatEther(TX_VALUE)} ETH)...`,
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
