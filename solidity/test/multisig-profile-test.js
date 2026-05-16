/**
 * Integration test for CawMultisigProfile (Pattern B example).
 *
 * Verifies that a 2-of-3 multisig holding a profile NFT can authorize a CAW
 * action through ERC-1271 by recording approvals against the EIP-712 digest
 * on chain. The submitted action's (r,s,v) is unused — the multisig proves
 * authorization via storage state.
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
const CawMultisigProfile = artifacts.require("CawMultisigProfile");

const { TypedDataUtils, SignTypedDataVersion } = require('@metamask/eth-sig-util');

const l1 = 30101;
const l2 = 8453;

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

async function getDomain(cawActions) {
  const chainId = await web3.eth.getChainId();
  return {
    chainId,
    name: 'Caw Protocol',
    version: '1',
    verifyingContract: cawActions.address,
  };
}

/// Compute the EIP-712 digest the multisig owners need to approve.
/// This is the same hash CawActions will pass to isValidSignature.
function computeActionDigest(action, domain) {
  const data = {
    primaryType: 'ActionData',
    domain,
    types: { EIP712Domain: dataTypes.EIP712Domain, ActionData: dataTypes.ActionData },
    message: { ...action },
  };
  const digest = TypedDataUtils.eip712Hash(data, SignTypedDataVersion.V4);
  return '0x' + digest.toString('hex');
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

  await networkManager.createNetwork("Test Network", accounts[0], l2, 0, 0, 0, 0, 0);
  const networkId = 1;

  const minter = await CawProfileMinter.new(token.address, cawProfile.address, mockRouter.address);
  await cawProfile.setMinter(minter.address);
  const quoter = await CawProfileQuoter.new(cawProfile.address);
  const cawActions = await CawActions.new(cawProfileL2.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000");
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, networkManager, networkId };
}

contract('CawMultisigProfile — 2-of-3 multisig owning a profile', function (accounts) {
  const validatorOwner = accounts[0];
  const profileBuyer = accounts[1];
  const ownerA = accounts[2];
  const ownerB = accounts[3];
  const ownerC = accounts[4];
  const stranger = accounts[5];

  let validatorTokenId;
  let multisigTokenId;
  let multisig;
  let domain;

  before(async function () {
    this.timeout(180000);
    setup = await fullSetup(accounts);

    validatorTokenId = await buyUsername(validatorOwner, 'validator');
    multisigTokenId = await buyUsername(profileBuyer, 'multisig');

    await depositAndAuth(validatorOwner, validatorTokenId, 5_000_000);
    await depositAndAuth(profileBuyer, multisigTokenId, 5_000_000);

    multisig = await CawMultisigProfile.new([ownerA, ownerB, ownerC], 2);

    const transferQuote = await setup.quoter.syncTransferQuote(multisigTokenId, multisig.address, false);
    await setup.cawProfile.transferAndSync(multisig.address, multisigTokenId, transferQuote.lzTokenFee, {
      from: profileBuyer, value: transferQuote.nativeFee.toString(),
    });

    const l2Owner = await setup.cawProfileL2.ownerOf(multisigTokenId);
    expect(l2Owner.toLowerCase()).to.equal(multisig.address.toLowerCase());

    domain = await getDomain(setup.cawActions);
  });

  it('initializes the multisig with the right owner set and threshold', async function () {
    expect((await multisig.ownerCount()).toString()).to.equal('3');
    expect((await multisig.threshold()).toString()).to.equal('2');
    expect(await multisig.isOwner(ownerA)).to.equal(true);
    expect(await multisig.isOwner(ownerB)).to.equal(true);
    expect(await multisig.isOwner(ownerC)).to.equal(true);
    expect(await multisig.isOwner(stranger)).to.equal(false);
  });

  it('rejects an action with no approvals (threshold not met)', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(multisigTokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: multisigTokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('no approvals').toString('hex'),
    };
    const { hex } = packActions([action]);
    // Dummy sig — Pattern B doesn't read it, but the wire format still needs 65 bytes.
    const sigsHex = packGroupedSigs([{
      groupSize: 1,
      v: 27,
      r: '0x' + '00'.repeat(32),
      s: '0x' + '00'.repeat(32),
    }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    if (!revertReason) throw new Error('Expected a revert but the call succeeded');
    expect(revertReason).to.include('Invalid signature');
    expect(await setup.cawActions.isCawonceUsed(multisigTokenId, cawonce)).to.equal(false);
  });

  it('rejects an action with only one approval (below threshold of 2)', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(multisigTokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: multisigTokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('one approval').toString('hex'),
    };
    const digest = computeActionDigest(action, domain);

    await multisig.approve(digest, { from: ownerA });
    expect((await multisig.approvalCount(digest)).toString()).to.equal('1');

    const { hex } = packActions([action]);
    const sigsHex = packGroupedSigs([{
      groupSize: 1, v: 27,
      r: '0x' + '00'.repeat(32),
      s: '0x' + '00'.repeat(32),
    }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    if (!revertReason) throw new Error('Expected a revert but the call succeeded');
    expect(revertReason).to.include('Invalid signature');
    expect(await setup.cawActions.isCawonceUsed(multisigTokenId, cawonce)).to.equal(false);
  });

  it('accepts an action once two of three owners have approved', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(multisigTokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: multisigTokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('multisig speaks').toString('hex'),
    };
    const digest = computeActionDigest(action, domain);

    await multisig.approve(digest, { from: ownerA });
    await multisig.approve(digest, { from: ownerB });
    expect((await multisig.approvalCount(digest)).toString()).to.equal('2');

    const { hex } = packActions([action]);
    const sigsHex = packGroupedSigs([{
      groupSize: 1, v: 27,
      r: '0x' + '00'.repeat(32),
      s: '0x' + '00'.repeat(32),
    }]);

    // Submitter is the validator EOA — anyone can submit once threshold is met.
    await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    expect(await setup.cawActions.isCawonceUsed(multisigTokenId, cawonce)).to.equal(true);
  });

  it('rejects approvals from non-owners', async function () {
    const digest = '0x' + 'aa'.repeat(32);
    let revertReason = null;
    try {
      await multisig.approve(digest, { from: stranger });
    } catch (e) {
      revertReason = e.message;
    }
    if (!revertReason) throw new Error('Expected a revert but the call succeeded');
    expect(revertReason).to.include('Not an owner');
  });

  it('lets an owner revoke their approval before submission', async function () {
    const cawonce = Number(await setup.cawActions.nextCawonce(multisigTokenId));
    const action = {
      actionType: ACTION_TYPE.caw, senderId: multisigTokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce,
      recipients: [], amounts: [0], text: '0x' + Buffer.from('revoked').toString('hex'),
    };
    const digest = computeActionDigest(action, domain);

    await multisig.approve(digest, { from: ownerA });
    await multisig.approve(digest, { from: ownerB });
    expect((await multisig.approvalCount(digest)).toString()).to.equal('2');

    await multisig.revoke(digest, { from: ownerB });
    expect((await multisig.approvalCount(digest)).toString()).to.equal('1');

    const { hex } = packActions([action]);
    const sigsHex = packGroupedSigs([{
      groupSize: 1, v: 27,
      r: '0x' + '00'.repeat(32),
      s: '0x' + '00'.repeat(32),
    }]);

    let revertReason = null;
    try {
      await setup.cawActions.processActions(validatorTokenId, hex, sigsHex, 0, 0);
    } catch (e) {
      revertReason = e.message;
    }
    if (!revertReason) throw new Error('Expected a revert but the call succeeded');
    expect(revertReason).to.include('Invalid signature');
  });
});
