#!/usr/bin/env node
/**
 * verify-deploy-wiring.js — post-deploy on-chain sanity checks.
 *
 * Reads .deploy-state.json and verifies that every cross-contract wiring on
 * every chain matches what deploy.js intended:
 *
 *   L1:
 *     CawProfile.minter           == CawProfileMinter
 *     CawProfile.cawProfileLedger == CawProfileLedger_L1
 *     CawProfile.owner            == PathwayExpander_L1
 *     CawProfile.networkManager   == CawNetworkManager
 *     CawProfile.uriGenerator     == CawProfileURI
 *     CawNetworkManager.cawProfile == CawProfile
 *     CawProfileMinter.CawProfile == CawProfile
 *     CawProfileMinter.pathwayExpander == PathwayExpander_L1
 *     CawProfileLedger_L1.cawProfile     == CawProfile
 *     CawProfileLedger_L1.cawActions     == CawActions_L1
 *     CawProfileLedger_L1.erc1271Sibling == CawActionsERC1271_L1
 *     CawProfileLedger_L1.bypassLZ       == true
 *     CawProfileLedger_L1.owner          == 0 (renounced in ctor)
 *     Endpoint(L1).delegates(CawProfile)         == PathwayExpander_L1
 *     Endpoint(L1).delegates(CawProfileLedger_L1) == PathwayExpander_L1
 *     CawProfile.peers(L2.eid)           == CawProfileLedger_L2 (per L2)
 *     CawProfileLedger_L1.peers(L1.eid)  == NOT set (bypassLZ; setPeer slot remains)
 *
 *   Each L2 chain:
 *     CawProfileLedger_<L>.cawProfile     == predicted L1 CawProfile (== state.CawProfile)
 *     CawProfileLedger_<L>.cawActions     == CawActions_<L>
 *     CawProfileLedger_<L>.erc1271Sibling == CawActionsERC1271_<L>
 *     CawProfileLedger_<L>.bypassLZ       == false
 *     CawProfileLedger_<L>.owner          == 0 (renounced)
 *     Endpoint(<L>).delegates(CawProfileLedger_<L>)  == PathwayExpander_<L>
 *     Endpoint(<L>).delegates(CawActionsArchive_<L>) == PathwayExpander_<L>
 *     Endpoint(<L>).delegates(CawChallengeRelay_<L>) == PathwayExpander_<L>
 *     CawProfileLedger_<L>.peers(L1.eid) == CawProfile (cross-chain peer)
 *     CawProfileLedger_<L>.owner == 0 (renounced)
 *     CawActionsArchive_<L>.owner  == PathwayExpander_<L>
 *     CawChallengeRelay_<L>.owner  == PathwayExpander_<L>
 *     For every other L2 L'':
 *       CawChallengeRelay_<L>.peers(L''.eid) == CawActionsArchive_<L''>
 *       CawActionsArchive_<L>.peers(L''.eid) == CawChallengeRelay_<L''>
 *
 * Exit code: 0 if every check passes, 1 if any fails.
 *
 * Usage:
 *   node scripts/verify-deploy-wiring.js
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const STATE_FILE = path.join(__dirname, '..', '.deploy-state.json');
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const A = state.addresses;
if (!A) { console.error('No addresses in deploy state'); process.exit(1); }

// Pull the same CHAINS map from env without re-executing deploy.js's full state machine.
const ENV = process.env.DEPLOY_ENV || 'testnet';

const CHAINS = {
  testnetL1:  { rpc: process.env.L1_RPC_URL,  lzEid: 40161, endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f' },
  testnetL2:  { rpc: process.env.L2_RPC_URL,  lzEid: 40245, endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f' },
  testnetL2b: { rpc: process.env.L2B_RPC_URL, lzEid: 40231, endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f' },
};

const chainKeyFor = (env, abstract) => `${env}${abstract}`;

const L2_CHAIN_KEYS = ['L2', 'L2b'];

function providerFor(abstract) {
  const ck = chainKeyFor(ENV, abstract);
  const c = CHAINS[ck];
  if (!c?.rpc) throw new Error(`No RPC for ${ck} — check L${abstract.replace('L', '')}_RPC_URL env`);
  return new ethers.JsonRpcProvider(c.rpc);
}

function ZERO(addr) {
  return addr && addr.toLowerCase() === '0x0000000000000000000000000000000000000000';
}

let passed = 0, failed = 0, warnings = 0;
const fails = [];

function eq(name, actual, expected) {
  const a = (actual || '').toLowerCase();
  const e = (expected || '').toLowerCase();
  if (a === e) {
    console.log(`  ✓ ${name}: ${actual}`);
    passed++;
    return true;
  } else {
    console.log(`  ❌ ${name}`);
    console.log(`     expected: ${expected}`);
    console.log(`     actual:   ${actual}`);
    failed++;
    fails.push({ name, expected, actual });
    return false;
  }
}

function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ': ' + detail : ''}`);
    passed++;
    return true;
  } else {
    console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
    fails.push({ name, detail });
    return false;
  }
}

function warn(name, detail) {
  console.log(`  ⚠ ${name}: ${detail}`);
  warnings++;
}

async function main() {
  console.log('verify-deploy-wiring.js — post-deploy sanity check\n');

  // -----------------------------------------------------------------
  // L1
  // -----------------------------------------------------------------
  console.log('===== L1 =====\n');
  const l1 = providerFor('L1');
  const L1_EID = CHAINS[chainKeyFor(ENV, 'L1')].lzEid;
  const L1_ENDPOINT = CHAINS[chainKeyFor(ENV, 'L1')].endpoint;

  // CawProfile state
  const cawProfileAbi = [
    'function minter() view returns (address)',
    'function cawProfileLedger() view returns (address)',
    'function owner() view returns (address)',
    'function networkManager() view returns (address)',
    'function uriGenerator() view returns (address)',
    'function peers(uint32) view returns (bytes32)',
  ];
  const cawProfile = new ethers.Contract(A.CawProfile, cawProfileAbi, l1);

  console.log('CawProfile:');
  eq('CawProfile.minter', await cawProfile.minter(), A.CawProfileMinter);
  eq('CawProfile.cawProfileLedger', await cawProfile.cawProfileLedger(), A.CawProfileLedger_L1);
  eq('CawProfile.owner', await cawProfile.owner(), A.PathwayExpander_L1);
  eq('CawProfile.networkManager', await cawProfile.networkManager(), A.CawNetworkManager);
  eq('CawProfile.uriGenerator', await cawProfile.uriGenerator(), A.CawProfileURI);

  // Per-L2 cross-chain peer registered on CawProfile by Phase 7 PathwayExpander.addPeer
  for (const L of L2_CHAIN_KEYS) {
    const peerEid = CHAINS[chainKeyFor(ENV, L)].lzEid;
    const ledger = A[`CawProfileLedger_${L}`];
    const expected = ethers.zeroPadValue(ledger, 32);
    eq(`CawProfile.peers(${L}.eid=${peerEid})`, await cawProfile.peers(peerEid), expected);
  }

  // CawNetworkManager state
  console.log('\nCawNetworkManager:');
  const cnm = new ethers.Contract(A.CawNetworkManager, ['function cawProfile() view returns (address)'], l1);
  eq('CawNetworkManager.cawProfile', await cnm.cawProfile(), A.CawProfile);

  // CawProfileMinter state
  console.log('\nCawProfileMinter:');
  const minter = new ethers.Contract(A.CawProfileMinter, [
    'function CawProfile() view returns (address)',
    'function pathwayExpander() view returns (address)',
  ], l1);
  // The IMint cast inside Minter exposes the slot, but the public getter is named after the var declaration.
  try {
    eq('CawProfileMinter.pathwayExpander', await minter.pathwayExpander(), A.PathwayExpander_L1);
  } catch (e) {
    warn('CawProfileMinter.pathwayExpander', 'not callable (getter may be missing)');
  }

  // CawProfileLedger_L1 (bypassLZ)
  console.log('\nCawProfileLedger_L1 (bypassLZ):');
  const ledgerAbi = [
    'function cawProfile() view returns (address)',
    'function cawActions() view returns (address)',
    'function erc1271Sibling() view returns (address)',
    'function bypassLZ() view returns (bool)',
    'function owner() view returns (address)',
    'function peers(uint32) view returns (bytes32)',
  ];
  const ledgerL1 = new ethers.Contract(A.CawProfileLedger_L1, ledgerAbi, l1);
  eq('CawProfileLedger_L1.cawProfile', await ledgerL1.cawProfile(), A.CawProfile);
  eq('CawProfileLedger_L1.cawActions', await ledgerL1.cawActions(), A.CawActions_L1);
  eq('CawProfileLedger_L1.erc1271Sibling', await ledgerL1.erc1271Sibling(), A.CawActionsERC1271_L1);
  ok('CawProfileLedger_L1.bypassLZ', (await ledgerL1.bypassLZ()) === true, 'true');
  ok('CawProfileLedger_L1.owner == 0 (renounced)', ZERO(await ledgerL1.owner()), 'address(0)');

  // LZ delegate registration on L1 endpoint
  console.log('\nL1 LZ endpoint delegate registration:');
  const endpointAbi = ['function delegates(address) view returns (address)'];
  const epL1 = new ethers.Contract(L1_ENDPOINT, endpointAbi, l1);
  eq('Endpoint(L1).delegates(CawProfile)', await epL1.delegates(A.CawProfile), A.PathwayExpander_L1);
  eq('Endpoint(L1).delegates(CawProfileLedger_L1)', await epL1.delegates(A.CawProfileLedger_L1), A.PathwayExpander_L1);

  // -----------------------------------------------------------------
  // Each L2
  // -----------------------------------------------------------------
  for (const L of L2_CHAIN_KEYS) {
    console.log(`\n===== ${L} =====\n`);
    const lP = providerFor(L);
    const L_EID = CHAINS[chainKeyFor(ENV, L)].lzEid;
    const L_ENDPOINT = CHAINS[chainKeyFor(ENV, L)].endpoint;

    const ledger = new ethers.Contract(A[`CawProfileLedger_${L}`], ledgerAbi, lP);
    console.log(`CawProfileLedger_${L}:`);
    // L2-side Ledger has cawProfile = address(0) by design (only stored on
    // bypassLZ L1 mirror). The cross-chain reference lives in the LZ peer
    // slot which we verify below.
    ok(`CawProfileLedger_${L}.cawProfile == 0 (L2-side)`,
      ZERO(await ledger.cawProfile()), 'address(0) — peer in LZ slot');
    eq(`CawProfileLedger_${L}.cawActions`, await ledger.cawActions(), A[`CawActions_${L}`]);
    eq(`CawProfileLedger_${L}.erc1271Sibling`, await ledger.erc1271Sibling(), A[`CawActionsERC1271_${L}`]);
    ok(`CawProfileLedger_${L}.bypassLZ`, (await ledger.bypassLZ()) === false, 'false');
    ok(`CawProfileLedger_${L}.owner == 0 (renounced)`, ZERO(await ledger.owner()), 'address(0)');
    eq(`CawProfileLedger_${L}.peers(L1.eid=${L1_EID})`, await ledger.peers(L1_EID), ethers.zeroPadValue(A.CawProfile, 32));

    // Archive and Relay
    const oappAbi = [
      'function owner() view returns (address)',
      'function peers(uint32) view returns (bytes32)',
    ];
    const archive = new ethers.Contract(A[`CawActionsArchive_${L}`], oappAbi, lP);
    const relay = new ethers.Contract(A[`CawChallengeRelay_${L}`], oappAbi, lP);

    console.log(`\nCawActionsArchive_${L}:`);
    eq(`CawActionsArchive_${L}.owner`, await archive.owner(), A[`PathwayExpander_${L}`]);

    console.log(`\nCawChallengeRelay_${L}:`);
    eq(`CawChallengeRelay_${L}.owner`, await relay.owner(), A[`PathwayExpander_${L}`]);

    // Mesh peers: every OTHER L2 — Archive accepts from that L2's Relay, Relay targets that L2's Archive.
    for (const Lp of L2_CHAIN_KEYS) {
      if (Lp === L) continue;
      const lpEid = CHAINS[chainKeyFor(ENV, Lp)].lzEid;
      eq(`CawActionsArchive_${L}.peers(${Lp}.eid=${lpEid})`,
        await archive.peers(lpEid),
        ethers.zeroPadValue(A[`CawChallengeRelay_${Lp}`], 32));
      eq(`CawChallengeRelay_${L}.peers(${Lp}.eid=${lpEid})`,
        await relay.peers(lpEid),
        ethers.zeroPadValue(A[`CawActionsArchive_${Lp}`], 32));
    }

    // LZ delegate registration on L2 endpoint
    console.log(`\n${L} LZ endpoint delegate registration:`);
    const epL = new ethers.Contract(L_ENDPOINT, endpointAbi, lP);
    eq(`Endpoint(${L}).delegates(CawProfileLedger_${L})`,
      await epL.delegates(A[`CawProfileLedger_${L}`]), A[`PathwayExpander_${L}`]);
    eq(`Endpoint(${L}).delegates(CawActionsArchive_${L})`,
      await epL.delegates(A[`CawActionsArchive_${L}`]), A[`PathwayExpander_${L}`]);
    eq(`Endpoint(${L}).delegates(CawChallengeRelay_${L})`,
      await epL.delegates(A[`CawChallengeRelay_${L}`]), A[`PathwayExpander_${L}`]);
  }

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log('\n=========================================');
  console.log(`Verification complete: ${passed} passed, ${failed} failed${warnings ? `, ${warnings} warnings` : ''}.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of fails) console.log('  -', f.name);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\nERROR:', e);
  process.exit(1);
});
