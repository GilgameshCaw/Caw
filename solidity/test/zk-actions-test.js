/**
 * Tests for processActionsWithZkSigs — the on-chain ZK-path entry point.
 *
 * What's tested here: the on-chain STATE-APPLICATION path. The cryptographic
 * guarantee (the proof actually verifies the ECDSA signatures) is covered
 * by:
 *   - test/zk-digest-equivalence-test.js (Rust digest math == Solidity)
 *   - solidity/zk/sig-recovery/script/src/bin/main.rs --execute (circuit
 *     correctness inside SP1's zkVM emulator)
 *   - the testnet end-to-end test (#18) (real proof against the canonical
 *     SP1 verifier on Base Sepolia)
 *
 * Here we use a MockSP1Verifier so each test takes seconds, not minutes.
 * The mock has a `setShouldAccept(bool)` toggle so we can also test the
 * reject path.
 *
 * Scenarios covered:
 *   1. Happy path: 3-action batch, all 3 execute, executedBitmap = 0b111,
 *      cawonces consumed, validator credited the implicit tip, hash chain
 *      advances by exactly 3.
 *   2. Verifier reject: setShouldAccept(false), processActionsWithZkSigs
 *      reverts.
 *   3. signers length mismatch: 3 actions but only 2*20 bytes in signers,
 *      reverts cleanly.
 *   4. Skip-don't-revert: pre-consume cawonce K via the sig path. Submit a
 *      3-action ZK batch where action[1] reuses K. Result: actions 0 and 2
 *      execute, action 1 is skipped, executedBitmap = 0b101, validator
 *      credit reflects 2 actions, hash chain advances by 2.
 *   5. Signer mismatch within a batch group: a sig group of size 2 but the
 *      caller supplies different signers[0] vs signers[1]. Reverts with
 *      "Signer mismatch within group".
 *   6. ZK path locked when zkVerifier is unset: deploy CawActions with
 *      address(0) verifier, call processActionsWithZkSigs → reverts with
 *      "ZK path not configured".
 */

const MintableCaw = artifacts.require("MintableCaw");
const CawClientManager = artifacts.require("CawClientManager");
const CawProfile = artifacts.require("CawProfile");
const CawProfileL2 = artifacts.require("CawProfileL2");
const CawProfileMinter = artifacts.require("CawProfileMinter");
const CawProfileQuoter = artifacts.require("CawProfileQuoter");
const CawActions = artifacts.require("CawActions");
const CawBuyAndBurn = artifacts.require("CawBuyAndBurn");
const MockSwapRouter = artifacts.require("MockSwapRouter");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");
const MockSP1Verifier = artifacts.require("MockSP1Verifier");

const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');

const l1 = 30101;
const l2 = 8453;

const testKeys = {
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex'),
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex'),
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc': Buffer.from('5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', 'hex'),
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906': Buffer.from('7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', 'hex'),
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
    { name: 'clientId', type: 'uint32' },
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
};

const ACTION_TYPE = { caw: 0, like: 1, recaw: 3, follow: 4, withdraw: 6, other: 7 };

// ============================================================================
// Pack helpers (same as batched-actions-test)
// ============================================================================
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
  buf.writeUInt32BE(Number(a.clientId), pos); pos += 4;
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

// Pack the verified signers array — concatenated 20-byte addresses, one per
// action, in batch order.
function packSigners(addrs) {
  const buf = Buffer.alloc(addrs.length * 20);
  for (let i = 0; i < addrs.length; i++) {
    Buffer.from(addrs[i].replace(/^0x/, ''), 'hex').copy(buf, i * 20);
  }
  return '0x' + buf.toString('hex');
}

