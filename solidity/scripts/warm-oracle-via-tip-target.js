/**
 * warm-oracle-via-tip-target.js
 *
 * One-shot: re-broadcast each network's existing tipTargetWei twice. The
 * cross-chain LZ message piggybacks an oracle price sample on the L2 side
 * (see CawProfileLedger._lzReceive piggyback). Two calls per network + the
 * earlier baseline samples should push the CawCapOracle past its MIN_SAMPLES
 * floor and bring it out of dormancy.
 *
 *   networkId 1 (Uruk)    storage chain: L2  (Base Sepolia)
 *   networkId 2 (Babylon) storage chain: L2b (Arbitrum Sepolia)
 *
 * No values change — we read tipTargetWei from chain and write it back. The
 * NetworkManager broadcasts via CawProfile.broadcastTipTarget, which refunds
 * any unused LZ ETH via _refundUnusedLzEth, so any overpayment comes back.
 *
 * Each tx pre-quotes the LZ native fee via CawProfile.lzQuote and pads 20%.
 *
 * Usage:
 *   node scripts/warm-oracle-via-tip-target.js
 *   node scripts/warm-oracle-via-tip-target.js --dry-run
 *
 * Prereqs:
 *   - L1_RPC_URL + PRIVATE_KEYS in solidity/.env (first key = network owner)
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─── Config ────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const SEPOLIA_RPC = process.env.L1_RPC_URL;
if (!SEPOLIA_RPC) throw new Error('L1_RPC_URL not set in solidity/.env');

const PRIVATE_KEY = (process.env.PRIVATE_KEYS || '').split(',')[0].trim();
if (!PRIVATE_KEY) throw new Error('PRIVATE_KEYS not set in solidity/.env');

const STATE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.deploy-state.json'), 'utf8')
);
const NM_ADDR = STATE.addresses.CawNetworkManager;
const CP_ADDR = STATE.addresses.CawProfile;
if (!NM_ADDR || !CP_ADDR) throw new Error('Missing addresses in deploy state');

// L2 endpoint ids (must match deploy CHAINS map)
const L2_EID = 40245;  // Base Sepolia LZ V2 eid
const L2B_EID = 40231; // Arbitrum Sepolia LZ V2 eid

const NETWORKS = [
  { id: 1, name: 'Uruk',    destEid: L2_EID  },
  { id: 2, name: 'Babylon', destEid: L2B_EID },
];

const ROUNDS = 2;
const PAD_NUM = 120n; // +20%
const PAD_DEN = 100n;

// _setNetworkTipTargetSelector — the L2 dispatcher target. Mirrors the
// constant in CawProfile.sol so lzQuote estimates the same gas budget as
// the actual lzSend. (Quoter lookups validated the same selector on the
// V2 redeploy.)
const SET_NETWORK_TIP_TARGET_SIG =
  'setNetworkTipTarget(uint32,uint256,uint64)';
const SET_NETWORK_TIP_TARGET_SELECTOR =
  ethers.id(SET_NETWORK_TIP_TARGET_SIG).slice(0, 10); // bytes4

// ─── ABIs (minimal slices) ─────────────────────────────────────────────────

const NM_ABI = [
  'function setTipTarget(uint32 networkId, uint256 target) payable',
  'function getTipTargetWei(uint32 networkId) view returns (uint256)',
  'function getTipCeilingWei(uint32 networkId) view returns (uint256)',
  'function getNetworkOwner(uint32 networkId) view returns (address)',
];

const CP_ABI = [
  'function lzQuote(uint32 cawNetworkId, bytes4 selector, uint256 n, bytes memory payload, uint32 lzDestId, bool _payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
];

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const nm = new ethers.Contract(NM_ADDR, NM_ABI, wallet);
  const cp = new ethers.Contract(CP_ADDR, CP_ABI, provider);

  console.log(`Caller:        ${wallet.address}`);
  console.log(`NetworkMgr:    ${NM_ADDR}`);
  console.log(`CawProfile:    ${CP_ADDR}`);
  console.log(`Dry-run:       ${DRY_RUN}`);
  console.log('');

  for (const net of NETWORKS) {
    const owner = await nm.getNetworkOwner(net.id);
    const tipTarget = await nm.getTipTargetWei(net.id);
    const tipCeiling = await nm.getTipCeilingWei(net.id);
    console.log(`── ${net.name} (id=${net.id}) ──`);
    console.log(`   owner:       ${owner}`);
    console.log(`   tipTargetWei:  ${tipTarget}`);
    console.log(`   tipCeilingWei: ${tipCeiling}`);
    console.log(`   destEid:       ${net.destEid}`);
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`Not network owner for id=${net.id}`);
    }

    // Quote the LZ native fee for the setNetworkTipTarget selector. n=0
    // because the broadcast has no per-token cost. Payload shape matches
    // CawProfile.broadcastTipTarget's encodeWithSelector.
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint32', 'uint256', 'uint64'],
      [net.id, tipTarget, 1n]
    );
    const quote = await cp.lzQuote(
      net.id,
      SET_NETWORK_TIP_TARGET_SELECTOR,
      0,
      payload,
      net.destEid,
      false
    );
    const native = BigInt(quote.nativeFee);
    const value = (native * PAD_NUM) / PAD_DEN;
    console.log(`   lzNativeFee:  ${native}  (sending ${value} = +20%)`);

    for (let i = 1; i <= ROUNDS; i++) {
      console.log(`   round ${i}/${ROUNDS}: setTipTarget(${net.id}, ${tipTarget})`);
      if (DRY_RUN) {
        console.log('     [dry-run, skipping send]');
        continue;
      }
      const tx = await nm.setTipTarget(net.id, tipTarget, { value });
      console.log(`     tx: ${tx.hash}`);
      const rcpt = await tx.wait();
      console.log(`     mined in block ${rcpt.blockNumber}, gasUsed=${rcpt.gasUsed}`);
    }
    console.log('');
  }

  console.log('Done. Allow a few minutes for LZ delivery to the storage chains,');
  console.log('then check CawCapOracle on each L2 for samplesWritten.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
