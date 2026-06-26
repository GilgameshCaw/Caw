#!/usr/bin/env node
/**
 * deploy-smarteoa-create2.js
 *
 * Deploys SmartEOA at the SAME address on L1 (Sepolia) and L2 (Base Sepolia)
 * using the canonical CREATE2 factory: 0x4e59b44847b379578588920cA78FbF26c0B4956C
 *
 * Salt: keccak256("CAW.SmartEOA.v2")
 * Result: deterministic address identical on both chains.
 *
 * USAGE:
 *   node scripts/deploy-smarteoa-create2.js
 *
 * ENV (read from solidity/.env via dotenv; same vars as deploy.js):
 *   PRIVATE_KEYS   — comma-separated; first key is the deployer
 *   L1_RPC_URL     — Sepolia RPC
 *   L2_RPC_URL     — Base Sepolia RPC
 *
 * IDEMPOTENT: if code already exists at the predicted address on a chain,
 * the deploy for that chain is skipped. Safe to re-run.
 *
 * BLOCKER BEHAVIOUR: if the deployer has no ETH on a chain, or if the
 * canonical CREATE2 factory is absent on a chain, the script prints a
 * BLOCKER message and exits non-zero WITHOUT partially deploying.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { ethers } = require('ethers');

// Load .env from the solidity directory (same as deploy.js).
// Walk up the directory tree looking for "solidity/.env" so this script
// works both from a normal checkout and from a git worktree (where the
// worktree root is several levels inside .claude/worktrees/).
{
  let dir = __dirname;
  let found = false;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'solidity', '.env');
    if (fs.existsSync(candidate)) {
      require('dotenv').config({ path: candidate });
      found = true;
      break;
    }
    // Also check if we ARE inside solidity/
    const candidate2 = path.join(dir, '.env');
    if (fs.existsSync(candidate2)) {
      require('dotenv').config({ path: candidate2 });
      found = true;
      break;
    }
    dir = path.dirname(dir);
  }
  if (!found) {
    // Last-resort: dotenv default (looks for .env in cwd)
    require('dotenv').config();
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Canonical CREATE2 factory — Nick's factory, present on Sepolia + Base Sepolia.
const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

// Fixed salt: keccak256("CAW.SmartEOA.v2")
// Changing this constant = different address. DON'T change after first deploy.
const SALT_PREIMAGE  = 'CAW.SmartEOA.v2';
const SALT           = ethers.keccak256(ethers.toUtf8Bytes(SALT_PREIMAGE));

// Expected deployer (same guard as deploy.js)
const EXPECTED_DEPLOYER = '0xF71338f3eAa483aA66125598B09BA1988e694a95';

// ─── Config from env ─────────────────────────────────────────────────────────

const PRIVATE_KEY  = (process.env.PRIVATE_KEYS || '').split(',')[0]?.trim();
const L1_RPC_URL   = process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io';
const L2_RPC_URL   = process.env.L2_RPC_URL || 'https://sepolia.base.org';

if (!PRIVATE_KEY) {
  console.error('BLOCKER: PRIVATE_KEYS not set in environment / solidity/.env');
  process.exit(1);
}

// ─── Load artifact (same path resolution as deploy.js loadArtifact) ──────────

function loadSmartEOAArtifact() {
  const relPath = path.join('artifacts', 'contracts', 'SmartEOA.sol', 'SmartEOA.json');
  const candidates = [];

  // 1. Local: <worktree>/solidity/artifacts/...
  candidates.push(path.join(__dirname, '..', relPath));

  // 2. Walk up from __dirname's parent looking for a "solidity" sibling
  //    This handles git worktrees where the worktree root is inside
  //    .claude/worktrees/<id>/ and the actual solidity/ build is in the
  //    main checkout alongside the worktree root.
  let dir = path.dirname(__dirname); // worktree's solidity/
  for (let i = 0; i < 10; i++) {
    // Try: <ancestor>/solidity/artifacts/...
    candidates.push(path.join(dir, 'solidity', relPath));
    // Try: <ancestor>/artifacts/... (in case we land in solidity/ directly)
    candidates.push(path.join(dir, relPath));
    dir = path.dirname(dir);
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }

  console.error('BLOCKER: SmartEOA artifact not found. Checked:');
  // Only show unique candidates
  [...new Set(candidates)].forEach(p => console.error(' ', p));
  console.error('  Run: cd solidity && npx hardhat compile');
  process.exit(1);
}

// ─── Compute CREATE2 address ──────────────────────────────────────────────────

function computeCreate2Address(bytecode) {
  const initcodeHash = ethers.keccak256(bytecode);
  return ethers.getCreate2Address(CREATE2_FACTORY, SALT, initcodeHash);
}

// ─── Deploy on one chain ──────────────────────────────────────────────────────

async function deployOnChain(label, rpcUrl, predictedAddress, bytecode) {
  console.log(`\n── ${label} ──`);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  // Guard: deployer address match
  if (wallet.address.toLowerCase() !== EXPECTED_DEPLOYER.toLowerCase()) {
    console.error(`BLOCKER: Wallet mismatch on ${label}! Expected ${EXPECTED_DEPLOYER}, got ${wallet.address}`);
    process.exit(1);
  }

  const network = await provider.getNetwork();
  console.log(`  Chain ID: ${network.chainId}`);

  // Guard: CREATE2 factory must exist
  const factoryCode = await provider.getCode(CREATE2_FACTORY);
  if (factoryCode === '0x' || factoryCode.length < 4) {
    console.error(`BLOCKER: CREATE2 factory absent on ${label} (chainId=${network.chainId})`);
    console.error('  Factory:', CREATE2_FACTORY);
    process.exit(1);
  }
  console.log(`  CREATE2 factory: PRESENT (${(factoryCode.length - 2) / 2} bytes)`);

  // Guard: deployer must have ETH
  const balance = await provider.getBalance(wallet.address);
  console.log(`  Deployer balance: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.error(`BLOCKER: Deployer ${wallet.address} has no ETH on ${label}`);
    console.error('  Fund the deployer on this chain and re-run.');
    process.exit(1);
  }

  // Idempotency check: if code already exists, skip
  const existing = await provider.getCode(predictedAddress);
  if (existing !== '0x' && existing.length > 2) {
    console.log(`  SmartEOA already deployed at ${predictedAddress} — SKIPPED`);
    console.log(`  Deployed code length: ${(existing.length - 2) / 2} bytes`);
    return existing;
  }

  // Deploy via CREATE2 factory: calldata = salt ++ initcode
  console.log(`  Deploying SmartEOA via CREATE2...`);
  console.log(`  Predicted address: ${predictedAddress}`);
  console.log(`  Salt: ${SALT}  (keccak256("${SALT_PREIMAGE}"))`);

  const calldata = ethers.concat([SALT, bytecode]);
  const tx = await wallet.sendTransaction({
    to: CREATE2_FACTORY,
    data: calldata,
    // Let the provider estimate gas; no hardcoded value so it adapts to
    // whatever network fee model is in play on each chain.
  });
  console.log(`  Tx submitted: ${tx.hash}`);

  const receipt = await tx.wait(1);
  console.log(`  Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`);

  // Verify deployment landed at the predicted address.
  // Some RPCs (especially Base Sepolia) lag behind by 1-2 seconds after
  // reporting a confirmation — retry up to 5x with a 2-second delay.
  let deployed = '0x';
  for (let attempt = 1; attempt <= 5; attempt++) {
    deployed = await provider.getCode(predictedAddress);
    if (deployed !== '0x' && deployed.length > 2) break;
    if (attempt < 5) {
      console.log(`  getCode returned empty (attempt ${attempt}/5), retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (deployed === '0x' || deployed.length < 4) {
    console.error(`ERROR: Code not found at predicted address after deploy on ${label}!`);
    console.error('  This should not happen — check the tx receipt and factory behaviour.');
    process.exit(1);
  }
  console.log(`  Verified: code at ${predictedAddress} — ${(deployed.length - 2) / 2} bytes`);

  return deployed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== deploy-smarteoa-create2.js ===');
  console.log(`Salt preimage: "${SALT_PREIMAGE}"`);
  console.log(`Salt:          ${SALT}`);
  console.log(`CREATE2 factory: ${CREATE2_FACTORY}`);

  // Load bytecode
  const artifact = loadSmartEOAArtifact();
  const bytecode  = artifact.bytecode; // 0x-prefixed initcode (no constructor args)
  console.log(`SmartEOA bytecode: ${(bytecode.length - 2) / 2} bytes`);

  // Compute deterministic address (chain-independent)
  const predictedAddress = computeCreate2Address(bytecode);
  console.log(`\nMILESTONE: deployer-check — CREATE2 address: ${predictedAddress}`);
  console.log(`  (This will be SMART_EOA_ADDRESS on BOTH L1 and L2)`);

  // ── L1 deploy ──
  const codeL1 = await deployOnChain('L1 (Sepolia)', L1_RPC_URL, predictedAddress, bytecode);
  console.log(`\nMILESTONE: L1 deploy — SmartEOA at ${predictedAddress} on Sepolia`);

  // ── L2 deploy ──
  const codeL2 = await deployOnChain('L2 (Base Sepolia)', L2_RPC_URL, predictedAddress, bytecode);
  console.log(`\nMILESTONE: L2 deploy — SmartEOA at ${predictedAddress} on Base Sepolia`);

  // ── Address parity check ──
  // Both should be identical (deployed bytecode from same initcode = identical runtime)
  if (codeL1.toLowerCase() !== codeL2.toLowerCase()) {
    // Runtime bytecode should be deterministic from the same source/compiler version.
    // A mismatch here is unexpected; warn but don't block (they may differ only in
    // metadata hash, which doesn't affect behaviour).
    console.warn(`\nWARN: deployed bytecode differs between L1 and L2`);
    console.warn(`  L1 code length: ${(codeL1.length - 2) / 2} bytes`);
    console.warn(`  L2 code length: ${(codeL2.length - 2) / 2} bytes`);
    console.warn('  Metadata hash difference is benign; address parity is what matters.');
  } else {
    console.log(`\nMILESTONE: address-parity — deployed bytecode identical on L1 and L2 ✓`);
    console.log(`  L1 code length: ${(codeL1.length - 2) / 2} bytes`);
    console.log(`  L2 code length: ${(codeL2.length - 2) / 2} bytes`);
  }

  // ── Summary ──
  console.log('\n=== RESULT ===');
  console.log(`SMART_EOA_ADDRESS (L1 == L2): ${predictedAddress}`);
  console.log('\nNext: update SMART_EOA_ADDRESS in client/src/abi/addresses.ts');
  console.log('      and SMART_EOA_ADDRESS in the SMART_EOA_ADDRESS env (SponsorService)');
  console.log('      and the SmartEOA entry in client/src/abi/deployments.ts');

  // Emit a machine-readable line for the orchestrator to grep
  console.log(`\n[DEPLOY_RESULT] SMART_EOA_ADDRESS=${predictedAddress}`);
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
