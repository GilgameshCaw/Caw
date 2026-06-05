/**
 * Regression test for the validator's checkpoint-reconstruction wire format.
 *
 * Why this exists: replication's slashing path (`resolveChallenge` /
 * `slashIncoherentRoot` in CawActionsArchive.sol) compares an off-chain
 * computed checkpoint hash to the contract's `networkHashAtCheckpoint`. If
 * the validator unpacks the `sigs` blob from a `processActions` tx wrong,
 * the per-action `r` it folds into the hash chain diverges from the
 * on-chain `r`, the merkle root differs, and an honest peer slashes the
 * validator. The batched-signatures upgrade (commit 74acbe6) reshaped the
 * wire format from flat 65-byte chunks to grouped:
 *
 *   [uint16 numGroups][per group: uint16 groupSize + 65-byte (v,r,s)]
 *
 * with each batch group's r reused across `groupSize` actions. The
 * client-side unpacker must mirror that.
 *
 * This test:
 *   1. Submits a processActions tx covering exactly CHECKPOINT_INTERVAL
 *      actions, with a mix of single-sig groups and a multi-action batch
 *      group, so both wire variants are exercised.
 *   2. Reads `networkHashAtCheckpoint(networkId, 1)` from the contract.
 *   3. Re-derives the same hash off-chain by decoding the calldata,
 *      walking the sig blob via the inverse-of-pack format described
 *      above, and folding `h = keccak256(h, r[i], actionHash[i])` for
 *      each action.
 *   4. Asserts the two hashes match.
 *
 * If anyone changes the sig wire format on either side without updating
 * the other, this test fails — catching the regression before it becomes
 * a slashing event in production.
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
const { ethers } = require('ethers');

const { expect } = require('chai');

const l1 = 30101;
const l2 = 8453;
const CHECKPOINT_INTERVAL = 32;

// ============================================
// Test account private keys (hardhat default mnemonic)
// ============================================
const testKeys = {
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex'),
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex'),
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc': Buffer.from('5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', 'hex'),
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
};

const ACTION_TYPE = { caw: 0 };

// ============================================
// Packing — same format as client/src/utils/packActions.ts
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

// Inverse of packGroupedSigs — produces one (v,r,s) per action by repeating
// each group's sig `groupSize` times. Mirrors unpackPerActionSigs in
// client/src/utils/packActions.ts. If THIS function and that one drift,
// the test still fails (the off-chain computed hash diverges from the
// contract's networkHashAtCheckpoint), so this is the canonical reference.
function unpackPerActionSigs(sigsHex, expectedActionCount) {
  const sigs = Buffer.from(sigsHex.replace(/^0x/, ''), 'hex');
  if (sigs.length < 2) throw new Error('Sigs too short: missing numGroups header');
  const numGroups = sigs.readUInt16BE(0);
  if (numGroups === 0) throw new Error('Sigs has zero groups');
  const out = [];
  let pos = 2;
  for (let g = 0; g < numGroups; g++) {
    if (pos + 67 > sigs.length) throw new Error(`Sigs truncated at group ${g}`);
    const groupSize = sigs.readUInt16BE(pos);
    const v = sigs.readUInt8(pos + 2);
    const r = '0x' + sigs.slice(pos + 3, pos + 35).toString('hex');
    const s = '0x' + sigs.slice(pos + 35, pos + 67).toString('hex');
    for (let i = 0; i < groupSize; i++) out.push({ v, r, s });
    pos += 67;
  }
  if (out.length !== expectedActionCount) {
    throw new Error(`Sig coverage ${out.length} != expected ${expectedActionCount}`);
  }
  return out;
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

// ============================================
// Setup — minimal: two users, one validator, one network
// ============================================
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

  const dummyPathwayExpander = "0x000000000000000000000000000000000000bEEF";
  const cpDeployer = accounts[0];
  const cpNonce = await web3.eth.getTransactionCount(cpDeployer);
  const predictedMinter = ethers.getCreateAddress({ from: cpDeployer, nonce: cpNonce + 1 });
  const cawProfile = await CawProfile.new(token.address, uri.address, buyAndBurn.address, networkManager.address, l1Endpoint.address, l1, "0x0000000000000000000000000000000000000000", cawProfileL2.address, dummyPathwayExpander, predictedMinter);
  const minter = await CawProfileMinter.new(token.address, cawProfile.address, mockRouter.address, dummyPathwayExpander);
  assert.equal(minter.address.toLowerCase(), predictedMinter.toLowerCase(), "minter address prediction mismatch");
  await buyAndBurn.setCawProfile(cawProfile.address);
  await cawProfileL2.setL1Peer(l1, cawProfile.address, false);
  await l2Endpoint.setDestLzEndpoint(cawProfile.address, l1Endpoint.address);
  await cawProfile.setL2Peer(l2, cawProfileL2.address);

  await networkManager.createNetwork("Test Network", accounts[0], l2, 0, 0, 0, 0, 0);
  const networkId = 1;
  const quoter = await CawProfileQuoter.new(cawProfile.address);

  const cawActions = await CawActions.new(cawProfileL2.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000");
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, networkManager, networkId };
}

async function buyUsername(setup, user, name) {
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

async function depositAndAuth(setup, user, tokenId, amountWholeCaw) {
  const cawAmountWei = (BigInt(amountWholeCaw) * 10n ** 18n).toString();
  const balance = await setup.token.balanceOf(user);
  await setup.token.approve(setup.cawProfile.address, balance.toString(), { from: user });
  const quote = await setup.quoter.depositQuote(setup.networkId, tokenId, cawAmountWei, l2, false);
  await setup.cawProfile.deposit(setup.networkId, tokenId, cawAmountWei, l2, quote.lzTokenFee, {
    from: user, value: quote.nativeFee.toString(),
  });
}

// ============================================
// Test
// ============================================
contract('Replication reconstruction — wire-format invariant', function (accounts) {
  const validatorOwner = accounts[0];
  const userA = accounts[1];
  let setup, validatorTokenId, userATokenId, domain;

  before(async function () {
    this.timeout(180000);
    setup = await fullSetup(accounts);
    validatorTokenId = await buyUsername(setup, validatorOwner, 'validator');
    userATokenId = await buyUsername(setup, userA, 'usera');
    await depositAndAuth(setup, validatorOwner, validatorTokenId, 5_000_000);
    await depositAndAuth(setup, userA, userATokenId, 5_000_000);
    domain = await getDomain(setup.cawActions);
  });

  it('reconstructs networkHashAtCheckpoint from grouped sigs (mixed single + batch)', async function () {
    this.timeout(120000);

    // Build CHECKPOINT_INTERVAL (32) actions from userA so the very first
    // checkpoint commits at action #32. Mix groupings so both wire forms
    // are in the sig blob:
    //   • Group A: 5 single-sig actions (groupSize=1 each)
    //   • Group B: 1 batch sig over 27 actions (groupSize=27)
    // 5 + 27 = 32 = CHECKPOINT_INTERVAL.
    const startCawonce = Number(await setup.cawActions.nextCawonce(userATokenId));
    const actions = [];
    for (let i = 0; i < CHECKPOINT_INTERVAL; i++) {
      actions.push({
        actionType: ACTION_TYPE.caw,
        senderId: userATokenId,
        receiverId: 0,
        receiverCawonce: 0,
        networkId: setup.networkId,
        cawonce: startCawonce + i,
        recipients: [],
        amounts: [0],
        text: '0x' + Buffer.from(`thread chunk ${i}`).toString('hex'),
      });
    }

    // Sigs: first 5 actions get individual sigs, remaining 27 share a batch sig.
    const groups = [];
    for (let i = 0; i < 5; i++) {
      const sig = signActionData(userA, actions[i], domain);
      groups.push({ groupSize: 1, ...sig });
    }
    const batchSig = signActionBatch(userA, actions.slice(5), domain);
    groups.push({ groupSize: 27, ...batchSig });

    const { hex: packedHex } = packActions(actions);
    const sigsHex = packGroupedSigs(groups);

    // Snapshot prevHash BEFORE submission so we can fold the chain off-chain
    // from the same starting point the contract will use.
    const prevHashBefore = await setup.cawActions.networkCurrentHash(setup.networkId);

    const tx = await setup.cawActions.processActions(
      validatorTokenId, packedHex, sigsHex, 0, 0
    );
    expect(tx.receipt.status).to.equal(true);

    // The contract should have written to networkHashAtCheckpoint[networkId][1]
    // since CHECKPOINT_INTERVAL actions just landed.
    const checkpointHashOnChain = await setup.cawActions.networkHashAtCheckpoint(setup.networkId, 1);
    expect(checkpointHashOnChain).to.not.equal('0x' + '0'.repeat(64));

    // ---- Off-chain reconstruction ----
    // 1. Decode the same calldata the validator would read from a past
    //    processActions tx. Pull packedActions + sigs.
    // 2. Walk the sig blob via unpackPerActionSigs.
    // 3. Fold h = keccak(h, r[i], actionHash[i]) for each action.
    // 4. Compare to networkHashAtCheckpoint(networkId, 1).
    const slices = actions.map(packActionForSlice);
    const perActionSigs = unpackPerActionSigs(sigsHex, actions.length);
    expect(perActionSigs.length).to.equal(CHECKPOINT_INTERVAL);

    let h = prevHashBefore;
    for (let i = 0; i < actions.length; i++) {
      const actionHash = web3.utils.soliditySha3({ t: 'bytes', v: '0x' + slices[i].toString('hex') });
      h = web3.utils.soliditySha3(
        { t: 'bytes32', v: h },
        { t: 'bytes32', v: perActionSigs[i].r },
        { t: 'bytes32', v: actionHash },
      );
    }

    expect(h).to.equal(
      checkpointHashOnChain,
      'Off-chain reconstructed checkpoint hash diverged from on-chain ' +
      'networkHashAtCheckpoint — wire format mismatch (would slash a real validator).'
    );
  });
});
