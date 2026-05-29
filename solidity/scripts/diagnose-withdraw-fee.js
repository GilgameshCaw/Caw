/**
 * diagnose-withdraw-fee.js
 *
 * Diagnose why a withdraw revert happened on L2 processActions.
 *
 * Hypothesis: CawProfileL2.gasLimitFor(setWithdrawableSelector, n) =
 * 35_000 + 24_000*n is under-budgeted for the L1-side cold-slot SSTOREs,
 * so the quoted nativeFee from CawActions.withdrawQuote() is less than
 * what the L2 LZ Endpoint actually charges when setWithdrawable broadcasts.
 * The processActions tx pays exactly the quoted fee → endpoint reverts
 * → setWithdrawable reverts → processActions reverts.
 *
 * What this script does:
 *  1. Calls cawActions.withdrawQuote(tokenId, amount, false) — the
 *     "what the validator quotes" number.
 *  2. Re-derives the OptionsBuilder bytes for the same gas budget.
 *  3. Calls the L2 LZ endpoint's `quote()` directly with those options
 *     and the actual setWithdrawable payload — the "what the endpoint
 *     actually charges right now" number.
 *  4. Probes the current LZ endpoint executor fee + DVN fee components
 *     where available.
 *  5. Reports the delta.
 *
 * The user's failed withdraw (TxQueue #43): tokenId=1, amount=8218477 CAW.
 * Pass --tokenId / --amount on the CLI to override.
 *
 * Usage:
 *   node scripts/diagnose-withdraw-fee.js
 *   node scripts/diagnose-withdraw-fee.js --tokenId 1 --amount 8218477
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const TOKEN_ID = Number(argValue('--tokenId', '1'));
const AMOUNT_WHOLE = BigInt(argValue('--amount', '8218477'));
const AMOUNT_WEI = AMOUNT_WHOLE * 10n ** 18n;

const STATE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.deploy-state.json'), 'utf8')
);
const CAW_ACTIONS_L2 = STATE.addresses.CawActions_L2;
const CAW_PROFILE_L2 = STATE.addresses.CawProfileL2_L2;

// Base Sepolia LZ V2 endpoint (matches deploy.js CHAINS.testnetL2.lzEndpoint).
const L2_ENDPOINT = '0x6EDCE65403992e310A62460808c4b910D972f10f';
const L1_EID = 40161; // Sepolia LZ V2 eid

const L2_RPC = process.env.L2_RPC_URL;
if (!L2_RPC) throw new Error('L2_RPC_URL not set');

// Minimal ABIs ---------------------------------------------------------------

const CAW_ACTIONS_ABI = [
  'function withdrawQuote(uint32[] tokenIds, uint256[] amounts, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
];

const CAW_PROFILE_L2_ABI = [
  'function setWithdrawableSelector() view returns (bytes4)',
  'function withdrawQuote(uint32[] tokenIds, uint256[] amounts, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
];

// LayerZero V2 EndpointV2 quote interface
const LZ_ENDPOINT_ABI = [
  'function quote(tuple(uint32 dstEid, bytes32 receiver, bytes message, bytes options, bool payInLzToken) params, address sender) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
];

// OptionsBuilder.addExecutorLzReceiveOption(gas, value=0) format:
//   options := 0x0003 (TYPE_3) || workerId(1)=0x01 (executor)
//              || optionLength(2) || optionType(1)=0x01 (LZ_RECEIVE)
//              || gas(16) || value(16)
// All big-endian.
function buildLzReceiveOption(gas, value = 0n) {
  const buf = Buffer.alloc(2 + 1 + 2 + 1 + 16 + 16);
  let pos = 0;
  // TYPE_3 header
  buf.writeUInt16BE(3, pos); pos += 2;
  // worker id = 1 (executor)
  buf.writeUInt8(1, pos); pos += 1;
  // option length = 1 (type) + 16 (gas) + 16 (value) = 33
  buf.writeUInt16BE(33, pos); pos += 2;
  // option type = 1 (LZ_RECEIVE)
  buf.writeUInt8(1, pos); pos += 1;
  // gas as 16-byte BE
  for (let i = 15; i >= 0; i--) {
    buf[pos + i] = Number((BigInt(gas) >> BigInt((15 - i) * 8)) & 0xffn);
  }
  pos += 16;
  // value as 16-byte BE
  for (let i = 15; i >= 0; i--) {
    buf[pos + i] = Number((BigInt(value) >> BigInt((15 - i) * 8)) & 0xffn);
  }
  return '0x' + buf.toString('hex');
}

// setWithdrawableSelector matches CawProfileL2.sol:221
const SET_WITHDRAWABLE_SELECTOR = ethers.id('setWithdrawable(uint32[],uint256[])').slice(0, 10);

// CawProfile gasLimitFor formula (CawProfileL2.sol:1248)
function contractGasBudget(n) {
  return 35_000n + 24_000n * BigInt(n);
}

// What CawProfile.sol used to say (foundry test still says this — stale)
function staleGasBudget(n) {
  return 22_000n + 19_000n * BigInt(n);
}

// ---------------------------------------------------------------------------

async function main() {
  const provider = new ethers.JsonRpcProvider(L2_RPC);
  const cawActions = new ethers.Contract(CAW_ACTIONS_L2, CAW_ACTIONS_ABI, provider);
  const cawProfileL2 = new ethers.Contract(CAW_PROFILE_L2, CAW_PROFILE_L2_ABI, provider);
  const endpoint = new ethers.Contract(L2_ENDPOINT, LZ_ENDPOINT_ABI, provider);

  console.log(`L2 chain:        Base Sepolia`);
  console.log(`CawActions_L2:   ${CAW_ACTIONS_L2}`);
  console.log(`CawProfileL2_L2: ${CAW_PROFILE_L2}`);
  console.log(`LZ Endpoint:     ${L2_ENDPOINT}`);
  console.log(`L1 dstEid:       ${L1_EID}`);
  console.log(`Withdraw probe:  tokenId=${TOKEN_ID}, amount=${AMOUNT_WHOLE} CAW (${AMOUNT_WEI} wei)`);
  console.log('');

  // ── Step 1: what the validator quotes ────────────────────────────────────
  let cawActionsQuote;
  try {
    cawActionsQuote = await cawActions.withdrawQuote([TOKEN_ID], [AMOUNT_WEI], false);
  } catch (e) {
    console.error('cawActions.withdrawQuote failed:', e.message);
    process.exit(1);
  }
  console.log(`── 1. Validator's quote ──`);
  console.log(`   cawActions.withdrawQuote → nativeFee = ${cawActionsQuote.nativeFee}`);
  console.log(`                              lzTokenFee = ${cawActionsQuote.lzTokenFee}`);
  console.log('');

  // ── Step 2: derive the OptionsBuilder bytes for the SAME gas budget ──────
  const gasBudgetContract = contractGasBudget(1);
  const optionsContract = buildLzReceiveOption(gasBudgetContract, 0n);
  console.log(`── 2. Gas budget on the wire (n=1) ──`);
  console.log(`   contract formula 35k + 24k*n → ${gasBudgetContract}`);
  console.log(`   stale test formula 22k + 19k*n → ${staleGasBudget(1)}`);
  console.log(`   options bytes (contract):  ${optionsContract}`);
  console.log('');

  // ── Step 3: re-quote the endpoint directly ───────────────────────────────
  const payload = ethers.AbiCoder.defaultAbiCoder()
    .encode(['uint32[]', 'uint256[]'], [[TOKEN_ID], [AMOUNT_WEI]]);
  const fullMessage = ethers.concat([SET_WITHDRAWABLE_SELECTOR, payload]);

  // OApp message structure: the endpoint receives the raw payload as bytes;
  // CawProfileL2._lzSend passes `payload` directly. The OApp base prepends
  // a 1-byte header internally before stamping with the OApp framing — but
  // for the FEE calculation only `options + message length` matter, plus
  // dst/src/receiver. The cleanest approximation is to quote with the same
  // payload bytes we know the on-chain code uses.

  const receiverBytes32 = ethers.zeroPadValue(STATE.addresses.CawProfile, 32);

  try {
    const endpointQuote = await endpoint.quote(
      {
        dstEid: L1_EID,
        receiver: receiverBytes32,
        message: fullMessage,
        options: optionsContract,
        payInLzToken: false,
      },
      CAW_PROFILE_L2
    );
    console.log(`── 3. Endpoint quote (direct probe) ──`);
    console.log(`   endpoint.quote → nativeFee = ${endpointQuote.nativeFee}`);
    console.log(`                    lzTokenFee = ${endpointQuote.lzTokenFee}`);
    console.log('');

    // ── Step 4: compare ───────────────────────────────────────────────────
    console.log(`── 4. Delta analysis ──`);
    const cawQuote = BigInt(cawActionsQuote.nativeFee);
    const endQuote = BigInt(endpointQuote.nativeFee);
    const diff = endQuote - cawQuote;
    const diffPct = cawQuote > 0n ? (diff * 10000n / cawQuote) : 0n;
    console.log(`   cawActions:  ${cawQuote}`);
    console.log(`   endpoint:    ${endQuote}`);
    console.log(`   delta:       ${diff > 0n ? '+' : ''}${diff} wei  (${Number(diffPct) / 100}%)`);
    if (diff > 0n) {
      console.log(`   → endpoint wants MORE than the validator quoted.`);
      console.log(`     This is the bug. The contract formula understates the gas budget,`);
      console.log(`     OR the endpoint pricing changed between quote time and probe time.`);
    } else if (diff < 0n) {
      console.log(`   → endpoint quotes LESS than the validator. No shortfall on this run.`);
      console.log(`     The failed tx must have been time-drift (LZ jitter between quote and send).`);
    } else {
      console.log(`   → match. Same formula, same answer. Original failure was time-drift.`);
    }
  } catch (e) {
    console.error('endpoint.quote failed:', e.message);
    process.exit(1);
  }

  // ── Step 5: probe what the endpoint charges for a HIGHER gas budget ──────
  console.log('');
  console.log(`── 5. What if we bumped the budget? ──`);
  for (const candidate of [50_000n, 75_000n, 100_000n, 150_000n]) {
    const opts = buildLzReceiveOption(candidate, 0n);
    try {
      const q = await endpoint.quote(
        {
          dstEid: L1_EID,
          receiver: receiverBytes32,
          message: fullMessage,
          options: opts,
          payInLzToken: false,
        },
        CAW_PROFILE_L2
      );
      console.log(`   gas=${candidate.toString().padStart(7)}  →  nativeFee=${q.nativeFee}`);
    } catch (e) {
      console.log(`   gas=${candidate.toString().padStart(7)}  →  REVERT (${e.message.slice(0, 60)})`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