// ============================================================================
// Setup
// ============================================================================
let setup;
async function fullSetup(accounts) {
  const l1Endpoint = await MockLayerZeroEndpoint.new(l1);
  const l2Endpoint = await MockLayerZeroEndpoint.new(l2);
  const token = await MintableCaw.new();
  const mockRouter = await MockSwapRouter.new(token.address);
  const buyAndBurn = await CawBuyAndBurn.new(token.address, mockRouter.address);
  const clientManager = await CawClientManager.new(buyAndBurn.address);
  const CawProfileURI = artifacts.require("CawProfileURI");
  const CawFontDataA = artifacts.require("CawFontDataA");
  const CawFontDataB = artifacts.require("CawFontDataB");
  const fontA = await CawFontDataA.new();
  const fontB = await CawFontDataB.new();
  const uri = await CawProfileURI.new(fontA.address, fontB.address);

  const cawProfileL2 = await CawProfileL2.new(l1, l2Endpoint.address);
  await l1Endpoint.setDestLzEndpoint(cawProfileL2.address, l2Endpoint.address);

  const cawProfile = await CawProfile.new(token.address, uri.address, buyAndBurn.address, clientManager.address, l1Endpoint.address, l1);
  await buyAndBurn.setCawProfile(cawProfile.address);
  await cawProfileL2.setL1Peer(l1, cawProfile.address, false);
  await l2Endpoint.setDestLzEndpoint(cawProfile.address, l1Endpoint.address);
  await cawProfile.setL2Peer(l2, cawProfileL2.address);

  await clientManager.createClient("Test Client", accounts[0], l2, 0, 0, 0, 0);
  const clientId = 1;
  const minter = await CawProfileMinter.new(token.address, cawProfile.address, mockRouter.address);
  await cawProfile.setMinter(minter.address);
  const quoter = await CawProfileQuoter.new(cawProfile.address);

  // Deploy mock verifier and a CawActions wired to it. The vkey value is
  // arbitrary in tests — the mock ignores it.
  const mockVerifier = await MockSP1Verifier.new();
  const dummyVKey = "0x" + "11".repeat(32);
  const cawActions = await CawActions.new(cawProfileL2.address, mockVerifier.address, dummyVKey);
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, clientManager, clientId, mockVerifier };
}

async function buyUsername(user, name) {
  const mintAmount = (10n * 1_000_000_000n * 10n ** 18n).toString();
  await setup.token.mint(user, mintAmount);
  const cost = await setup.minter.costOfName(name);
  await setup.token.approve(setup.minter.address, cost.toString(), { from: user });
  const quote = await setup.quoter.mintQuote(setup.clientId, false);
  await setup.minter.mint(setup.clientId, name, quote.lzTokenFee, {
    from: user, value: quote.nativeFee.toString(),
  });
  return Number(await setup.cawProfile.totalSupply());
}

async function depositAndAuth(user, tokenId, amountWholeCaw) {
  const cawAmountWei = (BigInt(amountWholeCaw) * 10n ** 18n).toString();
  const balance = await setup.token.balanceOf(user);
  await setup.token.approve(setup.cawProfile.address, balance.toString(), { from: user });
  const quote = await setup.quoter.depositQuote(setup.clientId, tokenId, cawAmountWei, l2, false);
  await setup.cawProfile.deposit(setup.clientId, tokenId, cawAmountWei, l2, quote.lzTokenFee, {
    from: user, value: quote.nativeFee.toString(),
  });
}

