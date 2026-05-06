/**
 * Integration tests for ERC-1271 contract-signature support in CawActions.
 *
 * Verifies that:
 *   - A profile NFT owned by a smart contract can authorize actions via 1271
 *     on the single-sig path (groupSize=1).
 *   - The same path works for batch sigs (groupSize>1).
 *   - When the contract returns 0xffffffff, the call reverts with
 *     "Invalid signature" (single) or
 *     "Batch signature did not recover a valid signer" (batch).
 *   - Existing EOA-owned profiles (happy path + session-key path) are
 *     unchanged by the 1271 fallback.
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
const MockContractOwner = artifacts.require("MockContractOwner");

const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');

const l1 = 30101;
const l2 = 8453;

// Hardhat default mnemonic private keys
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
  return {
    chainId,
    name: 'Caw Protocol',
    version: '1',
    verifyingContract: cawActions.address,
  };
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

async function registerSessionFor(setup, owner, sessionKey, scopeBitmap, spendLimit, expiry, perActionTipRate = 0) {
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

let setup;

async function buyUsername(user, name) {
  const mintAmount = (10n * 1_000_000_000n * 10n ** 18n).toString();
  await setup.token.mint(user, mintAmount);
  const cost = await setup.minter.costOfName(name);
  await setup.token.approve(setup.minter.address, cost.toString(), { from: user });
  const quote = await setup.quoter.mintQuote(setup.clientId, false);
  await setup.minter.mint(setup.clientId, name, quote.lzTokenFee, {
    from: user, value: quote.nativeFee.toString(),
  });
  const totalSupply = await setup.cawProfile.totalSupply();
  return Number(totalSupply);
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
  const cawActions = await CawActions.new(cawProfileL2.address);
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, clientManager, clientId };
}

contract('CawActions — ERC-1271 contract-owner signatures', function (accounts) {
  const validatorOwner = accounts[0];
  const userA = accounts[1];           // EOA owner used for the unchanged-EOA-path test
  const userB = accounts[2];           // counterparty
  const contractKeyHolder = accounts[3]; // EOA whose key the mock contract authorizes
  const sessionKeyEoa = accounts[4];

  let validatorTokenId;
  let userATokenId;
  let userBTokenId;
  let contractOwnedTokenId;
  let mockOwner;
  let domain;

  before(async function () {
    this.timeout(180000);
    setup = await fullSetup(accounts);

    validatorTokenId = await buyUsername(validatorOwner, 'validator');
    userATokenId = await buyUsername(userA, 'usera');
    userBTokenId = await buyUsername(userB, 'userb');
    // contractKeyHolder mints the username, then we transfer it to the mock.
    contractOwnedTokenId = await buyUsername(contractKeyHolder, 'contracty');

    await depositAndAuth(validatorOwner, validatorTokenId, 5_000_000);
    await depositAndAuth(userA, userATokenId, 5_000_000);
    await depositAndAuth(userB, userBTokenId, 5_000_000);
    await depositAndAuth(contractKeyHolder, contractOwnedTokenId, 5_000_000);

    // Deploy the mock owner contract authorizing contractKeyHolder's key.
    mockOwner = await MockContractOwner.new(contractKeyHolder);

    // Transfer the L1 NFT to the mock contract and sync ownership down to L2.
    const transferQuote = await setup.quoter.syncTransferQuote(contractOwnedTokenId, mockOwner.address, false);
    await setup.cawProfile.transferAndSync(mockOwner.address, contractOwnedTokenId, transferQuote.lzTokenFee, {
      from: contractKeyHolder, value: transferQuote.nativeFee.toString(),
    });

    // Sanity: L2 ownerOf reflects the contract address.
    const l2Owner = await setup.cawProfileL2.ownerOf(contractOwnedTokenId);
    expect(l2Owner.toLowerCase()).to.equal(mockOwner.address.toLowerCase());

    domain = await getDomain(setup.cawActions);
  });

  // --------------------------------------------
  // EOA path is unchanged — sanity check
  // --------------------------------------------
  it('EOA-owned profile: single-action sig still works (regression)', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('hello eoa').toString('hex'),
    };
    const { hex } = packActions([action]);
    const sig = signActionData(userA, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    expect(await setup.cawActions.isCawonceUsed(userATokenId, cawonce)).to.equal(true);
  });

  it('EOA-owned profile: session-key path still works (regression)', async function () {
    const block = await web3.eth.getBlock('latest');
    const expiry = Number(block.timestamp) + 3600;
    const scopeBitmap = (1 << ACTION_TYPE.caw) | (1 << ACTION_TYPE.like);
    await registerSessionFor(setup, userA, sessionKeyEoa, scopeBitmap, 0, expiry);

    const cawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('via session').toString('hex'),
    };
    const { hex } = packActions([action]);
    const sig = signActionData(sessionKeyEoa, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    expect(await setup.cawActions.isCawonceUsed(userATokenId, cawonce)).to.equal(true);
  });

  // --------------------------------------------
  // ERC-1271 single-sig path
  // --------------------------------------------
  it('contract-owned profile: single action authorized via ERC-1271', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(contractOwnedTokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: contractOwnedTokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('1271 hello').toString('hex'),
    };
    const { hex } = packActions([action]);
    // The signer is contractKeyHolder — NOT the owner of the NFT (the mock
    // contract is). ecrecover will return contractKeyHolder; the contract has
    // no session, so the 1271 fallback runs. The mock's isValidSignature
    // recovers the same key and returns the magic value.
    const sig = signActionData(contractKeyHolder, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    expect(await setup.cawActions.isCawonceUsed(contractOwnedTokenId, cawonce)).to.equal(true);
  });

  // --------------------------------------------
  // ERC-1271 batch-sig path
  // --------------------------------------------
  it('contract-owned profile: batch of 3 actions authorized via ERC-1271', async function () {
    const startCawonce = Number(await setup.cawActions.nextCawonce(contractOwnedTokenId));
    const actions = [];
    for (let i = 0; i < 3; i++) {
      actions.push({
        actionType: ACTION_TYPE.caw, senderId: contractOwnedTokenId, receiverId: 0, receiverCawonce: 0,
        clientId: setup.clientId, cawonce: startCawonce + i,
        recipients: [], amounts: [0],
        text: '0x' + Buffer.from(`batch1271 ${i}`).toString('hex'),
      });
    }
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(contractKeyHolder, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 3, ...batchSig }]);

    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    for (let i = 0; i < 3; i++) {
      expect(await setup.cawActions.isCawonceUsed(contractOwnedTokenId, startCawonce + i)).to.equal(true);
    }
  });

  // --------------------------------------------
  // ERC-1271 rejection on single-sig path
  // --------------------------------------------
  it('contract-owned profile: single action reverts when ERC-1271 returns 0xffffffff', async function () {
    await mockOwner.setAlwaysReject(true);
    const cawonce = Number(await setup.cawActions.nextCawonce(contractOwnedTokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: contractOwnedTokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('rejected').toString('hex'),
    };
    const { hex } = packActions([action]);
    const sig = signActionData(contractKeyHolder, action, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    await mockOwner.setAlwaysReject(false);

    if (!revertReason) throw new Error('Expected a revert but the call succeeded');
    expect(revertReason).to.include('Invalid signature');
    expect(await setup.cawActions.isCawonceUsed(contractOwnedTokenId, cawonce)).to.equal(false);
  });

  // --------------------------------------------
  // ERC-1271 rejection on batch path
  // --------------------------------------------
  it('contract-owned profile: batch reverts when ERC-1271 returns 0xffffffff', async function () {
    await mockOwner.setAlwaysReject(true);
    const startCawonce = Number(await setup.cawActions.nextCawonce(contractOwnedTokenId));
    const actions = [0, 1].map(i => ({
      actionType: ACTION_TYPE.caw, senderId: contractOwnedTokenId, receiverId: 0, receiverCawonce: 0,
      clientId: setup.clientId, cawonce: startCawonce + i,
      recipients: [], amounts: [0], text: '0x' + Buffer.from(`batchreject ${i}`).toString('hex'),
    }));
    const { hex } = packActions(actions);
    const batchSig = signActionBatch(contractKeyHolder, actions, domain);
    const sigsHex = packGroupedSigs([{ groupSize: 2, ...batchSig }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    await mockOwner.setAlwaysReject(false);

    if (!revertReason) throw new Error('Expected a revert but the call succeeded');
    expect(revertReason).to.include('Batch signature did not recover a valid signer');
  });
});
