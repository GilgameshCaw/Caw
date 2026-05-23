/**
 * On-chain session register/revoke via OTHER actions (qs: / qx:).
 *
 * The qs:/qx: subtypes piggyback on the OTHER action multiplexer so that
 * registering or revoking a Quick Sign session can be batched alongside
 * any other actions, and the validator gets paid via the same per-action
 * tip flow. Auth is implicit in the action's outer EIP-712 signature:
 * only the wallet owner can register/revoke; a session-key signer cannot
 * (otherwise a compromised session could escalate by registering a new
 * one under its owner's wallet).
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

const truffleAssert = require('truffle-assertions');
const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');

// Custom-error revert helper — see multi-layer-test.js for full explanation.
// 0.8.30 contracts use `revert E()` instead of `require(cond, "msg")`; the
// 4-byte selector surfaces in err.message and we assert on it exactly.
function _errorSelector(sig) { return web3.utils.keccak256(sig).slice(0, 10); }
async function expectRevertWithCustomError(promise, errorSig) {
  const sel = _errorSelector(errorSig);
  let didRevert = false;
  let actualMsg = '';
  try { await promise; } catch (e) { didRevert = true; actualMsg = e.message || String(e); }
  if (!didRevert) throw new Error(`Expected revert with ${errorSig} (${sel}), but call succeeded`);
  if (!actualMsg.toLowerCase().includes(sel.toLowerCase())) {
    throw new Error(`Expected revert with ${errorSig} (${sel}), got: ${actualMsg}`);
  }
}

const l1 = 30101;
const l2 = 8453;

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
};
const ACTION_TYPE = { caw: 0, like: 1, unlike: 2, recaw: 3, follow: 4, unfollow: 5, withdraw: 6, other: 7 };

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

// Build the binary qs: payload that the contract expects.
// Format: 0x71 0x73 0x3a (3) + addr(20) + expiry(8) + spendLimit(32) + tipRate(8) = 71 bytes
function buildQsText(sessionKey, expiry, spendLimit, perActionTipRate) {
  const buf = Buffer.alloc(71);
  buf.write('qs:', 0, 3, 'ascii');
  Buffer.from(sessionKey.replace(/^0x/, '').toLowerCase(), 'hex').copy(buf, 3);
  buf.writeBigUInt64BE(BigInt(expiry), 23);
  // spendLimit is 32 bytes BE
  const slBuf = Buffer.alloc(32);
  let n = BigInt(spendLimit);
  for (let i = 31; i >= 0; i--) { slBuf[i] = Number(n & 0xffn); n >>= 8n; }
  slBuf.copy(buf, 31);
  buf.writeBigUInt64BE(BigInt(perActionTipRate), 63);
  return '0x' + buf.toString('hex');
}
// qx: 3 + 20 = 23 bytes
function buildQxText(sessionKey) {
  const buf = Buffer.alloc(23);
  buf.write('qx:', 0, 3, 'ascii');
  Buffer.from(sessionKey.replace(/^0x/, '').toLowerCase(), 'hex').copy(buf, 3);
  return '0x' + buf.toString('hex');
}

let setup;

async function buyUsername(user, name) {
  const mintAmount = (10n * 1_000_000_000n * 10n ** 18n).toString();
  await setup.token.mint(user, mintAmount);
  const cost = await setup.minter.costOfName(name);
  await setup.token.approve(setup.minter.address, cost.toString(), { from: user });
  const quote = await setup.quoter.mintQuote(setup.networkId, false);
  await setup.minter.mint(setup.networkId, name, quote.lzTokenFee, {
    from: user, value: quote.nativeFee.toString(),
  });
  const totalSupply = await setup.cawProfile.totalSupply();
  return Number(totalSupply);
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

  await networkManager.createNetwork("Test Network", accounts[0], l2, 0, 0, 0, 0);
  const networkId = 1;

  const minter = await CawProfileMinter.new(token.address, cawProfile.address, mockRouter.address, accounts[0]);
  await cawProfile.setMinter(minter.address);
  const quoter = await CawProfileQuoter.new(cawProfile.address);

  const cawActions = await CawActions.new(cawProfileL2.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000");
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, networkManager, networkId };
}

contract('CawActions — qs: / qx: OTHER session register/revoke', function (accounts) {
  const validatorOwner = accounts[0];
  const userA = accounts[1];
  const sessionKeyEoa = accounts[3];
  const otherSessionKey = accounts[4];

  let validatorTokenId;
  let userATokenId;
  let domain;
  // Pull block.timestamp at setup so expiry is always in the chain's future,
  // not the wall-clock's. Long-running hardhat nodes can drift far enough
  // ahead of Date.now() to fail the "expiry > block.timestamp" check.
  let futureExpiry;

  before(async function () {
    this.timeout(180000);
    setup = await fullSetup(accounts);
    validatorTokenId = await buyUsername(validatorOwner, 'validator');
    userATokenId = await buyUsername(userA, 'usera');
    await depositAndAuth(validatorOwner, validatorTokenId, 5_000_000);
    await depositAndAuth(userA, userATokenId, 5_000_000);
    domain = await getDomain(setup.cawActions);
    const latest = await web3.eth.getBlock('latest');
    futureExpiry = Number(latest.timestamp) + 30 * 86400;
  });

  // --------------------------------------------
  // qs: register a session via an OTHER action
  // --------------------------------------------
  it('registers a session for the wallet owner via a qs: OTHER action', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const expiry = futureExpiry;
    const spendLimit = '5000000';
    const tipRate = 1000;
    const text = buildQsText(sessionKeyEoa, expiry, spendLimit, tipRate);

    const action = {
      actionType: ACTION_TYPE.other, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce, recipients: [], amounts: [0], text,
    };
    const { hex } = packActions([action]);
    const sig = signActionData(userA, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    const nonceBefore = Number(await setup.cawProfileL2.sessionNonce(userA));
    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    const session = await setup.cawProfileL2.sessions(userA, sessionKeyEoa);
    expect(Number(session.expiry)).to.equal(expiry);
    expect(Number(session.scopeBitmap)).to.equal(0xBF);
    expect(session.spendLimit.toString()).to.equal(spendLimit);
    expect(Number(session.perActionTipRate)).to.equal(tipRate);

    // Nonce bumps so any in-flight registerSession-by-sig with the same
    // nonce can't replay over this on-chain write.
    expect(Number(await setup.cawProfileL2.sessionNonce(userA))).to.equal(nonceBefore + 1);
  });

  // --------------------------------------------
  // qx: revoke
  // --------------------------------------------
  it('revokes a session via a qx: OTHER action', async function () {
    // First register a fresh one we can revoke (sessionKeyEoa was used above).
    const reg = Number(await setup.cawActions.nextCawonce(userATokenId));
    const regText = buildQsText(otherSessionKey, futureExpiry, '1000000', 0);
    const regAction = {
      actionType: ACTION_TYPE.other, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce: reg, recipients: [], amounts: [0], text: regText,
    };
    const { hex: regHex } = packActions([regAction]);
    const regSig = signActionData(userA, regAction, domain);
    await setup.cawActions.processActions(validatorTokenId, regHex, packGroupedSigs([{ groupSize: 1, ...regSig }]), 0, 0);
    expect(Number((await setup.cawProfileL2.sessions(userA, otherSessionKey)).expiry)).to.equal(futureExpiry);

    // Now revoke it.
    const rv = Number(await setup.cawActions.nextCawonce(userATokenId));
    const rvText = buildQxText(otherSessionKey);
    const rvAction = {
      actionType: ACTION_TYPE.other, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce: rv, recipients: [], amounts: [0], text: rvText,
    };
    const { hex: rvHex } = packActions([rvAction]);
    const rvSig = signActionData(userA, rvAction, domain);
    await setup.cawActions.processActions(validatorTokenId, rvHex, packGroupedSigs([{ groupSize: 1, ...rvSig }]), 0, 0);

    const session = await setup.cawProfileL2.sessions(userA, otherSessionKey);
    expect(Number(session.expiry)).to.equal(0); // deleted
  });

  // --------------------------------------------
  // Session keys cannot register sessions via qs: — but it's a SILENT no-op
  // (not a revert), so one bad session-key user can't tank a whole batch.
  // Round 3 audit fix.
  // --------------------------------------------
  it('silently no-ops qs: when the action is signed by a session key', async function () {
    // First, register a session for userA so we have a session key to
    // attempt the escalation with. Use the on-chain by-sig path so the
    // session is in place before the test action.
    const sessionKey = accounts[5];
    const nonce = Number(await setup.cawProfileL2.sessionNonce(userA));
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
      message: { sessionKey, expiry: futureExpiry, scopeBitmap: 0xBF, spendLimit: '5000000', perActionTipRate: 0, nonce },
    };
    const sigHex = signTypedData({ data, privateKey: privFor(userA), version: SignTypedDataVersion.V4 });
    await setup.cawProfileL2.registerSession(userA, sessionKey, futureExpiry, 0xBF, '5000000', 0, nonce, sigHex);

    // Now try to use that session key to sign a qs: that registers a NEW session.
    const evilSessionKey = accounts[6];
    const cawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const text = buildQsText(evilSessionKey, futureExpiry, '999999', 0);
    const action = {
      actionType: ACTION_TYPE.other, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce, recipients: [], amounts: [0], text,
    };
    const { hex } = packActions([action]);
    // Sign with sessionKey — NOT userA. Since this is single-action signed
    // by a session key, ba.isSessionKey will be true on dispatch.
    const sig = signActionData(sessionKey, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    // Should NOT revert — silently no-ops.
    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    // Cawonce was burned (action consumed) but the evil key was NOT registered.
    expect(await setup.cawActions.isCawonceUsed(userATokenId, cawonce)).to.equal(true);
    expect(Number((await setup.cawProfileL2.sessions(userA, evilSessionKey)).expiry)).to.equal(0);
  });

  // --------------------------------------------
  // Direct call to registerSessionFromActions from non-CawActions reverts
  // --------------------------------------------
  it('rejects direct calls to registerSessionFromActions / revokeSessionFromActions', async function () {
    // Both should revert with NotCa() since msg.sender isn't CawActions.
    await expectRevertWithCustomError(
      setup.cawProfileL2.registerSessionFromActions(userA, sessionKeyEoa, futureExpiry, '1', 0),
      'NotCa()'
    );
    await expectRevertWithCustomError(
      setup.cawProfileL2.revokeSessionFromActions(userA, sessionKeyEoa),
      'NotCa()'
    );
  });

  // --------------------------------------------
  // Batching: register a session in the same batch as a like action,
  // and confirm the validator gets paid for both.
  // --------------------------------------------
  it('batches a qs: alongside a normal like action, validator gets paid via the same flow', async function () {
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const newKey = accounts[7];

    // qs: action carries an explicit 100-whole-CAW tip to the validator,
    // proving the validator-payment path works for OTHER actions.
    const qsAction = {
      actionType: ACTION_TYPE.other, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce: start,
      recipients: [validatorTokenId], amounts: [100],
      text: buildQsText(newKey, futureExpiry, '2000000', 0),
    };
    // Like a post — the like itself implicitly tips the validator. Use a
    // third-party receiver (not the validator) so the validator's balance
    // delta is purely the implicit-tip path, not the receiver path.
    const likeAction = {
      actionType: ACTION_TYPE.like, senderId: userATokenId, receiverId: userATokenId, receiverCawonce: 1,
      networkId: setup.networkId, cawonce: start + 1,
      recipients: [], amounts: [0], text: '0x',
    };
    const validatorBalanceBefore = await setup.cawProfileL2.cawBalanceOf(validatorTokenId);
    const { hex } = packActions([qsAction, likeAction]);
    const sig0 = signActionData(userA, qsAction, domain);
    const sig1 = signActionData(userA, likeAction, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig0 }, { groupSize: 1, ...sig1 }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    // Session key registered.
    expect(Number((await setup.cawProfileL2.sessions(userA, newKey)).expiry)).to.equal(futureExpiry);
    // Validator collected something — exact amounts depend on like math
    // (implicit tip + recipient distribution); the point of this test is
    // that the qs: didn't block validator payment from happening.
    const validatorBalanceAfter = await setup.cawProfileL2.cawBalanceOf(validatorTokenId);
    expect(BigInt(validatorBalanceAfter.toString()) > BigInt(validatorBalanceBefore.toString())).to.equal(true);
    // Both cawonces consumed.
    expect(await setup.cawActions.isCawonceUsed(userATokenId, start)).to.equal(true);
    expect(await setup.cawActions.isCawonceUsed(userATokenId, start + 1)).to.equal(true);
  });

  // --------------------------------------------
  // Malformed qs: text — silent no-op (audit fix 2026-05-08, M-3).
  // The old behavior was `require(t.length == 71)` reverting the whole
  // batch. That's an unacceptable cross-user grief vector: one malicious
  // user could include a malformed qs: action and tank the entire
  // batch's other (unrelated) actions. New behavior: silently skip the
  // session-register, treat the OTHER action as a no-op (which is the
  // off-chain interpretation for unrecognised OTHER subtypes anyway).
  // --------------------------------------------
  it('malformed qs: payload silently no-ops (does not revert)', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    // Truncated payload — only 40 bytes instead of 71.
    const text = '0x' + Buffer.concat([Buffer.from('qs:', 'ascii'), Buffer.alloc(37)]).toString('hex');
    const action = {
      actionType: ACTION_TYPE.other, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce, recipients: [], amounts: [0], text,
    };
    const { hex } = packActions([action]);
    const sig = signActionData(userA, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    // Should NOT revert.
    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    // And the cawonce should be consumed (the OTHER action was processed
    // as a no-op; nothing was registered).
    expect(await setup.cawActions.isCawonceUsed(userATokenId, cawonce)).to.equal(true);
  });

  // --------------------------------------------
  // LZ-delivered bundled path: depositAndRegisterSessionAndUpdateOwners
  // also bumps sessionNonce so a stale registerSession-by-sig payload
  // can't be replayed afterward.
  // --------------------------------------------
  it('mintAndDepositAndQuickSign (LZ): bumps sessionNonce and invalidates a pre-signed registerSession payload', async function () {
    this.timeout(60000);
    // Note: dev network in truffle-config slices private keys to [1..len-1],
    // so only accounts[0..7] are valid signers under this profile. Pick a
    // fresh owner whose nonce we control without colliding with prior tests.
    const newOwner = accounts[2];
    const sessionKeyForBundle = accounts[3];
    const stalePayloadKey = accounts[4];

    // Fund the new owner so they can mint.
    const mintAmount = (10n * 1_000_000_000n * 10n ** 18n).toString();
    await setup.token.mint(newOwner, mintAmount);
    await setup.token.approve(setup.minter.address, mintAmount, { from: newOwner });
    await setup.token.approve(setup.cawProfile.address, mintAmount, { from: newOwner });

    const expiry = futureExpiry;
    const spendLimit = (10n ** 18n * 1_000_000n).toString();
    const staleNonce = Number(await setup.cawProfileL2.sessionNonce(newOwner));

    // (1) User pre-signs a registerSession-by-sig payload. They never submit it.
    const chainId = await web3.eth.getChainId();
    const sigData = {
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
      message: { sessionKey: stalePayloadKey, expiry, scopeBitmap: 0xBF, spendLimit, perActionTipRate: 0, nonce: staleNonce },
    };
    const sigHex = signTypedData({ data: sigData, privateKey: privFor(newOwner), version: SignTypedDataVersion.V4 });

    // (2) Run the L1-bundled mintAndDepositAndQuickSign for a DIFFERENT
    //     session key (delivered via LZ to depositAndRegisterSessionAndUpdateOwners).
    const depositAmount = (10n ** 18n * 100_000n).toString();
    const quote = await setup.quoter.mintAndDepositAndQuickSignQuote(setup.networkId, depositAmount, l2, false, sessionKeyForBundle);
    await setup.minter.mintAndDepositAndQuickSign(
      setup.networkId, 'qsbundle1', depositAmount, l2, 0,
      sessionKeyForBundle, expiry, spendLimit, 0,
      { from: newOwner, value: quote.nativeFee.toString() }
    );

    // The bundle registered the new session AND bumped the nonce.
    expect(Number((await setup.cawProfileL2.sessions(newOwner, sessionKeyForBundle)).expiry)).to.equal(expiry);
    expect(Number(await setup.cawProfileL2.sessionNonce(newOwner))).to.equal(staleNonce + 1);

    // (3) The pre-signed payload now reverts when anyone tries to submit it.
    //     The nonce mismatch triggers the BadNonce() custom error (was the
    //     "Invalid nonce" require-string before the v1-passkey refactor).
    let threw = false;
    try {
      await setup.cawProfileL2.registerSession(newOwner, stalePayloadKey, expiry, 0xBF, spendLimit, 0, staleNonce, sigHex);
    } catch (err) {
      threw = true;
      // 0x4bd574ec = bytes4(keccak256("BadNonce()")) — match either the
      // decoded error name or the raw selector hex.
      expect(err.message).to.match(/BadNonce|Invalid nonce|0x4bd574ec/);
    }
    expect(threw).to.equal(true);

    // The stale session was NOT registered.
    expect(Number((await setup.cawProfileL2.sessions(newOwner, stalePayloadKey)).expiry)).to.equal(0);
  });

  // --------------------------------------------
  // Sanity: an OTHER action with a non-qs/qx prefix is still a no-op
  // --------------------------------------------
  it('passes through OTHER actions whose text does not start with qs:/qx:', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    // Use an existing off-chain prefix — the contract should not touch it.
    const text = '0x' + Buffer.from('tip:42:7', 'ascii').toString('hex');
    const action = {
      actionType: ACTION_TYPE.other, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce, recipients: [], amounts: [0], text,
    };
    const { hex } = packActions([action]);
    const sig = signActionData(userA, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    // No revert; the cawonce is consumed.
    expect(await setup.cawActions.isCawonceUsed(userATokenId, cawonce)).to.equal(true);
  });
});