async function registerSessionFor(owner, sessionKey, scopeBitmap, spendLimit, expiry, perActionTipRate = 0) {
  const nonce = Number(await setup.cawProfileL2.sessionNonce(owner));
  const chainId = await web3.eth.getChainId();
  const data = {
    primaryType: 'SessionDelegation',
    domain: { name: 'CawProfileL2', version: '1', chainId, verifyingContract: setup.cawProfileL2.address },
    types: {
      EIP712Domain: dataTypes.EIP712Domain,
      SessionDelegation: [
        { name: 'sessionKey', type: 'address' },
        { name: 'expiry', type: 'uint64' },
        { name: 'scopeBitmap', type: 'uint8' },
        { name: 'spendLimit', type: 'uint256' },
        { name: 'perActionTipRate', type: 'uint64' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: { sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce },
  };
  const sigHex = signTypedData({ data, privateKey: privFor(owner), version: SignTypedDataVersion.V4 });
  const { v, r, s } = splitSig(sigHex);
  await setup.cawProfileL2.registerSession(sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce, v, r, s);
}

// ============================================================================
// Tests
// ============================================================================
contract('CawActions — processActionsWithZkSigs', function (accounts) {
  const validatorOwner = accounts[0];
  const userA = accounts[1];
  const userB = accounts[2];
  const sessionKeyEoa = accounts[3];

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

  // --------------------------------------------
  // 1. Happy path — 3-action batch all execute
  // --------------------------------------------
  it('happy path: 3-action ZK batch executes all, hash chain advances by 3', async function () {
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [0, 1, 2].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start + i,
      recipients: [], amounts: [0],   // owner-signed, explicit tip
      text: '0x' + Buffer.from(`zk${i}`).toString('hex'),
    }));
    const { hex } = packActions(actions);
    // Three single-sig groups (one per action), all signed by userA.
    const sigs = actions.map(a => signActionData(userA, a, domain));
    const sigsHex = packGroupedSigs(sigs.map(s => ({ groupSize: 1, ...s })));
    // For the ZK path, the verifier is mocked. signers[i] = userA in lowercase.
    const signersHex = packSigners([userA, userA, userA]);
    const dummyProof = "0x" + "ab".repeat(32);

    const countBefore = Number(await setup.cawActions.clientActionCount(setup.clientId));

    await setup.cawActions.processActionsWithZkSigs(
      validatorTokenId, hex, sigsHex, signersHex, dummyProof, 0, 0
    );

    for (let i = 0; i < 3; i++) {
      expect(await setup.cawActions.isCawonceUsed(userATokenId, start + i)).to.equal(true);
    }
    const countAfter = Number(await setup.cawActions.clientActionCount(setup.clientId));
    expect(countAfter - countBefore).to.equal(3);
  });

  // --------------------------------------------
  // 2. Verifier rejects → revert
  // --------------------------------------------
  it('reverts when the verifier rejects', async function () {
    await setup.mockVerifier.setShouldAccept(false);
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start,
      recipients: [], amounts: [0], text: '0x',
    };
    const { hex } = packActions([action]);
    const sig = signActionData(userA, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);
    const signersHex = packSigners([userA]);
    const dummyProof = "0x" + "cc".repeat(32);

    let reverted = false;
    try {
      await setup.cawActions.processActionsWithZkSigs(
        validatorTokenId, hex, sigsHex, signersHex, dummyProof, 0, 0
      );
    } catch (err) {
      reverted = true;
      expect((err.message || '').toLowerCase()).to.include('mock verifier: rejected');
    }
    expect(reverted, 'expected revert when verifier rejects').to.equal(true);
    // Cawonce was NOT consumed — full rollback.
    expect(await setup.cawActions.isCawonceUsed(userATokenId, start)).to.equal(false);

    await setup.mockVerifier.setShouldAccept(true); // reset
  });

  // --------------------------------------------
  // 3. signers length mismatch → revert
  // --------------------------------------------
  it('reverts when signers.length != actionCount * 20', async function () {
    const start = Number(await setup.cawActions.nextCawonce(userBTokenId));
    const actions = [0, 1].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start + i,
      recipients: [], amounts: [0], text: '0x',
    }));
    const { hex } = packActions(actions);
    const sigs = actions.map(a => signActionData(userB, a, domain));
    const sigsHex = packGroupedSigs(sigs.map(s => ({ groupSize: 1, ...s })));
    // Only ONE signer for 2 actions — should revert.
    const badSignersHex = packSigners([userB]);
    const dummyProof = "0x" + "ab".repeat(32);

    let reverted = false;
    try {
      await setup.cawActions.processActionsWithZkSigs(
        validatorTokenId, hex, sigsHex, badSignersHex, dummyProof, 0, 0
      );
    } catch (err) {
      reverted = true;
      expect((err.message || '').toLowerCase()).to.include('signers length mismatch');
    }
    expect(reverted, 'expected revert on signers length mismatch').to.equal(true);
  });

  // --------------------------------------------
  // 4. Skip-don't-revert on cawonce conflict
  // --------------------------------------------
  it('skip-don\'t-revert: pre-consumed cawonce mid-batch is skipped, others execute', async function () {
    // First, consume cawonce K via the sig path so it's marked used.
    const start = Number(await setup.cawActions.nextCawonce(userBTokenId));
    const skipMe = start + 1; // the one we'll pre-consume

    const preAction = {
      actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: skipMe,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('pre').toString('hex'),
    };
    const { hex: preHex } = packActions([preAction]);
    const preSig = signActionData(userB, preAction, domain);
    const preSigsHex = packGroupedSigs([{ groupSize: 1, ...preSig }]);
    await setup.cawActions.processActions(validatorTokenId, preHex, preSigsHex, 0, 0);
    expect(await setup.cawActions.isCawonceUsed(userBTokenId, skipMe)).to.equal(true);

    // Now build a 3-action ZK batch. Action 0 uses cawonce `start`, action 1
    // uses `skipMe` (already consumed → must skip), action 2 uses `start+2`.
    const actions = [start, skipMe, start + 2].map(c => ({
      actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: c,
      recipients: [], amounts: [0], text: '0x',
    }));
    const { hex } = packActions(actions);
    const sigs = actions.map(a => signActionData(userB, a, domain));
    const sigsHex = packGroupedSigs(sigs.map(s => ({ groupSize: 1, ...s })));
    const signersHex = packSigners([userB, userB, userB]);
    const dummyProof = "0x" + "ee".repeat(32);

    const countBefore = Number(await setup.cawActions.clientActionCount(setup.clientId));
    const tx = await setup.cawActions.processActionsWithZkSigs(
      validatorTokenId, hex, sigsHex, signersHex, dummyProof, 0, 0
    );

    // Hash chain advanced by exactly 2 (the executed actions), not 3.
    const countAfter = Number(await setup.cawActions.clientActionCount(setup.clientId));
    expect(countAfter - countBefore).to.equal(2);

    // Cawonces 0 and 2 now used; skipMe was already used (still true).
    expect(await setup.cawActions.isCawonceUsed(userBTokenId, start)).to.equal(true);
    expect(await setup.cawActions.isCawonceUsed(userBTokenId, start + 2)).to.equal(true);

    // Event bitmap reports executed slots. Bit 0 = action 0 ran, bit 1 = 0
    // (skipped), bit 2 = action 2 ran. Bitmap is shifted by actionsSeen,
    // which started at 0 here, so bits 0 and 2 set → bitmap == 0b101 == 5.
    const ev = tx.logs.find(l => l.event === 'ActionsProcessedZk');
    expect(ev).to.not.equal(undefined);
    expect(ev.args.actionsExecutedBitmap.toString()).to.equal('5');
    expect(ev.args.actionCount.toString()).to.equal('3');
  });

  // --------------------------------------------
  // 5. Signer mismatch within a batch group → revert
  // --------------------------------------------
  it('reverts when signers within a batch-sig group disagree', async function () {
    // Pretend we have a 2-action batch group from userA, but the prover
    // (or a malicious caller) supplies signers[0]=userA, signers[1]=userB.
    // The contract must catch this — otherwise a malicious prover could
    // smuggle an unauthorized signer onto a batched action.
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [0, 1].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start + i,
      recipients: [], amounts: [0], text: '0x',
    }));
    const { hex } = packActions(actions);

    // One sig group of size 2 (the batch-sig path). The (v,r,s) values are
    // not actually verified by the mock, but the structure must parse.
    const dummySig = signActionData(userA, actions[0], domain); // any well-formed (v,r,s)
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...dummySig }]);

    // Mismatched signers within the group.
    const signersHex = packSigners([userA, userB]);
    const dummyProof = "0x" + "ff".repeat(32);

    let reverted = false;
    try {
      await setup.cawActions.processActionsWithZkSigs(
        validatorTokenId, hex, sigsHex, signersHex, dummyProof, 0, 0
      );
    } catch (err) {
      reverted = true;
      expect((err.message || '').toLowerCase()).to.include('signer mismatch within group');
    }
    expect(reverted, 'expected revert on signer mismatch within group').to.equal(true);
  });

  // --------------------------------------------
  // 6. Verifier-not-configured → ZK path locked
  // --------------------------------------------
  it('reverts "ZK path not configured" when the contract was deployed without a verifier', async function () {
    // Deploy a fresh CawActions with verifier = address(0).
    const tinyEndpoint = await MockLayerZeroEndpoint.new(l2);
    const tinyL2 = await CawProfileL2.new(l1, tinyEndpoint.address);
    const noVerifier = await CawActions.new(
      tinyL2.address,
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );

    const action = {
      actionType: ACTION_TYPE.caw, senderId: 1, receiverId: 0, receiverCawonce: 0,
      clientId: 1, cawonce: 0,
      recipients: [], amounts: [0], text: '0x',
    };
    const { hex } = packActions([action]);
    const sig = signActionData(userA, action, domain); // doesn't matter
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    let reverted = false;
    try {
      await noVerifier.processActionsWithZkSigs(
        1, hex, sigsHex, packSigners([userA]), "0x", 0, 0
      );
    } catch (err) {
      reverted = true;
      expect((err.message || '').toLowerCase()).to.include('zk path not configured');
    }
    expect(reverted, 'expected revert when verifier address is zero').to.equal(true);
  });

  // --------------------------------------------
  // 7. Regression: skipped WITHDRAW must NOT trigger setWithdrawable on L1.
  //
  // Race scenario:
  //   - User signs a WITHDRAW action at cawonce K.
  //   - Validator A submits via the sig path, succeeds. L2 debits 100 CAW;
  //     L1 sets 100 CAW withdrawable.
  //   - Validator B submits via the ZK path. Their proof was generated
  //     before A's sig-path tx landed, so the proof commits to including
  //     this WITHDRAW. In-flight, the proof's domainSeparator etc. are
  //     valid; the cawonce check at execution time reveals the conflict.
  //
  // Bug fixed in this iteration: in the buggy version, B's tx would skip
  // the WITHDRAW (no second L2 debit) but `withdrawBitmap` had been set
  // unconditionally during _trackClientAndWithdraw — so setWithdrawable
  // would fire for the same amount AGAIN, double-crediting on L1.
  //
  // After fix: if a WITHDRAW is skipped, withdrawBitmap stays clear and
  // setWithdrawable is NOT called for that slot. We assert the L2 balance
  // delta is exactly the one debit (sig path) and ZERO on the ZK path.
  // --------------------------------------------
  it('regression: skipped WITHDRAW does not double-credit on L1 (bitmap stays clear)', async function () {
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const cawonceK = start;
    const withdrawAmountWhole = 100; // 100 whole CAW

    const buildAction = (cawonce) => ({
      actionType: ACTION_TYPE.withdraw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce,
      recipients: [], amounts: [withdrawAmountWhole],
      text: '0x',
    });

    // Step 1: sig-path consumes cawonce K with the WITHDRAW.
    const sigAction = buildAction(cawonceK);
    const sig = signActionData(userA, sigAction, domain);
    const { hex: sigHex } = packActions([sigAction]);
    const sigSigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);
    await setup.cawActions.processActions(validatorTokenId, sigHex, sigSigsHex, 0, 0);
    expect(await setup.cawActions.isCawonceUsed(userATokenId, cawonceK)).to.equal(true);

    // Step 2: ZK path tries to submit a 3-action batch where action[1]
    // reuses cawonce K (the now-conflicted slot). Actions 0 and 2 are CAWs
    // at fresh cawonces. We expect:
    //   - actions 0 and 2 execute
    //   - action 1 (WITHDRAW with conflicted cawonce) is skipped
    //   - executedBitmap == 0b101
    //   - NO additional setWithdrawable / withdraw effect happens on chain
    const action0 = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: cawonceK + 1,
      recipients: [], amounts: [0], text: '0x',
    };
    const action1 = buildAction(cawonceK); // conflict
    const action2 = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: cawonceK + 2,
      recipients: [], amounts: [0], text: '0x',
    };
    const zkActions = [action0, action1, action2];
    const sigs = zkActions.map(a => signActionData(userA, a, domain));
    const sigsHexZk = packGroupedSigs(sigs.map(s => ({ groupSize: 1, ...s })));
    const signersHex = packSigners([userA, userA, userA]);
    const { hex: zkHex } = packActions(zkActions);
    const dummyProof = "0x" + "ab".repeat(32);

    // Step 1's sig-path WITHDRAW for 100 CAW already deposited on L1 via
    // the mock LZ delivery (withdrawFee was zero, so the cross-chain message
    // wasn't actually sent — but for this test we only care about the ZK path
    // attempting to send a SECOND one).
    const withdrawableBefore = BigInt((await setup.cawProfile.withdrawable(userATokenId)).toString());

    // CRITICAL: pass a real withdrawFee so _executeWithdrawals actually fires
    // the LZ message. With withdrawFee=0, _executeWithdrawals is gated out
    // entirely (see line 365 in CawActions.sol) — the bug we're testing for
    // (a polluted withdrawBitmap from a skipped slot) only becomes exploitable
    // when withdrawFee is non-zero, which is the production case.
    const quote = await setup.cawActions.withdrawQuote(
      [userATokenId],
      [BigInt(withdrawAmountWhole) * (10n ** 18n)],
      false
    );

    const tx = await setup.cawActions.processActionsWithZkSigs(
      validatorTokenId, zkHex, sigsHexZk, signersHex, dummyProof, quote.nativeFee, 0,
      { value: quote.nativeFee.toString() }
    );

    // Verify executedBitmap == 0b101 (bit 1 clear → action 1 skipped).
    const evt = tx.logs.find(l => l.event === 'ActionsProcessedZk');
    expect(evt, 'ActionsProcessedZk emitted').to.exist;
    expect(Number(evt.args.actionsExecutedBitmap)).to.equal(0b101);

    // The deciding assertion: L1 `withdrawable[userATokenId]` must NOT have
    // increased. If the buggy version of the ZK path had run, the skipped
    // WITHDRAW's bit would still be set in withdrawBitmap, _handleWithdrawals
    // would have re-invoked setWithdrawable for 100 CAW, and the L1 mapping
    // would be 200 CAW total instead of 100.
    const withdrawableAfter = BigInt((await setup.cawProfile.withdrawable(userATokenId)).toString());
    expect(
      withdrawableAfter.toString(),
      `L1 withdrawable must not increase from a skipped WITHDRAW — ` +
      `before=${withdrawableBefore}, after=${withdrawableAfter}, delta=${withdrawableAfter - withdrawableBefore}`
    ).to.equal(withdrawableBefore.toString());
  });

  // --------------------------------------------
  // 8. Regression: ZK path rejects expired session keys (Issue B from
  //    audit 2026-05-08). The earlier ZK path implementation read the
  //    full session record but never checked `expiry > block.timestamp`,
  //    so an expired session key still authorized actions in the ZK path
  //    even though it would have been rejected by processActions.
  //
  //    Setup:
  //      - Register sessionKeyEoa for userA with expiry just past `now`.
  //      - Use evm_increaseTime to push past expiry.
  //      - Submit a ZK batch signed by sessionKeyEoa.
  //    Expected: revert with "Session expired or not found".
  // --------------------------------------------
  it('regression: rejects expired session key in ZK path', async function () {
    // Register a session that expires in 2 seconds, then jump 1 hour ahead.
    const now = (await web3.eth.getBlock('latest')).timestamp;
    const expiry = now + 2;
    const scopeBitmap = 0xBF; // all action types except WITHDRAW (bit 6)
    const spendLimit = 0;     // unlimited spend
    await registerSessionFor(userA, sessionKeyEoa, scopeBitmap, spendLimit, expiry);

    // Advance time past expiry.
    await new Promise((resolve, reject) => {
      web3.currentProvider.send(
        { jsonrpc: '2.0', method: 'evm_increaseTime', params: [3600], id: 0 },
        (err) => err ? reject(err) : web3.currentProvider.send(
          { jsonrpc: '2.0', method: 'evm_mine', params: [], id: 1 },
          (e2) => e2 ? reject(e2) : resolve()
        )
      );
    });

    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const action = {
      actionType: ACTION_TYPE.like, senderId: userATokenId, receiverId: userBTokenId, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start,
      recipients: [], amounts: [], text: '0x',
    };
    const { hex } = packActions([action]);
    // Session key signs; the proof would commit to that signer.
    const sig = signActionData(sessionKeyEoa, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);
    const signersHex = packSigners([sessionKeyEoa]);
    const dummyProof = "0x" + "ab".repeat(32);

    let reverted = false;
    let reason = '';
    try {
      await setup.cawActions.processActionsWithZkSigs(
        validatorTokenId, hex, sigsHex, signersHex, dummyProof, 0, 0
      );
    } catch (err) {
      reverted = true;
      reason = (err.message || '').toLowerCase();
    }
    expect(reverted, 'expected revert when session is expired').to.equal(true);
    expect(reason).to.include('session expired or not found');
  });
});
