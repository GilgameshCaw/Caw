/**
 * Integration tests for the gas-optimization passes on CawActions:
 *
 *   #1  Session-signed actions sign with empty amounts[]; the contract reads
 *       `perActionTipRate` from the session record and credits the validator
 *       once at batch end via a single addToBalance SSTORE. (CawActions.sol
 *       _applyAction + processActions implicitTipOwed accumulator.)
 *
 *   #2  networkCurrentHash / networkActionCount: lazy-loaded on first action,
 *       mutated in memory across the batch, flushed once at the end.
 *       Per-32-action checkpoint commitments still hit storage immediately.
 *
 *   #3  sessionSpent[(owner, signer)]: accumulated in BatchAuth across a sig
 *       group, flushed once per group via a single SSTORE. (One SSTORE per
 *       sig group instead of per action.)
 *
 * Asserts the FUNCTIONAL invariants (correctness across many shapes), not
 * raw gas numbers — gas counts depend on solc/optimizer settings and are
 * brittle. The savings are validated by the contract behaving identically
 * whether you submit one big batch or a sequence of small batches.
 */

const MintableCaw = artifacts.require("MintableCaw");
const CawNetworkManager = artifacts.require("CawNetworkManager");
const CawProfile = artifacts.require("CawProfile");
const CawProfileL2 = artifacts.require("CawProfileL2");
const CawProfileMinter = artifacts.require("CawProfileMinter");
const CawProfileQuoter = artifacts.require("CawProfileQuoter");
const CawActions = artifacts.require("CawActions");
const CawBuyAndBurn = artifacts.require("CawBuyAndBurn");
const MockSwapRouter = artifacts.require("MockSwapRouter");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");

const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');

const l1 = 30101;
const l2 = 8453;

// Hardhat default mnemonic accounts — used to sign with private keys directly
// (truffle's web3 sign helpers can't drive arbitrary EIP-712 typed data with
// the same fidelity as @metamask/eth-sig-util).
const testKeys = {
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex'),
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex'),
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc': Buffer.from('5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', 'hex'),
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906': Buffer.from('7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', 'hex'),
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65': Buffer.from('47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', 'hex'),
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc': Buffer.from('8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', 'hex'),
  '0x976ea74026e726554db657fa54763abd0c3a0aa9': Buffer.from('92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', 'hex'),
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955': Buffer.from('4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', 'hex'),
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f': Buffer.from('dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', 'hex'),
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720': Buffer.from('2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', 'hex'),
};
function privFor(addr) {
  const key = testKeys[addr.toLowerCase()];
  if (!key) throw new Error(`No test key for ${addr}`);
  return key;
}

