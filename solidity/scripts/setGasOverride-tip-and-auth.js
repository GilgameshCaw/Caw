/**
 * setGasOverride-tip-and-auth.js
 *
 * One-shot: install setGasOverride bumps for the two LZ selectors whose
 * default 35k baseline starves the piggybacked CawCapOracle.recordSample
 * write, causing executor simulation reverts on L2.
 *
 *   _setNetworkTipTargetSelector  → 120_000
 *   _allowFreeAuthSelector        → 120_000
 *
 * Applied to Uruk (id=1) AND Babylon (id=2). 4 txs total. Each is a single
 * SSTORE on L1 — no LZ fee, no msg.value.
 *
 * setGasOverride is RATCHETING: newAmount must be > current. If a network
 * already has an override at or above 120_000 the script skips that call
 * with a note rather than reverting.
 *
 * Permanent fix lives in CawProfile.sol constructor (baselines bumped to
 * 120k each); this script is the live workaround for the already-deployed
 * V2 testnet.
 *
 * Usage:
 *   node scripts/setGasOverride-tip-and-auth.js
 *   node scripts/setGasOverride-tip-and-auth.js --dry-run
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

const SEPOLIA_RPC = process.env.L1_RPC_URL;
if (!SEPOLIA_RPC) throw new Error('L1_RPC_URL not set in solidity/.env');
const PRIVATE_KEY = (process.env.PRIVATE_KEYS || '').split(',')[0].trim();
if (!PRIVATE_KEY) throw new Error('PRIVATE_KEYS not set in solidity/.env');

const STATE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.deploy-state.json'), 'utf8')
);
const NM_ADDR = STATE.addresses.CawNetworkManager;
if (!NM_ADDR) throw new Error('CawNetworkManager not in deploy state');

// MAX_GAS_OVERRIDE on CawNetworkManager is 100k. The override is ADDITIVE
// on top of CawProfile.gasBaseFor[selector] (currently 35k for both these
// selectors), so the resulting lzReceive budget is 35k + 100k = 135k —
// enough headroom for the oracle piggyback (~30k) + delegatecall (~10k)
// + the body's two SSTOREs (~25k) + safety margin.
const NEW_AMOUNT = 100_000n;

const SELECTORS = [
  {
    name: '_setNetworkTipTargetSelector',
    sig: 'setNetworkTipTarget(uint32,uint256,uint64)',
  },
  {
    name: '_allowFreeAuthSelector',
    sig: 'setAllowFreeAuth(uint32,bool,uint64)',
  },
];
for (const s of SELECTORS) s.bytes4 = ethers.id(s.sig).slice(0, 10);

const NETWORKS = [
  { id: 1, name: 'Uruk' },
  { id: 2, name: 'Babylon' },
];

const NM_ABI = [
  'function setGasOverride(uint32 networkId, bytes4 selector, uint128 newAmount)',
  'function gasOverride(uint32 networkId, bytes4 selector) view returns (uint128)',
  'function getNetworkOwner(uint32 networkId) view returns (address)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const nm = new ethers.Contract(NM_ADDR, NM_ABI, wallet);

  console.log(`Caller:        ${wallet.address}`);
  console.log(`NetworkMgr:    ${NM_ADDR}`);
  console.log(`Dry-run:       ${DRY_RUN}`);
  console.log(`Target amount: ${NEW_AMOUNT}`);
  console.log('');

  for (const net of NETWORKS) {
    const owner = await nm.getNetworkOwner(net.id);
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`Not network owner for id=${net.id} (owner=${owner})`);
    }
    console.log(`── ${net.name} (id=${net.id}) ──`);

    for (const sel of SELECTORS) {
      const current = await nm.gasOverride(net.id, sel.bytes4);
      console.log(`   ${sel.name}  selector=${sel.bytes4}`);
      console.log(`     current override: ${current}`);
      if (current >= NEW_AMOUNT) {
        console.log(`     → already >= ${NEW_AMOUNT}, skipping`);
        continue;
      }
      console.log(`     → setGasOverride(${net.id}, ${sel.bytes4}, ${NEW_AMOUNT})`);
      if (DRY_RUN) {
        console.log('       [dry-run, skipping send]');
        continue;
      }
      const tx = await nm.setGasOverride(net.id, sel.bytes4, NEW_AMOUNT);
      console.log(`       tx: ${tx.hash}`);
      const rcpt = await tx.wait();
      console.log(`       mined in block ${rcpt.blockNumber}, gasUsed=${rcpt.gasUsed}`);
    }
    console.log('');
  }

  console.log('Done. After this, broadcastTipTarget + allowFreeAuth LZ messages will');
  console.log('quote the bumped gas budget and the L2 executor should deliver them.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
