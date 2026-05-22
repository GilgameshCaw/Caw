/**
 * lower-uruk-fees.js
 *
 * One-shot script that drops Uruk's (networkId = 1) on-chain fees + the
 * depositFee ceiling. Run by the Network owner only.
 *
 *   mintFee:     0.00025 → 0.000125 ETH   (50% off)
 *   depositFee:  0.001   → 0.0005  ETH   (50% off)
 *   authFee:     0.00025 → 0.000125 ETH   (50% off)
 *   withdrawFee: 0.001   → 0.00075 ETH   (25% off)
 *
 *   depositFeeCeiling: 0.0025 → 0.001 ETH (same as mint/auth ceilings)
 *
 * Order matters: lowerDepositFeeCeiling requires newCeiling >= depositFee,
 * so we setFees(...) first and only then lower the ceiling.
 *
 * Idempotent: each step checks the current value first and skips if the
 * target already matches.
 *
 * Reverse: nothing here is one-way; the Network owner can call setFees
 * again at any time (fees can move up to ceiling). Ceiling lowers ARE
 * one-way — this script's depositFeeCeiling reduction is permanent.
 *
 * Usage:
 *   node scripts/lower-uruk-fees.js              # broadcast
 *   node scripts/lower-uruk-fees.js --dry-run    # show what would happen
 *
 * Prereqs:
 *   - L1_RPC_URL + PRIVATE_KEYS in solidity/.env
 *   - The first key in PRIVATE_KEYS is the Network owner (deployer)
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─── Config ────────────────────────────────────────────────────────────────

const URUK_NETWORK_ID = 1;
const SEPOLIA_RPC = process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io';

// Target values (post-reduction)
const TARGETS = {
  mintFee:           ethers.parseEther('0.000125'),
  depositFee:        ethers.parseEther('0.0005'),
  authFee:           ethers.parseEther('0.000125'),
  withdrawFee:       ethers.parseEther('0.00075'),
  depositFeeCeiling: ethers.parseEther('0.001'),
};

// Minimal ABI — just what we touch
const NM_ABI = [
  'function getMintFee(uint32) view returns (uint256)',
  'function getDepositFee(uint32) view returns (uint256)',
  'function getAuthFee(uint32) view returns (uint256)',
  'function getWithdrawFee(uint32) view returns (uint256)',
  'function getDepositFeeCeiling(uint32) view returns (uint256)',
  'function getNetwork(uint32) view returns (tuple(uint32 id, uint32 storageChainEid, string name, address feeAddress, address ownerAddress, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee, uint256 creationBlock, uint256 withdrawFeeCeiling, uint256 depositFeeCeiling, uint256 authFeeCeiling, uint256 mintFeeCeiling))',
  'function setFees(uint32 networkId, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee)',
  'function lowerDepositFeeCeiling(uint32 networkId, uint256 newCeiling)',
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtEth(wei) {
  return `${ethers.formatEther(wei)} ETH`;
}

function loadDeployState() {
  const p = path.resolve(__dirname, '..', '.deploy-state.json');
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const keys = (process.env.PRIVATE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error('PRIVATE_KEYS missing in .env');
  const ownerKey = keys[0];

  const state = loadDeployState();
  const nmAddr = state.addresses?.CawNetworkManager;
  if (!nmAddr) throw new Error('CawNetworkManager not in .deploy-state.json');

  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(ownerKey, provider);
  const nm = new ethers.Contract(nmAddr, NM_ABI, wallet);

  console.log(`\n=== Lower Uruk fees (networkId=${URUK_NETWORK_ID}) ===`);
  console.log(`Sepolia RPC: ${SEPOLIA_RPC}`);
  console.log(`NetworkManager: ${nmAddr}`);
  console.log(`Wallet: ${wallet.address}`);

  // Sanity: confirm the deployer wallet is the Network owner
  const net = await nm.getNetwork(URUK_NETWORK_ID);
  console.log(`Network name: "${net.name}", owner: ${net.ownerAddress}`);
  if (net.ownerAddress.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Wallet ${wallet.address} is not the owner of networkId ${URUK_NETWORK_ID} (owner is ${net.ownerAddress}). Aborting.`);
  }

  // Read current values
  const cur = {
    mintFee:           await nm.getMintFee(URUK_NETWORK_ID),
    depositFee:        await nm.getDepositFee(URUK_NETWORK_ID),
    authFee:           await nm.getAuthFee(URUK_NETWORK_ID),
    withdrawFee:       await nm.getWithdrawFee(URUK_NETWORK_ID),
    depositFeeCeiling: await nm.getDepositFeeCeiling(URUK_NETWORK_ID),
  };

  console.log('\nCurrent vs target:');
  for (const k of Object.keys(TARGETS)) {
    const arrow = cur[k] === TARGETS[k] ? '== (no-op)' : '→';
    console.log(`  ${k.padEnd(20)} ${fmtEth(cur[k]).padStart(22)} ${arrow} ${fmtEth(TARGETS[k])}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] No transactions broadcast.');
    return;
  }

  // Step 1: setFees (all four current fees in one tx)
  const feesAlreadyTarget =
    cur.mintFee === TARGETS.mintFee &&
    cur.depositFee === TARGETS.depositFee &&
    cur.authFee === TARGETS.authFee &&
    cur.withdrawFee === TARGETS.withdrawFee;

  if (feesAlreadyTarget) {
    console.log('\n[skip] Current fees already at target.');
  } else {
    console.log('\n[1/2] setFees(...)');
    const tx1 = await nm.setFees(
      URUK_NETWORK_ID,
      TARGETS.withdrawFee,
      TARGETS.depositFee,
      TARGETS.authFee,
      TARGETS.mintFee
    );
    console.log(`  tx: ${tx1.hash}`);
    const rc1 = await tx1.wait();
    console.log(`  mined in block ${rc1.blockNumber}, gas used ${rc1.gasUsed.toString()}`);
  }

  // Step 2: lowerDepositFeeCeiling (must come AFTER setFees so the new
  // ceiling isn't below the still-current depositFee)
  if (cur.depositFeeCeiling === TARGETS.depositFeeCeiling) {
    console.log('\n[skip] depositFeeCeiling already at target.');
  } else if (cur.depositFeeCeiling < TARGETS.depositFeeCeiling) {
    console.log(`\n[skip] depositFeeCeiling (${fmtEth(cur.depositFeeCeiling)}) already below target — ceiling can only move DOWN.`);
  } else {
    console.log('\n[2/2] lowerDepositFeeCeiling(...)');
    const tx2 = await nm.lowerDepositFeeCeiling(URUK_NETWORK_ID, TARGETS.depositFeeCeiling);
    console.log(`  tx: ${tx2.hash}`);
    const rc2 = await tx2.wait();
    console.log(`  mined in block ${rc2.blockNumber}, gas used ${rc2.gasUsed.toString()}`);
  }

  console.log('\nDone. Final state:');
  for (const k of Object.keys(TARGETS)) {
    const getter = k === 'depositFeeCeiling' ? 'getDepositFeeCeiling' : `get${k.charAt(0).toUpperCase()}${k.slice(1)}`;
    const v = await nm[getter](URUK_NETWORK_ID);
    console.log(`  ${k.padEnd(20)} ${fmtEth(v)}`);
  }
}

main().catch(e => {
  console.error('\nERROR:', e.message || e);
  process.exit(1);
});