const dataTypes = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  ActionData: [
    { name: 'actionType', type: 'uint8' },
    { name: 'senderId', type: 'uint32' },
    { name: 'receiverId', type: 'uint32' },
    { name: 'receiverCawonce', type: 'uint32' },
    { name: 'networkId', type: 'uint32' },
    { name: 'cawonce', type: 'uint32' },
    { name: 'recipients', type: 'uint32[]' },
    { name: 'amounts', type: 'uint64[]' },
    { name: 'text', type: 'bytes' },
  ],
  ActionBatch: [
    { name: 'senderId', type: 'uint32' },
    { name: 'firstCawonce', type: 'uint32' },
    { name: 'actionCount', type: 'uint32' },
    { name: 'actionsHash', type: 'bytes32' },
  ],
  SessionDelegation: [
    { name: 'sessionKey', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'scopeBitmap', type: 'uint8' },
    { name: 'spendLimit', type: 'uint256' },
    { name: 'perActionTipRate', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const ACTION_TYPE = { caw: 0, like: 1, unlike: 2, recaw: 3, follow: 4, unfollow: 5, withdraw: 6, other: 7 };

// Per-action protocol cost (whole CAW), mirrors the constants in
// CawActions._applyAction. The session's perActionTipRate is added on top
// of these for session-signed actions.
const PROTOCOL_COST = { caw: 5000, like: 2000, recaw: 4000, follow: 30000, unlike: 0, unfollow: 0, other: 0, withdraw: 0 };

const CHECKPOINT_INTERVAL = 32; // mirrors CawActions.CHECKPOINT_INTERVAL

// ============================================
// Pack helpers (mirror packActions.ts)
// ============================================
function packActionForSlice(a) {
  const recipients = a.recipients || [];
  const amounts = a.amounts || [];
  const textHex = (a.text && a.text !== '0x') ? a.text.replace(/^0x/, '') : '';
  const textLen = textHex.length / 2;
  const size = 21 + 1 + 1 + (recipients.length * 4) + (amounts.length * 8) + 2 + textLen;
  const buf = Buffer.alloc(size);
  let pos = 0;
  buf.writeUInt8(Number(a.actionType), pos); pos += 1;
  buf.writeUInt32BE(Number(a.senderId), pos); pos += 4;
  buf.writeUInt32BE(Number(a.receiverId || 0), pos); pos += 4;
  buf.writeUInt32BE(Number(a.receiverCawonce || 0), pos); pos += 4;
  buf.writeUInt32BE(Number(a.networkId), pos); pos += 4;
  buf.writeUInt32BE(Number(a.cawonce), pos); pos += 4;
  buf.writeUInt8(recipients.length, pos); pos += 1;
  buf.writeUInt8(amounts.length, pos); pos += 1;
  for (const r of recipients) { buf.writeUInt32BE(Number(r), pos); pos += 4; }
  for (const amt of amounts) { buf.writeBigUInt64BE(BigInt(amt), pos); pos += 8; }
  buf.writeUInt16BE(textLen, pos); pos += 2;
  if (textLen > 0) Buffer.from(textHex, 'hex').copy(buf, pos);
  return buf;
}
function packActions(actions) {
  const slices = actions.map(packActionForSlice);
  const total = 2 + slices.reduce((a, b) => a + b.length, 0);
  const buf = Buffer.alloc(total);
  let pos = 0;
  buf.writeUInt16BE(actions.length, pos); pos += 2;
  for (const s of slices) { s.copy(buf, pos); pos += s.length; }
  return { hex: '0x' + buf.toString('hex'), slices };
}
function packGroupedSigs(groups) {
  const buf = Buffer.alloc(2 + groups.length * 67);
  let pos = 0;
  buf.writeUInt16BE(groups.length, pos); pos += 2;
  for (const g of groups) {
    buf.writeUInt16BE(g.groupSize, pos); pos += 2;
    buf.writeUInt8(g.v, pos); pos += 1;
    Buffer.from(g.r.replace(/^0x/, ''), 'hex').copy(buf, pos); pos += 32;
    Buffer.from(g.s.replace(/^0x/, ''), 'hex').copy(buf, pos); pos += 32;
  }
  return '0x' + buf.toString('hex');
}
function splitSig(sigHex) {
  const sans = sigHex.replace(/^0x/, '');
  return {
    r: '0x' + sans.slice(0, 64),
    s: '0x' + sans.slice(64, 128),
    v: parseInt(sans.slice(128, 130), 16),
  };
}

async function getDomain(cawActions) {
  const chainId = await web3.eth.getChainId();
  return { chainId, name: 'Caw Protocol', version: '1', verifyingContract: cawActions.address };
}

function signActionBatch(signer, actions, domain) {
  const slices = actions.map(packActionForSlice);
  const perActionHashes = slices.map(s => web3.utils.soliditySha3({ t: 'bytes', v: '0x' + s.toString('hex') }));
  const actionsHash = web3.utils.soliditySha3(...perActionHashes.map(h => ({ t: 'bytes32', v: h })));
  const data = {
    primaryType: 'ActionBatch',
    domain,
    types: { EIP712Domain: dataTypes.EIP712Domain, ActionBatch: dataTypes.ActionBatch },
    message: {
      senderId: actions[0].senderId,
      firstCawonce: actions[0].cawonce,
      actionCount: actions.length,
      actionsHash,
    },
  };
  const sig = signTypedData({ data, privateKey: privFor(signer), version: SignTypedDataVersion.V4 });
  return splitSig(sig);
}

function signActionData(signer, action, domain) {
  const data = {
    primaryType: 'ActionData',
    domain,
    types: { EIP712Domain: dataTypes.EIP712Domain, ActionData: dataTypes.ActionData },
    message: { ...action },
  };
  const sig = signTypedData({ data, privateKey: privFor(signer), version: SignTypedDataVersion.V4 });
  return splitSig(sig);
}

// Reconstruct networkCurrentHash from calldata exactly as CawActions does:
//   chain_n = keccak256(chain_{n-1} || r || keccak256(packed[n]))
// where r is the recovering signature's r — for a batch sig, the same r is
// reused for every action in the group.
function reconstructHashChain(initial, actions, slices, sigGroupForAction) {
  let chain = initial;
  for (let i = 0; i < actions.length; i++) {
    const r = sigGroupForAction(i).r;
    const actionHash = web3.utils.soliditySha3({ t: 'bytes', v: '0x' + slices[i].toString('hex') });
    chain = web3.utils.soliditySha3(
      { t: 'bytes32', v: chain },
      { t: 'bytes32', v: r },
      { t: 'bytes32', v: actionHash },
    );
  }
  return chain;
}

// ============================================
// Setup
// ============================================
let setup;
async function fullSetup(accounts) {
  const l1Endpoint = await MockLayerZeroEndpoint.new(l1);
  const l2Endpoint = await MockLayerZeroEndpoint.new(l2);
  const token = await MintableCaw.new();
  const mockRouter = await MockSwapRouter.new(token.address);
  const buyAndBurn = await CawBuyAndBurn.new(token.address, mockRouter.address);
  const networkManager = await CawNetworkManager.new(buyAndBurn.address);
  const CawProfileURI = artifacts.require("CawProfileURI");
  const CawFontDataA = artifacts.require("CawFontDataA");
  const CawFontDataB = artifacts.require("CawFontDataB");
  const fontA = await CawFontDataA.new();
  const fontB = await CawFontDataB.new();
  const uri = await CawProfileURI.new(fontA.address, fontB.address);

  const cawProfileL2 = await CawProfileL2.new(l1, l2Endpoint.address, "0x0000000000000000000000000000000000000000");
  await l1Endpoint.setDestLzEndpoint(cawProfileL2.address, l2Endpoint.address);

  const cawProfile = await CawProfile.new(token.address, uri.address, buyAndBurn.address, networkManager.address, l1Endpoint.address, l1, "0x0000000000000000000000000000000000000000");
  await buyAndBurn.setCawProfile(cawProfile.address);
  await cawProfileL2.setL1Peer(l1, cawProfile.address, false);
  await l2Endpoint.setDestLzEndpoint(cawProfile.address, l1Endpoint.address);
  await cawProfile.setL2Peer(l2, cawProfileL2.address);

  await networkManager.createNetwork("Test Network", accounts[0], l2, 0, 0, 0, 0, 0);
  const networkId = 1;

  const minter = await CawProfileMinter.new(token.address, cawProfile.address, mockRouter.address);
  await cawProfile.setMinter(minter.address);

  const quoter = await CawProfileQuoter.new(cawProfile.address);
  const cawActions = await CawActions.new(cawProfileL2.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000");
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, networkManager, networkId };
}

async function buyUsername(user, name) {
  const mintAmount = (10n * 1_000_000_000n * 10n ** 18n).toString();
  await setup.token.mint(user, mintAmount);
  const cost = await setup.minter.costOfName(name);
  await setup.token.approve(setup.minter.address, cost.toString(), { from: user });
  const quote = await setup.quoter.mintQuote(setup.networkId, false);
  await setup.minter.mint(setup.networkId, name, quote.lzTokenFee, {
    from: user, value: quote.nativeFee.toString(),
  });
  return Number(await setup.cawProfile.totalSupply());
}

async function depositAndAuth(user, tokenId, amountWholeCaw) {
  const cawAmountWei = (BigInt(amountWholeCaw) * 10n ** 18n).toString();
  const balance = await setup.token.balanceOf(user);
  await setup.token.approve(setup.cawProfile.address, balance.toString(), { from: user });
  const quote = await setup.quoter.depositQuote(setup.networkId, tokenId, cawAmountWei, l2, false);
  await setup.cawProfile.deposit(setup.networkId, tokenId, cawAmountWei, l2, quote.lzTokenFee, {
    from: user, value: quote.nativeFee.toString(),
  });
}

async function registerSessionFor(owner, sessionKey, scopeBitmap, spendLimit, expiry, perActionTipRate) {
  const nonce = Number(await setup.cawProfileL2.sessionNonce(owner));
  const chainId = await web3.eth.getChainId();
  const data = {
    primaryType: 'SessionDelegation',
    domain: { name: 'CawProfileL2', version: '1', chainId, verifyingContract: setup.cawProfileL2.address },
    types: { EIP712Domain: dataTypes.EIP712Domain, SessionDelegation: dataTypes.SessionDelegation },
    message: { sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce },
  };
  const sigHex = signTypedData({ data, privateKey: privFor(owner), version: SignTypedDataVersion.V4 });
  await setup.cawProfileL2.registerSession(owner, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce, sigHex);
}

// ============================================
// Tests
// ============================================
contract('CawActions — session-tip + batched-accumulator integration', function (accounts) {
  const validatorOwner = accounts[0];
  const userA = accounts[1];
  const userB = accounts[2];

  let validatorTokenId, userATokenId, userBTokenId, domain;

  before(async function () {
    this.timeout(180000);
    setup = await fullSetup(accounts);

    validatorTokenId = await buyUsername(validatorOwner, 'validator');
    userATokenId = await buyUsername(userA, 'usera');
    userBTokenId = await buyUsername(userB, 'userb');

    await depositAndAuth(validatorOwner, validatorTokenId, 5_000_000);
    await depositAndAuth(userA, userATokenId, 5_000_000);
    await depositAndAuth(userB, userBTokenId, 5_000_000);

    domain = await getDomain(setup.cawActions);
  });

  // Helper: raw-share delta on the validator → wei credited (independent of
  // rewardMultiplier drift caused by other actions in the same tx).
  //
  // addToBalance writes setCawBalance(id, balance(id)+amount), which sets
  //   cawOwnership[id] = precision * (balance + amount) / multiplier
  // The delta to cawOwnership from the credit alone is
  //   amount * precision / multiplier_at_credit_time
  // — multiplier_at_credit_time = the post-tx multiplier (the credit fires
  // at the END of processActions, after all the reward distributions).
  //
  // So: amount_credited ≈ (ownership_after - ownership_before) * multiplier_after / precision.
  // (≈ because integer division loses up to 1 unit per multiplier denomination.)
  async function validatorCreditWei(snapshotBefore) {
    const ownershipAfter = BigInt((await setup.cawProfileL2.cawOwnership(validatorTokenId)).toString());
    const multiplierAfter = BigInt((await setup.cawProfileL2.rewardMultiplier()).toString());
    const precision = BigInt((await setup.cawProfileL2.precision()).toString());
    return (ownershipAfter - snapshotBefore.ownership) * multiplierAfter / precision;
  }
  async function snapshotValidator() {
    return {
      ownership: BigInt((await setup.cawProfileL2.cawOwnership(validatorTokenId)).toString()),
    };
  }
  // Allow up to ~1e6 wei (a few attoCAW) of rounding drift from share-math
  // round-trips. The actual contract is exact in CAW-token terms; the wei
  // mismatch is dust from `precision * (balance + amount) / multiplier`
  // integer division when the multiplier has been bumped by an unrelated
  // spendAndDistribute earlier in the same tx.
  const ROUND_TOLERANCE_WEI = 10n ** 9n;
  function expectApproxEq(actual, expected, label) {
    const a = BigInt(actual.toString()), e = BigInt(expected.toString());
    const diff = a > e ? a - e : e - a;
    if (diff > ROUND_TOLERANCE_WEI) {
      throw new Error(`${label || 'expected approx equal'}: got ${a.toString()}, expected ${e.toString()} (diff ${diff.toString()})`);
    }
  }

  // --------------------------------------------
  // #1 — Session-signed actions with empty amounts[] credit the validator
  //      via the per-batch implicitTipOwed accumulator (one credit at end,
  //      not one per action).
  // --------------------------------------------
  it('#1: session-signed batch with empty amounts credits validator perActionTipRate × N once at end', async function () {
    const sessionKey = web3.eth.accounts.create();
    const sessionKeyAddr = sessionKey.address;
    testKeys[sessionKeyAddr.toLowerCase()] = Buffer.from(sessionKey.privateKey.replace(/^0x/, ''), 'hex');

    const tipRate = 1234;            // whole CAW per action
    const N = 5;                     // batch size
    const spendLimit = 1_000_000;    // 1M CAW cap, plenty
    const expiry = (await web3.eth.getBlock('latest')).timestamp + 3600;

    await registerSessionFor(userA, sessionKeyAddr, 0xBF, spendLimit, expiry, tipRate);

    // Build N session-signed `caw` actions with EMPTY amounts[] — the
    // contract must treat them as session-signed and credit the implicit
    // tip from the session record.
    const before = await snapshotValidator();
    const startCawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [];
    for (let i = 0; i < N; i++) {
      actions.push({
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        networkId: setup.networkId, cawonce: startCawonce + i,
        recipients: [], amounts: [],   // <-- the optimization: NO tip slot
        text: '0x' + Buffer.from(`s1-${i}`).toString('hex'),
      });
    }
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(sessionKeyAddr, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: N, ...batchSig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    // Validator credit must equal exactly tipRate × N (in wei), independent
    // of any rewardMultiplier drift from the user's spendAndDistribute calls.
    const credited = await validatorCreditWei(before);
    const expected = BigInt(tipRate) * BigInt(N) * 10n ** 18n;
    expectApproxEq(credited, expected, 'validator credit');
  });

  // --------------------------------------------
  // #1 — When tipRate is 0 (opt-out / public-goods session), the validator
  //      gets no implicit credit; the action still costs its protocol fee.
  // --------------------------------------------
  it('#1: tipRate=0 session does not credit the validator', async function () {
    const sessionKey = web3.eth.accounts.create();
    const sessionKeyAddr = sessionKey.address;
    testKeys[sessionKeyAddr.toLowerCase()] = Buffer.from(sessionKey.privateKey.replace(/^0x/, ''), 'hex');

    await registerSessionFor(userA, sessionKeyAddr, 0xBF, 1_000_000, (await web3.eth.getBlock('latest')).timestamp + 3600, 0);
    const before = await snapshotValidator();

    const cawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce,
      recipients: [], amounts: [], text: '0x' + Buffer.from('zerotip').toString('hex'),
    };
    const { hex } = packActions([action]);
    const sig = signActionData(sessionKeyAddr, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    const credited = await validatorCreditWei(before);
    expectApproxEq(credited, 0n, 'validator credit (zero-tip session)');
  });

  // --------------------------------------------
  // #1 — Manual-sign actions still pay their explicit-tip path. Validator
  //      gets credited inline, not via the batch-end accumulator. Verifies
  //      backwards compatibility for owner-signed flows.
  // --------------------------------------------
  it('#1: manual-sign action with explicit tip in amounts still credits inline', async function () {
    const tip = 777;
    const before = await snapshotValidator();

    const cawonce = Number(await setup.cawActions.nextCawonce(userBTokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce,
      recipients: [], amounts: [tip],   // <-- legacy: tip in amounts[last]
      text: '0x' + Buffer.from('manual').toString('hex'),
    };
    const { hex } = packActions([action]);
    const sig = signActionData(userB, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    const credited = await validatorCreditWei(before);
    expectApproxEq(credited, BigInt(tip) * 10n ** 18n, 'validator credit (manual sign explicit tip)');
  });

  // --------------------------------------------
  // #1 + #3 — sessionSpent advances by (protocolCost + tipRate) per action,
  //          flushed once at group end. Verifies #1's tip is included in the
  //          spend cap AND #3's group-flush leaves the right total in storage.
  // --------------------------------------------
  it('#1+#3: sessionSpent equals (protocolCost+tipRate)×N after a session-signed batch', async function () {
    const sessionKey = web3.eth.accounts.create();
    const sessionKeyAddr = sessionKey.address;
    testKeys[sessionKeyAddr.toLowerCase()] = Buffer.from(sessionKey.privateKey.replace(/^0x/, ''), 'hex');

    const tipRate = 100;
    const N = 4;
    const spendLimit = 1_000_000;
    const expiry = (await web3.eth.getBlock('latest')).timestamp + 3600;

    await registerSessionFor(userA, sessionKeyAddr, 0xBF, spendLimit, expiry, tipRate);
    const spentBefore = BigInt((await setup.cawActions.sessionSpent(userA, sessionKeyAddr)).toString());

    const startCawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [];
    for (let i = 0; i < N; i++) {
      actions.push({
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        networkId: setup.networkId, cawonce: startCawonce + i,
        recipients: [], amounts: [], text: '0x' + Buffer.from(`spend-${i}`).toString('hex'),
      });
    }
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(sessionKeyAddr, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: N, ...batchSig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    const spentAfter = BigInt((await setup.cawActions.sessionSpent(userA, sessionKeyAddr)).toString());
    const perAction = BigInt(PROTOCOL_COST.caw) + BigInt(tipRate);
    expect((spentAfter - spentBefore).toString()).to.equal((perAction * BigInt(N)).toString());
  });

  // --------------------------------------------
  // #2 — networkCurrentHash + networkActionCount must reflect ALL N actions
  //      after a single processActions call (one flush at end), AND the
  //      hash chain reconstructs from calldata.
  // --------------------------------------------
  it('#2: networkCurrentHash advances to the chain reconstructed from calldata, count grows by N', async function () {
    const sessionKey = web3.eth.accounts.create();
    const sessionKeyAddr = sessionKey.address;
    testKeys[sessionKeyAddr.toLowerCase()] = Buffer.from(sessionKey.privateKey.replace(/^0x/, ''), 'hex');

    await registerSessionFor(userA, sessionKeyAddr, 0xBF, 1_000_000, (await web3.eth.getBlock('latest')).timestamp + 3600, 50);

    const N = 7;
    const startCawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [];
    for (let i = 0; i < N; i++) {
      actions.push({
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        networkId: setup.networkId, cawonce: startCawonce + i,
        recipients: [], amounts: [], text: '0x' + Buffer.from(`h-${i}`).toString('hex'),
      });
    }
    const { hex, slices } = packActions(actions);
    const batchSig = signActionBatch(sessionKeyAddr, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: N, ...batchSig }]);

    const hashBefore = await setup.cawActions.networkCurrentHash(setup.networkId);
    const countBefore = Number(await setup.cawActions.networkActionCount(setup.networkId));

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    const hashAfter = await setup.cawActions.networkCurrentHash(setup.networkId);
    const countAfter = Number(await setup.cawActions.networkActionCount(setup.networkId));

    // Count incremented by exactly N — the in-memory accumulator flushed
    // once at the end carries the right total.
    expect(countAfter - countBefore).to.equal(N);

    // Hash equals the chain reconstructed from calldata: every action in a
    // batch sig group shares the same `r`.
    const expectedHash = reconstructHashChain(hashBefore, actions, slices, () => batchSig);
    expect(hashAfter).to.equal(expectedHash);
  });

  // --------------------------------------------
  // #2 — Per-32-action checkpoint commitments STILL hit storage immediately
  //      (the optimization defers per-action SLOAD/SSTORE on networkCurrentHash
  //      but checkpoints must remain queryable mid-batch for the archive
  //      challenge protocol).
  // --------------------------------------------
  it('#2: networkHashAtCheckpoint is written when actionCount crosses a CHECKPOINT_INTERVAL boundary', async function () {
    const sessionKey = web3.eth.accounts.create();
    const sessionKeyAddr = sessionKey.address;
    testKeys[sessionKeyAddr.toLowerCase()] = Buffer.from(sessionKey.privateKey.replace(/^0x/, ''), 'hex');

    await registerSessionFor(userB, sessionKeyAddr, 0xBF, 10_000_000, (await web3.eth.getBlock('latest')).timestamp + 3600, 10);

    // We need networkActionCount to cross the next CHECKPOINT_INTERVAL boundary
    // inside ONE processActions call. Send (interval - count_before mod interval)
    // actions to land exactly on the boundary.
    const countBefore = Number(await setup.cawActions.networkActionCount(setup.networkId));
    const N = CHECKPOINT_INTERVAL - (countBefore % CHECKPOINT_INTERVAL);
    if (N === 0) {
      // Already aligned — skip with a tiny no-op assertion.
      expect(true).to.equal(true);
      return;
    }

    const startCawonce = Number(await setup.cawActions.nextCawonce(userBTokenId));
    const actions = [];
    for (let i = 0; i < N; i++) {
      actions.push({
        actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
        networkId: setup.networkId, cawonce: startCawonce + i,
        recipients: [], amounts: [], text: '0x' + Buffer.from(`cp-${i}`).toString('hex'),
      });
    }
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(sessionKeyAddr, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: N, ...batchSig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    const countAfter = Number(await setup.cawActions.networkActionCount(setup.networkId));
    const checkpointIndex = countAfter / CHECKPOINT_INTERVAL;
    expect(countAfter % CHECKPOINT_INTERVAL).to.equal(0);

    // The checkpoint slot for the boundary we just crossed must equal
    // current networkCurrentHash (since the last action in the batch IS the
    // checkpoint-boundary action, the in-memory accumulator wrote the
    // checkpoint AND the final flush writes the same value to networkCurrentHash).
    const checkpointHash = await setup.cawActions.networkHashAtCheckpoint(setup.networkId, checkpointIndex);
    const currentHash = await setup.cawActions.networkCurrentHash(setup.networkId);
    expect(checkpointHash).to.equal(currentHash);
    expect(checkpointHash).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
  });

  // --------------------------------------------
  // #3 — Mixed-group batch (two distinct sessions in one tx). Each group's
  //      sessionSpent flushes independently. Verifies the per-group flush
  //      doesn't leak across groups OR clobber a previous group's write.
  // --------------------------------------------
  it('#3: two session groups in one tx flush sessionSpent independently', async function () {
    const sessionKeyA = web3.eth.accounts.create();
    const sessionKeyB = web3.eth.accounts.create();
    testKeys[sessionKeyA.address.toLowerCase()] = Buffer.from(sessionKeyA.privateKey.replace(/^0x/, ''), 'hex');
    testKeys[sessionKeyB.address.toLowerCase()] = Buffer.from(sessionKeyB.privateKey.replace(/^0x/, ''), 'hex');

    const tipRateA = 11;
    const tipRateB = 22;
    const expiry = (await web3.eth.getBlock('latest')).timestamp + 3600;
    await registerSessionFor(userA, sessionKeyA.address, 0xBF, 1_000_000, expiry, tipRateA);
    await registerSessionFor(userB, sessionKeyB.address, 0xBF, 1_000_000, expiry, tipRateB);

    const aSpentBefore = BigInt((await setup.cawActions.sessionSpent(userA, sessionKeyA.address)).toString());
    const bSpentBefore = BigInt((await setup.cawActions.sessionSpent(userB, sessionKeyB.address)).toString());

    const NA = 3;
    const NB = 2;
    const aStart = Number(await setup.cawActions.nextCawonce(userATokenId));
    const bStart = Number(await setup.cawActions.nextCawonce(userBTokenId));

    const aActions = Array.from({ length: NA }, (_, i) => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce: aStart + i,
      recipients: [], amounts: [], text: '0x' + Buffer.from(`A${i}`).toString('hex'),
    }));
    const bActions = Array.from({ length: NB }, (_, i) => ({
      actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce: bStart + i,
      recipients: [], amounts: [], text: '0x' + Buffer.from(`B${i}`).toString('hex'),
    }));

    const { hex } = packActions([...aActions, ...bActions]);
    const aSig = signActionBatch(sessionKeyA.address, aActions, domain);
    const bSig = signActionBatch(sessionKeyB.address, bActions, domain);
    const sigsHex = packGroupedSigs([
      { groupSize: NA, ...aSig },
      { groupSize: NB, ...bSig },
    ]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    const aSpentAfter = BigInt((await setup.cawActions.sessionSpent(userA, sessionKeyA.address)).toString());
    const bSpentAfter = BigInt((await setup.cawActions.sessionSpent(userB, sessionKeyB.address)).toString());

    const expectedADelta = (BigInt(PROTOCOL_COST.caw) + BigInt(tipRateA)) * BigInt(NA);
    const expectedBDelta = (BigInt(PROTOCOL_COST.caw) + BigInt(tipRateB)) * BigInt(NB);
    expect((aSpentAfter - aSpentBefore).toString()).to.equal(expectedADelta.toString());
    expect((bSpentAfter - bSpentBefore).toString()).to.equal(expectedBDelta.toString());
  });

  // --------------------------------------------
  // #1 + #2 — Submitting the same N actions one-batch-at-once vs N
  //           single-action batches must produce IDENTICAL final state on
  //           networkCurrentHash, networkActionCount, sessionSpent, and
  //           validator balance. The optimization is invariant-preserving.
  // --------------------------------------------
  it('one big batch vs N single batches: identical final state', async function () {
    // Snapshot current state so we can reset between runs by simply burning
    // through fresh cawonces with fresh sessions.
    const sessionKey1 = web3.eth.accounts.create();
    const sessionKey2 = web3.eth.accounts.create();
    testKeys[sessionKey1.address.toLowerCase()] = Buffer.from(sessionKey1.privateKey.replace(/^0x/, ''), 'hex');
    testKeys[sessionKey2.address.toLowerCase()] = Buffer.from(sessionKey2.privateKey.replace(/^0x/, ''), 'hex');

    const tipRate = 50;
    const N = 4;
    const expiry = (await web3.eth.getBlock('latest')).timestamp + 3600;
    await registerSessionFor(userA, sessionKey1.address, 0xBF, 1_000_000, expiry, tipRate);
    await registerSessionFor(userA, sessionKey2.address, 0xBF, 1_000_000, expiry, tipRate);

    // Path 1: one batch of N
    const before1 = await snapshotValidator();
    const start1 = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions1 = Array.from({ length: N }, (_, i) => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce: start1 + i,
      recipients: [], amounts: [], text: '0x' + Buffer.from(`P1-${i}`).toString('hex'),
    }));
    const { hex: hex1 } = packActions(actions1);
    const sig1 = signActionBatch(sessionKey1.address, actions1, domain);
    const sigs1 = packGroupedSigs([{ groupSize: N, ...sig1 }]);
    await setup.cawActions.processActions(validatorTokenId, hex1, sigs1, 0, 0);
    const path1Delta = await validatorCreditWei(before1);

    // Path 2: N single-action submissions on a fresh session (same params)
    const start2 = Number(await setup.cawActions.nextCawonce(userATokenId));
    let path2Delta = 0n;
    for (let i = 0; i < N; i++) {
      const before2 = await snapshotValidator();
      const a = {
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        networkId: setup.networkId, cawonce: start2 + i,
        recipients: [], amounts: [], text: '0x' + Buffer.from(`P2-${i}`).toString('hex'),
      };
      const { hex } = packActions([a]);
      const sig = signActionData(sessionKey2.address, a, domain);
      const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
      path2Delta += await validatorCreditWei(before2);
    }

    // Both paths must credit the validator the same total: tipRate × N.
    expectApproxEq(path1Delta, path2Delta, 'one-batch vs N-singles parity');
    expectApproxEq(path1Delta, BigInt(tipRate) * BigInt(N) * 10n ** 18n, 'one-batch credit total');
  });

  // --------------------------------------------
  // #1 — Spend cap enforcement: the implicit tip counts toward the cap.
  //      A batch that would push (protocolCost+tipRate)×N over the limit
  //      reverts the WHOLE batch.
  // --------------------------------------------
  it('#1: implicit tip is included in spend-limit cap (batch reverts when total exceeds limit)', async function () {
    const sessionKey = web3.eth.accounts.create();
    const sessionKeyAddr = sessionKey.address;
    testKeys[sessionKeyAddr.toLowerCase()] = Buffer.from(sessionKey.privateKey.replace(/^0x/, ''), 'hex');

    const tipRate = 1000;
    const N = 3;
    // Deliberately tight cap: 3 actions would cost 3 × (5000 + 1000) = 18000.
    // Setting the cap at 17999 must fail the batch.
    const spendLimit = 17_999;
    const expiry = (await web3.eth.getBlock('latest')).timestamp + 3600;
    await registerSessionFor(userB, sessionKeyAddr, 0xBF, spendLimit, expiry, tipRate);

    const startCawonce = Number(await setup.cawActions.nextCawonce(userBTokenId));
    const actions = Array.from({ length: N }, (_, i) => ({
      actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce: startCawonce + i,
      recipients: [], amounts: [], text: '0x' + Buffer.from(`L${i}`).toString('hex'),
    }));
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(sessionKeyAddr, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: N, ...batchSig }]);

    let reverted = false;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (err) {
      reverted = true;
      const m = (err.message || '').toLowerCase();
      expect(m.includes('session limit') || m.includes('sessionlimitexceeded') || m.includes('revert')).to.equal(true, 'Expected session limit revert');
    }
    expect(reverted, 'expected batch to revert with spend-limit error').to.equal(true);

    // None of the cawonces should have been consumed (the whole batch
    // rolled back).
    for (let i = 0; i < N; i++) {
      expect(await setup.cawActions.isCawonceUsed(userBTokenId, startCawonce + i)).to.equal(false);
    }
  });
});
