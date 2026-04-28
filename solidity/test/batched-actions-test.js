/**
 * Integration tests for batched-action signatures.
 *
 * Verifies that:
 *   - Legacy single-sig groups (groupSize=1) still work end-to-end.
 *   - A batch sig (groupSize>1) authorizes all actions in the group with one
 *     signer recovery.
 *   - Mixed batches (some single, some batch) succeed in one tx.
 *   - The hash chain advances correctly under both flows.
 *   - Mixed-sender batch reverts.
 *   - Cawonce reuse inside a batch reverts.
 *   - Session-key path: batch sig allowed; per-action scope still enforced.
 *   - safeProcessActions rejects a whole group atomically when any action fails.
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

const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');

const l1 = 30101;
const l2 = 8453;

// ============================================
// Test account private keys (hardhat default mnemonic)
// ============================================
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

// ============================================
// EIP-712 domain + types
// ============================================
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

const ACTION_TYPE = { caw: 0, like: 1, unlike: 2, recaw: 3, follow: 4, unfollow: 5, withdraw: 6, other: 7 };

// ============================================
// Packing helpers — must mirror packActions.ts on the frontend
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

// Build the new grouped sigs format from a list of {groupSize, v, r, s}
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
  return {
    chainId,
    name: 'Caw Protocol',
    version: '1',
    verifyingContract: cawActions.address,
  };
}

// Sign a single ActionData (legacy single-sig flow).
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

// Sign one ActionBatch over many actions.
function signActionBatch(signer, actions, domain) {
  // actionsHash = keccak256(packed(action[0]) || packed(action[1]) || ...)
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

// ============================================
// Setup helpers
// ============================================
let setup;

async function buyUsername(user, name) {
  const mintAmount = (10n * 1_000_000_000n * 10n ** 18n).toString();
  await setup.token.mint(user, mintAmount);

  const cost = await setup.minter.costOfName(name);
  await setup.token.approve(setup.minter.address, cost.toString(), { from: user });

  const quote = await setup.quoter.mintQuote(setup.clientId, false);
  await setup.minter.mint(setup.clientId, name, quote.lzTokenFee, {
    from: user,
    value: quote.nativeFee.toString(),
  });

  // Token IDs are sequential — return the latest one created
  const totalSupply = await setup.cawProfile.totalSupply();
  return Number(totalSupply);
}

async function depositAndAuth(user, tokenId, amountWholeCaw) {
  // Deposit on L1, which triggers cross-chain auth + balance arrival on L2.
  // Tests run with the MockLayerZeroEndpoint so the message is delivered
  // synchronously inside the deposit() call.
  const cawAmountWei = (BigInt(amountWholeCaw) * 10n ** 18n).toString();
  const balance = await setup.token.balanceOf(user);
  await setup.token.approve(setup.cawProfile.address, balance.toString(), { from: user });
  const quote = await setup.quoter.depositQuote(setup.clientId, tokenId, cawAmountWei, l2, false);
  await setup.cawProfile.deposit(setup.clientId, tokenId, cawAmountWei, l2, quote.lzTokenFee, {
    from: user,
    value: quote.nativeFee.toString(),
  });
}

async function registerSessionFor(owner, sessionKey, scopeBitmap, spendLimit, expiry) {
  // Build the SessionDelegation EIP-712 payload, sign with the owner's
  // wallet, then call registerSession (anyone can submit).
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
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: { sessionKey, expiry, scopeBitmap, spendLimit, nonce },
  };
  const sigHex = signTypedData({ data, privateKey: privFor(owner), version: SignTypedDataVersion.V4 });
  const { v, r, s } = splitSig(sigHex);
  await setup.cawProfileL2.registerSession(sessionKey, expiry, scopeBitmap, spendLimit, nonce, v, r, s);
}

async function fullSetup(accounts) {
  const l1Endpoint = await MockLayerZeroEndpoint.new(l1);
  const l2Endpoint = await MockLayerZeroEndpoint.new(l2);
  const token = await MintableCaw.new();
  const mockRouter = await MockSwapRouter.new(token.address);
  const buyAndBurn = await CawBuyAndBurn.new(token.address, mockRouter.address);
  const clientManager = await CawClientManager.new(buyAndBurn.address);
  // Use a minimal URI generator (skip fancy SVG to keep deploy fast)
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

  // Create a client. createClient signature is (name, oversight, l2ChainId, mintFee, depositFee, authFee, withdrawFee).
  // Use 0 fees to keep tests focused on action processing, not fees.
  await clientManager.createClient("Test Client", accounts[0], l2, 0, 0, 0, 0);
  const clientId = 1;

  const minter = await CawProfileMinter.new(token.address, cawProfile.address);
  await cawProfile.setMinter(minter.address);

  const quoter = await CawProfileQuoter.new(cawProfile.address);

  const cawActions = await CawActions.new(cawProfileL2.address);
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, clientManager, clientId };
}

// ============================================
// Tests
// ============================================

contract('CawActions — batched signatures', function (accounts) {
  const validatorOwner = accounts[0];
  const userA = accounts[1];
  const userB = accounts[2];
  const sessionKeyEoa = accounts[3];

  let validatorTokenId;
  let userATokenId;
  let userBTokenId;
  let domain;

  before(async function () {
    this.timeout(180000);
    setup = await fullSetup(accounts);

    // Mint usernames: validator (token 1), userA (token 2), userB (token 3)
    validatorTokenId = await buyUsername(validatorOwner, 'validator');
    userATokenId = await buyUsername(userA, 'usera');
    userBTokenId = await buyUsername(userB, 'userb');

    // Deposit funds on L1 — cross-chain message delivers auth + balance to L2
    await depositAndAuth(validatorOwner, validatorTokenId, 5_000_000);
    await depositAndAuth(userA, userATokenId, 5_000_000);
    await depositAndAuth(userB, userBTokenId, 5_000_000);

    domain = await getDomain(setup.cawActions);
  });

  // --------------------------------------------
  // Sanity: legacy single-sig flow still works
  // --------------------------------------------
  it('processes a single action with a group-of-1 sig (backwards compat)', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('hello').toString('hex'),
    };
    const { hex: packedHex } = packActions([action]);
    const sig = signActionData(userA, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    await setup.cawActions.processActions(validatorTokenId, packedHex, sigsHex, 0, 0);

    expect(await setup.cawActions.isCawonceUsed(userATokenId, cawonce)).to.equal(true);
  });

  // --------------------------------------------
  // Batch sig — happy path
  // --------------------------------------------
  it('processes a batch of 5 actions with one ActionBatch sig', async function () {
    const startCawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [];
    for (let i = 0; i < 5; i++) {
      actions.push({
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: startCawonce + i,
        recipients: [], amounts: [0],
        text: '0x' + Buffer.from(`thread chunk ${i}`).toString('hex'),
      });
    }
    const { hex: packedHex } = packActions(actions);
    const batchSig = signActionBatch(userA, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 5, ...batchSig }]);

    const tx = await setup.cawActions.processActions(validatorTokenId, packedHex, sigsHex, 0, 0);
    expect(tx.receipt.status).to.equal(true);

    for (let i = 0; i < 5; i++) {
      expect(await setup.cawActions.isCawonceUsed(userATokenId, startCawonce + i)).to.equal(true);
    }
  });

  // --------------------------------------------
  // Mixed: one batch + one single in the same call
  // --------------------------------------------
  it('mixes a batch group and a single group in one tx', async function () {
    const aStart = Number(await setup.cawActions.nextCawonce(userATokenId));
    const bStart = Number(await setup.cawActions.nextCawonce(userBTokenId));

    const aBatch = [0, 1, 2].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: aStart + i,
      recipients: [], amounts: [0],
      text: '0x' + Buffer.from(`a${i}`).toString('hex'),
    }));
    const bSingle = {
      actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: bStart,
      recipients: [], amounts: [0],
      text: '0x' + Buffer.from('b0').toString('hex'),
    };
    const { hex } = packActions([...aBatch, bSingle]);
    const aSig = signActionBatch(userA, aBatch, domain);
    const bSig = signActionData(userB, bSingle, domain);
    const sigsHex = packGroupedSigs([
      { groupSize: 3, ...aSig },
      { groupSize: 1, ...bSig },
    ]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    expect(await setup.cawActions.isCawonceUsed(userATokenId, aStart)).to.equal(true);
    expect(await setup.cawActions.isCawonceUsed(userATokenId, aStart + 2)).to.equal(true);
    expect(await setup.cawActions.isCawonceUsed(userBTokenId, bStart)).to.equal(true);
  });

  // --------------------------------------------
  // Hash chain advances correctly under batched flow
  // --------------------------------------------
  it('hash chain advances per-action even when sig is shared by a batch', async function () {
    const beforeCount = Number(await setup.cawActions.clientActionCount(setup.clientId));
    const beforeHash = await setup.cawActions.clientCurrentHash(setup.clientId);

    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [0, 1].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start + i,
      recipients: [], amounts: [0],
      text: '0x' + Buffer.from(`hashchain${i}`).toString('hex'),
    }));
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(userA, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...batchSig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

    const afterCount = Number(await setup.cawActions.clientActionCount(setup.clientId));
    const afterHash = await setup.cawActions.clientCurrentHash(setup.clientId);
    expect(afterCount).to.equal(beforeCount + 2);
    expect(afterHash).to.not.equal(beforeHash);
  });

  // --------------------------------------------
  // Reject mixed-sender batch
  // --------------------------------------------
  it('reverts when a batch group contains actions from different senders', async function () {
    const aStart = Number(await setup.cawActions.nextCawonce(userATokenId));
    const bStart = Number(await setup.cawActions.nextCawonce(userBTokenId));
    const a = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: aStart,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('a').toString('hex'),
    };
    const b = {
      actionType: ACTION_TYPE.caw, senderId: userBTokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: bStart,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('b').toString('hex'),
    };
    const { hex } = packActions([a, b]);
    // userA signs both as a batch — but b has senderId=userB, so the
    // contract should require all batch actions to share senderId.
    const batchSig = signActionBatch(userA, [a, b], domain);
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...batchSig }]);

    let reverted = false;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      reverted = e.message.includes('Mixed senders in batch');
    }
    expect(reverted).to.equal(true, 'expected revert with "Mixed senders in batch"');
  });

  // --------------------------------------------
  // Reject duplicate cawonce within a batch
  // --------------------------------------------
  it('reverts when a batch reuses a cawonce', async function () {
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [
      {
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: start,
        recipients: [], amounts: [0], text: '0x' + Buffer.from('first').toString('hex'),
      },
      {
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: start, // <-- same cawonce
        recipients: [], amounts: [0], text: '0x' + Buffer.from('dup').toString('hex'),
      },
    ];
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(userA, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...batchSig }]);

    // The duplicate cawonce is also non-contiguous (the second action's
    // cawonce is `start` but should be `start + 1`), so the contract reverts
    // earlier with the cleaner "Non-contiguous cawonces in batch" message
    // before useCawonce ever runs. That's the desired behavior — the batch
    // sig now commits to a strictly ascending cawonce sequence.
    let reverted = false;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      reverted = e.message.includes('Non-contiguous cawonces in batch');
    }
    expect(reverted).to.equal(true);
  });

  // --------------------------------------------
  // Reject non-contiguous cawonces within a batch (gap, not duplicate)
  // --------------------------------------------
  it('reverts when batch cawonces are non-contiguous (skip)', async function () {
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [
      {
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: start,
        recipients: [], amounts: [0], text: '0x' + Buffer.from('a').toString('hex'),
      },
      {
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: start + 2, // <-- gap; should be start + 1
        recipients: [], amounts: [0], text: '0x' + Buffer.from('b').toString('hex'),
      },
    ];
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(userA, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...batchSig }]);

    let reverted = false;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      reverted = e.message.includes('Non-contiguous cawonces in batch');
    }
    expect(reverted).to.equal(true, 'expected revert with "Non-contiguous cawonces in batch"');
  });

  // --------------------------------------------
  // safeProcessActions: whole-group rejection
  // --------------------------------------------
  it('safeProcessActions marks the entire batch group rejected when one action fails', async function () {
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [
      {
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: start,
        recipients: [], amounts: [0], text: '0x' + Buffer.from('ok').toString('hex'),
      },
      {
        actionType: ACTION_TYPE.follow, senderId: userATokenId, receiverId: userATokenId, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: start + 1,
        recipients: [], amounts: [0], text: '0x',
      },
    ];
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(userA, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...batchSig }]);

    const result = await setup.cawActions.safeProcessActions.call(validatorTokenId, hex, sigsHex, 0, 0);
    // Both actions should be in `rejections` (whole-group rejection on the
    // self-follow). successCount should be 0.
    expect(Number(result.successCount)).to.equal(0);
    expect(result.rejections.length).to.equal(2);
    expect(result.rejections[0]).to.equal(result.rejections[1]); // same reason for whole group
    expect(result.rejections[0]).to.include('Cannot follow yourself');
  });

  // --------------------------------------------
  // Session-key path: scope check still per-action
  // --------------------------------------------
  it('reverts a batch sig from a session key when one action exceeds scope', async function () {
    // Register sessionKeyEoa for userA's wallet, scope=LIKE only (bit 1).
    // Pull expiry from chain time (wallclock can drift far from a long-lived
    // local hardhat node's block.timestamp).
    const block = await web3.eth.getBlock('latest');
    const expiry = Number(block.timestamp) + 3600;
    const scopeBitmap = 1 << ACTION_TYPE.like; // only LIKE allowed
    const spendLimit = 0; // unlimited
    await registerSessionFor(userA, sessionKeyEoa, scopeBitmap, spendLimit, expiry);

    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [
      {
        actionType: ACTION_TYPE.like, senderId: userATokenId, receiverId: userBTokenId, receiverCawonce: 1,
        clientId: setup.clientId, cawonce: start,
        recipients: [], amounts: [0], text: '0x',
      },
      {
        // CAW is NOT in scope — should make the whole batch revert
        actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: start + 1,
        recipients: [], amounts: [0], text: '0x' + Buffer.from('out of scope').toString('hex'),
      },
    ];
    const { hex } = packActions(actions);
    // sessionKeyEoa signs the batch
    const batchSig = signActionBatch(sessionKeyEoa, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...batchSig }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    if (!revertReason) {
      throw new Error('Expected a revert but the call succeeded');
    }
    expect(revertReason).to.include('Action not in session scope');
  });

  // --------------------------------------------
  // Session-key spendLimit: batch path uses cached (owner, spendLimit) once
  // per group. Exact-hit boundary — sum equals limit on the last action.
  // --------------------------------------------
  it('session-key batch: spendLimit exactly reached on last action succeeds', async function () {
    const block = await web3.eth.getBlock('latest');
    const expiry = Number(block.timestamp) + 3600;
    // CAW costs 5000 (whole-CAW units, NOT wei) per action. _applyAction
    // accumulates `actionCost` in whole-CAW units, so spendLimit is in the
    // same unit. 3 CAWs * 5000 = 15000 spendLimit.
    const scopeBitmap = 1 << ACTION_TYPE.caw;
    const spendLimit = 15000;
    await registerSessionFor(userA, sessionKeyEoa, scopeBitmap, spendLimit, expiry);

    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [0, 1, 2].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start + i,
      recipients: [], amounts: [0],
      text: '0x' + Buffer.from(`exact${i}`).toString('hex'),
    }));
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(sessionKeyEoa, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 3, ...batchSig }]);

    // Should succeed — sum-on-last-action == spendLimit (boundary <= test).
    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    expect(Number(await setup.cawActions.nextCawonce(userATokenId))).to.equal(start + 3);
  });

  // --------------------------------------------
  // Session-key spendLimit: cumulative spend tracked across batch (sum > limit
  // reverts on the action that crosses, with all prior batch state rolled back).
  // --------------------------------------------
  it('session-key batch: reverts whole batch when spendLimit is exceeded mid-stream', async function () {
    const block = await web3.eth.getBlock('latest');
    const expiry = Number(block.timestamp) + 3600;
    // 3 CAWs need 15000; set limit at 10000 so the third trips the require.
    const scopeBitmap = 1 << ACTION_TYPE.caw;
    const spendLimit = 10000; // whole-CAW units
    // Use a fresh session key (accounts[5]) so we don't collide with prior
    // sessionSpent state that the last test left behind.
    const freshSessionKey = accounts[5];
    await registerSessionFor(userA, freshSessionKey, scopeBitmap, spendLimit, expiry);

    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [0, 1, 2].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start + i,
      recipients: [], amounts: [0],
      text: '0x' + Buffer.from(`exceed${i}`).toString('hex'),
    }));
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(freshSessionKey, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 3, ...batchSig }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    expect(revertReason).to.not.equal(null, 'expected revert on exceeded spend limit');
    expect(revertReason).to.include('Session spend limit exceeded');
    // None of the batch's cawonces should have been consumed (full rollback).
    expect(Number(await setup.cawActions.nextCawonce(userATokenId))).to.equal(start);
  });

  // --------------------------------------------
  // Session-key SINGLE-SIG path through processActions — exercises the
  // BatchAuth lazy-fetch in _applyAction (single-sig leaves owner/spendLimit
  // zero in BatchAuth and _applyAction must fall back to fetching them).
  // --------------------------------------------
  it('session-key single-sig: BatchAuth lazy-fetch resolves owner+spendLimit', async function () {
    const block = await web3.eth.getBlock('latest');
    const expiry = Number(block.timestamp) + 3600;
    const scopeBitmap = 1 << ACTION_TYPE.caw;
    const spendLimit = 5000; // exactly one CAW (whole-CAW units)
    const freshSessionKey = accounts[6];
    await registerSessionFor(userA, freshSessionKey, scopeBitmap, spendLimit, expiry);

    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start,
      recipients: [], amounts: [0],
      text: '0x' + Buffer.from('single-sig session').toString('hex'),
    };
    const { hex } = packActions([action]);
    // Single-action group means groupSize=1 — the legacy single-sig flow.
    const sig = signActionData(freshSessionKey, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    expect(Number(await setup.cawActions.nextCawonce(userATokenId))).to.equal(start + 1);

    // A second action should now exceed the spend limit (lazy-fetch must
    // observe the cumulative sessionSpent state from the first call).
    const action2 = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start + 1,
      recipients: [], amounts: [0],
      text: '0x' + Buffer.from('over limit').toString('hex'),
    };
    const { hex: hex2 } = packActions([action2]);
    const sig2 = signActionData(freshSessionKey, action2, domain);
    const sigsHex2 = packGroupedSigs([{ groupSize: 1, ...sig2 }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex2, sigsHex2, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    expect(revertReason).to.include('Session spend limit exceeded');
  });

  // --------------------------------------------
  // Tampered batch reverts with the new clear message (not "Session expired")
  // --------------------------------------------
  it('reverts with "Batch signature did not recover a valid signer" when the submitted actions differ from the signed actions', async function () {
    // Sign a 3-action batch, then submit only 2 of them under the same sig.
    // The contract recomputes actionsHash over those 2 actions, gets a
    // different hash than what was signed, ecrecover returns a wrong
    // signer, and the contract should now surface a clear error instead
    // of falsely claiming the user's session expired.
    const start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const signedActions = [0, 1, 2].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: start + i,
      recipients: [], amounts: [0],
      text: '0x' + Buffer.from(`signed${i}`).toString('hex'),
    }));
    // User signs over all 3.
    const batchSig = signActionBatch(userA, signedActions, domain);

    // Validator (or attacker) submits only 2 of the 3 actions under that sig.
    const truncated = signedActions.slice(0, 2);
    const { hex } = packActions(truncated);
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...batchSig }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    if (!revertReason) {
      throw new Error('Expected a revert but the call succeeded');
    }
    expect(revertReason).to.include('Batch signature did not recover a valid signer');
    // And critically, NOT the misleading message:
    expect(revertReason).to.not.include('Session expired');
  });
});
