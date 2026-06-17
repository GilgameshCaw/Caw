/**
 * stake-cawai.js — deposit CAW into the @cawai profile, targeting L2 so it
 * actually STAKES (earns yield, lets the bot act on L2).
 *
 * Context: mint-cawai.js used the bypassLZ path (lzDestId = L1's own eid), so
 * its ~170M CAW deposit landed on L1 and never propagated to L2. Staking is an
 * L2 balance (CawProfileLedger.cawBalanceOf on the L2), so @cawai showed 0
 * staked. This script deposits CAW with lzDestId = the L2 eid, which fires the
 * LayerZero message that credits the L2 ledger.
 *
 * Usage:
 *   cd solidity && node scripts/stake-cawai.js
 *
 * What it does:
 *   1. Quotes the LayerZero + deposit/auth fee via CawProfileQuoter.depositQuote.
 *   2. Approves CawProfile to pull the deposit amount of CAW.
 *   3. Calls CawProfile.depositFor(networkId, tokenId, amount, L2_EID, 0) with
 *      value = quoted nativeFee. The deposit bridges to L2 and stakes.
 *   4. Prints the L2 balance is pending (LZ delivery is async — confirm with a
 *      cawBalanceOf read on L2 a minute later).
 *
 * Env (solidity/.env): L1_RPC_URL, PRIVATE_KEYS (or PRIVATE_KEY).
 */

'use strict';

const { ethers } = require('ethers');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Testnet addresses (deployments.ts testnet.L1).
const CAW          = '0x56817dc696448135203C0556f702c6a953260411';
const CAW_PROFILE  = '0x4F853523102577dDaf5fdbc823EDdCB13b35C543';
const QUOTER       = '0xB5E6415EDffCe9480dB1188125cd45abe0Bd501F';

const NETWORK_ID   = 1;                                  // Uruk
const TOKEN_ID     = 2;                                  // @cawai
const L2_EID       = 40245;                              // Base Sepolia (Network's L2)
// Match the intended seed: the ~170M the mint left parked on L1.
const DEPOSIT      = ethers.parseEther(process.env.STAKE_AMOUNT || '170000000');

const CAW_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];
const PROFILE_ABI = [
  'function depositFor(uint32 cawNetworkId, uint32 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount) payable',
];
const QUOTER_ABI = [
  'function depositQuote(uint32 networkId, uint32 tokenId, uint256 amount, uint32 lzDestId, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
];

async function main() {
  const rpc = process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io';
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  console.log(`Connected to chain ${net.chainId} (${rpc})`);

  const rawKeys = process.env.PRIVATE_KEYS
    ? process.env.PRIVATE_KEYS.split(',')
    : process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];
  if (!rawKeys.length) { console.error('No PRIVATE_KEYS / PRIVATE_KEY set.'); process.exit(1); }
  const wallet = new ethers.Wallet(rawKeys[0].trim(), provider);

  const caw     = new ethers.Contract(CAW, CAW_ABI, wallet);
  const profile = new ethers.Contract(CAW_PROFILE, PROFILE_ABI, wallet);
  const quoter  = new ethers.Contract(QUOTER, QUOTER_ABI, provider);

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Deposit: ${ethers.formatEther(DEPOSIT)} CAW → tokenId ${TOKEN_ID} on L2 (eid ${L2_EID})`);

  const cawBal = await caw.balanceOf(wallet.address);
  if (cawBal < DEPOSIT) {
    console.error(`Insufficient CAW: have ${ethers.formatEther(cawBal)}, need ${ethers.formatEther(DEPOSIT)}`);
    process.exit(1);
  }

  // --- quote LZ + fees ---
  const quote = await quoter.depositQuote(NETWORK_ID, TOKEN_ID, DEPOSIT, L2_EID, false);
  const nativeFee = quote.nativeFee;
  console.log(`Quoted value (LZ + deposit/auth fees): ${ethers.formatEther(nativeFee)} ETH`);

  const ethBal = await provider.getBalance(wallet.address);
  if (ethBal < nativeFee) {
    console.error(`Insufficient ETH for fee: have ${ethers.formatEther(ethBal)}, need ${ethers.formatEther(nativeFee)}`);
    process.exit(1);
  }

  // --- approve CAW (CawProfile pulls via transferFrom) ---
  const allowance = await caw.allowance(wallet.address, CAW_PROFILE);
  if (allowance < DEPOSIT) {
    console.log('Approving CAW…');
    const atx = await caw.approve(CAW_PROFILE, DEPOSIT);
    await atx.wait();
    console.log(`  approved (${atx.hash})`);
  }

  // --- depositFor → L2 ---
  // Add a small buffer over the quote for safety; CawProfile refunds unused LZ ETH.
  const value = (nativeFee * 110n) / 100n;
  console.log(`Depositing (value=${ethers.formatEther(value)} ETH, includes refundable buffer)…`);
  const tx = await profile.depositFor(NETWORK_ID, TOKEN_ID, DEPOSIT, L2_EID, 0n, { value });
  console.log(`Tx: ${tx.hash}`);
  await tx.wait();
  console.log('Confirmed on L1. LayerZero delivery to L2 is async (usually < a few min).');
  console.log('Verify with: cawBalanceOf(2) on the L2 CawProfileLedger should show the deposit.');
}

main().catch((e) => { console.error(e); process.exit(1); });
