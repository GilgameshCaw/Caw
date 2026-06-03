#!/usr/bin/env node
/**
 * check-storage-layout.js
 *
 * Generates or asserts storage-layout goldens for the critical V2 contracts.
 * Usage:
 *   node scripts/check-storage-layout.js [--generate] <ContractName>
 *
 * Called by the foundry test StorageLayoutSnapshot.t.sol via vm.ffi.
 * Exit code 0 = pass / golden generated.
 * Exit code 1 = mismatch (prints diff).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SOLIDITY_DIR = path.resolve(__dirname, '..');
const GOLDEN_DIR = path.join(SOLIDITY_DIR, 'test-foundry', 'golden');

const CONTRACTS = [
  'CawProfile',
  'CawProfileLedger',
  'CawActions',
  'CawActionsArchive',
  'CawProfileMarketplace',
  'CawCapOracle',
  'CawNetworkManager',
  'CawChallengeRelay',
];

/**
 * Strip AST node IDs embedded in struct/enum type strings so goldens are
 * stable across recompilations. Example:
 *   "t_struct(CawNetwork)457_storage" → "t_struct(CawNetwork)_storage"
 *   "t_mapping(t_uint32,t_struct(CawNetwork)457_storage)" → normalised recursively
 */
function normaliseType(t) {
  // Replace )NNN_ (AST ID embedded between closing paren and underscore) with )_
  return t.replace(/\)(\d+)_/g, ')_');
}

function getStorageLayout(contractName) {
  const raw = execSync(
    `forge inspect ${contractName} storageLayout --json`,
    { cwd: SOLIDITY_DIR }
  ).toString().trim();
  const parsed = JSON.parse(raw);
  // Normalise: only keep label, slot, offset, type for each slot.
  // Omit astId (changes between compilations without semantic change).
  // Strip embedded AST IDs from type strings (t_struct(X)NNN_storage -> t_struct(X)_storage).
  // Sort by (slot, offset) to be deterministic.
  const normalised = (parsed.storage || []).map(s => ({
    label: s.label,
    slot: s.slot,
    offset: s.offset,
    type: normaliseType(s.type),
  }));
  normalised.sort((a, b) => {
    const slotDiff = Number(a.slot) - Number(b.slot);
    if (slotDiff !== 0) return slotDiff;
    return a.offset - b.offset;
  });
  return JSON.stringify(normalised, null, 2);
}

function goldenPath(contractName) {
  return path.join(GOLDEN_DIR, `storage-layout-${contractName}.json`);
}

function run() {
  const args = process.argv.slice(2);
  const generateMode = args.includes('--generate');
  // --check-all: assert all contracts (same as passing no contract names without --generate)
  const checkAll = args.includes('--check-all');
  const targets = args.filter(a => !a.startsWith('--'));

  const list = (checkAll || targets.length === 0) ? CONTRACTS : targets;

  let anyMismatch = false;

  for (const name of list) {
    if (!CONTRACTS.includes(name)) {
      console.error(`Unknown contract: ${name}`);
      process.exit(1);
    }

    let current;
    try {
      current = getStorageLayout(name);
    } catch (e) {
      console.error(`Failed to inspect ${name}: ${e.message}`);
      process.exit(1);
    }

    const gp = goldenPath(name);

    if (generateMode || !fs.existsSync(gp)) {
      fs.mkdirSync(path.dirname(gp), { recursive: true });
      fs.writeFileSync(gp, current + '\n');
      console.log(`GENERATED golden: ${path.relative(SOLIDITY_DIR, gp)}`);
    } else {
      const golden = fs.readFileSync(gp, 'utf8').trim();
      if (current.trim() === golden) {
        console.log(`OK: ${name}`);
      } else {
        // Write to stdout so vm.ffi captures it for the Solidity assert.
        // Also write to stderr for human-readable terminal output.
        const msg = `MISMATCH: ${name}\n--- golden ---\n${golden}\n--- current ---\n${current}`;
        console.log(msg);
        console.error(msg);
        anyMismatch = true;
      }
    }
  }

  if (anyMismatch) {
    process.exit(1);
  }
  process.exit(0);
}

run();
