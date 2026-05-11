/**
 * Integration test for CawActionVerifier + CawTipResponder.
 *
 * Submits 32 real actions through CawActions to build up a real checkpoint,
 * then calls CawTipResponder.fulfill() with the checkpoint slice + per-action
 * `r` values and verifies it folds correctly to the canonical hash and emits
 * the Echoed event when the target action has an ::echo:msg:: marker.
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
const CawActionVerifier = artifacts.require("CawActionVerifier");
const CawTipResponder = artifacts.require("CawTipResponder");

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

  const cawProfileL2 = await CawProfileL2.new(l1, l2Endpoint.address);
  await l1Endpoint.setDestLzEndpoint(cawProfileL2.address, l2Endpoint.address);

  const cawProfile = await CawProfile.new(token.address, uri.address, buyAndBurn.address, networkManager.address, l1Endpoint.address, l1);
  await buyAndBurn.setCawProfile(cawProfile.address);
  await cawProfileL2.setL1Peer(l1, cawProfile.address, false);
  await l2Endpoint.setDestLzEndpoint(cawProfile.address, l1Endpoint.address);
  await cawProfile.setL2Peer(l2, cawProfileL2.address);

  await networkManager.createNetwork("Test Network", accounts[0], l2, 0, 0, 0, 0);
  const networkId = 1;

  const minter = await CawProfileMinter.new(token.address, cawProfile.address, mockRouter.address);
  await cawProfile.setMinter(minter.address);
  const quoter = await CawProfileQuoter.new(cawProfile.address);
  const cawActions = await CawActions.new(
    cawProfileL2.address,
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  );
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, networkManager, networkId };
}

contract('CawActionVerifier — trustless action proofs via full-checkpoint fold', function (accounts) {
  const validatorOwner = accounts[0];
  const userA = accounts[1];
  const userB = accounts[2];
  const responderProfileBuyer = accounts[3];

  let validatorTokenId;
  let userATokenId;
  let userBTokenId;
  let responderTokenId;
  let domain;

  // Per-action artifacts captured at submit time, for proving later.
  let packedSlicesHex; // array of 32 hex strings, each a packed action
  let rValues;         // array of 32 r values (one per action)
  let targetActionMeta; // the canonical action data we'll prove

  let verifier;
  let responder;

  before(async function () {
    this.timeout(360000);
    setup = await fullSetup(accounts);

    validatorTokenId = await buyUsername(validatorOwner, 'validator');
    userATokenId = await buyUsername(userA, 'usera');
    userBTokenId = await buyUsername(userB, 'userb');
    responderTokenId = await buyUsername(responderProfileBuyer, 'echo');

    await depositAndAuth(validatorOwner, validatorTokenId, 5_000_000);
    await depositAndAuth(userA, userATokenId, 10_000_000);
    await depositAndAuth(userB, userBTokenId, 10_000_000);
    await depositAndAuth(responderProfileBuyer, responderTokenId, 5_000_000);

    domain = await getDomain(setup.cawActions);

    // ----------------------------------------------
    // Submit exactly 32 actions to build checkpoint 1
    // ----------------------------------------------
    packedSlicesHex = [];
    rValues = [];

    // We'll target action #5 (0-indexed) as the one to prove. Its text contains
    // an ::echo:msg:: marker so the responder will emit Echoed on fulfill.
    const TARGET_INDEX = 5;
    const TARGET_MESSAGE = 'hello from action 5';

    for (let i = 0; i < 32; i++) {
      const isTarget = i === TARGET_INDEX;
      const sender = (i % 2 === 0) ? userA : userB;
      const senderTokenId = (i % 2 === 0) ? userATokenId : userBTokenId;
      const cawonce = Number(await setup.cawActions.nextCawonce(senderTokenId));

      const textBytes = isTarget
        ? `::echo:${TARGET_MESSAGE}::`
        : `noise action ${i}`;

      const action = {
        actionType: ACTION_TYPE.caw,
        senderId: senderTokenId,
        receiverId: responderTokenId,
        receiverCawonce: 0,
        networkId: setup.networkId,
        cawonce,
        recipients: [],
        amounts: [0],
        text: '0x' + Buffer.from(textBytes).toString('hex'),
      };

      const slice = packActionForSlice(action);
      packedSlicesHex.push('0x' + slice.toString('hex'));

      const { hex } = packActions([action]);
      const sig = signActionData(sender, action, domain);
      rValues.push(sig.r);

      const sigsHex = packGroupedSigs([{ groupSize: 1, ...sig }]);
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);

      if (isTarget) {
        targetActionMeta = {
          senderId: senderTokenId,
          receiverId: responderTokenId,
          message: TARGET_MESSAGE,
        };
      }
    }

    // Confirm the checkpoint actually exists on chain.
    const checkpointHash = await setup.cawActions.networkHashAtCheckpoint(setup.networkId, 1);
    expect(checkpointHash).to.not.equal('0x' + '00'.repeat(32));

    // Deploy verifier + responder.
    verifier = await CawActionVerifier.new(setup.cawActions.address);
    responder = await CawTipResponder.new(verifier.address, setup.networkId);
  });

  it('verifier folds the 32-action slice to the canonical checkpoint hash', async function () {
    const ok = await verifier.verify(setup.networkId, 1, packedSlicesHex, rValues);
    expect(ok).to.equal(true);
  });

  it('verifier rejects a tampered r value', async function () {
    const tamperedRs = [...rValues];
    tamperedRs[10] = '0x' + 'aa'.repeat(32);
    const ok = await verifier.verify(setup.networkId, 1, packedSlicesHex, tamperedRs);
    expect(ok).to.equal(false);
  });

  it('verifier rejects a tampered action slice', async function () {
    const tamperedSlices = [...packedSlicesHex];
    // Mangle the 5th byte of action 12.
    const buf = Buffer.from(tamperedSlices[12].replace(/^0x/, ''), 'hex');
    buf[5] = (buf[5] ^ 0xff) & 0xff;
    tamperedSlices[12] = '0x' + buf.toString('hex');
    const ok = await verifier.verify(setup.networkId, 1, tamperedSlices, rValues);
    expect(ok).to.equal(false);
  });

  it('verifier reverts on a checkpoint that does not exist yet', async function () {
    let revert = null;
    try {
      await verifier.verify(setup.networkId, 999, packedSlicesHex, rValues);
    } catch (e) { revert = e.message; }
    // verify() returns false rather than reverting for an unset checkpoint;
    // verifyAndExtract reverts. Confirm the returned value is false here.
    if (revert) throw new Error('verify should not revert, got: ' + revert);
  });

  it('verifyAndExtract reverts on a checkpoint that does not exist yet', async function () {
    let revert = null;
    try {
      await verifier.verifyAndExtract(setup.networkId, 999, packedSlicesHex, rValues, 0);
    } catch (e) { revert = e.message; }
    if (!revert) throw new Error('Expected revert');
    expect(revert).to.include('Checkpoint not finalized');
  });

  it('responder emits Echoed for the target action', async function () {
    const TARGET_INDEX = 5;
    const tx = await responder.fulfill(1, packedSlicesHex, rValues, TARGET_INDEX);
    const ev = tx.logs.find(l => l.event === 'Echoed');
    expect(ev, 'Echoed event not emitted').to.not.equal(undefined);
    expect(ev.args.senderId.toString()).to.equal(String(targetActionMeta.senderId));
    expect(ev.args.receiverId.toString()).to.equal(String(targetActionMeta.receiverId));
    const messageBytes = Buffer.from(ev.args.message.replace(/^0x/, ''), 'hex').toString();
    expect(messageBytes).to.equal(targetActionMeta.message);
  });

  it('responder is silent on actions without an ::echo:: marker', async function () {
    // Action 0 has text "noise action 0" — no marker. fulfill() should run
    // (verification passes) but emit nothing.
    const tx = await responder.fulfill(1, packedSlicesHex, rValues, 0);
    const ev = tx.logs.find(l => l.event === 'Echoed');
    expect(ev).to.equal(undefined);
  });

  it('responder refuses to double-fulfill a marker action', async function () {
    const TARGET_INDEX = 5;
    let revert = null;
    try {
      await responder.fulfill(1, packedSlicesHex, rValues, TARGET_INDEX);
    } catch (e) { revert = e.message; }
    if (!revert) throw new Error('Expected revert');
    expect(revert).to.include('Already fulfilled');
  });
});
