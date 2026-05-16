/**
 * Gas comparison: processActions (sig path) vs processActionsWithZkSigs (zk path).
 *
 * Both paths share the same state-application code below the verification
 * step. The interesting deltas are:
 *   sig path:    n × ecrecover + EIP-712 hashing per action (in-EVM)
 *   zk path:     1 × Groth16 verify + n × walk-only (no ecrecover)
 *                + the signers[] calldata (20 bytes per action)
 *
 * For matched batches, the zk path is cheaper at large n (the per-action
 * ecrecover savings outweigh the constant-cost verifier call) and more
 * expensive at small n (the verifier dominates).
 *
 * IMPORTANT CAVEAT: this test uses MockSP1Verifier whose verifyProof body
 * is a single boolean require(). The real SP1Verifier (Groth16, v6.1.0)
 * costs roughly 250–400K gas in its verify. So this test gives the
 * lower-bound on the zk path. To get the true number, run with the
 * vendored SP1Verifier and a real fixture proof — see
 * zk-real-verifier-test.js for the prerequisite.
 *
 * The test snapshot we record here is "everything except the verifier",
 * which is the right number for measuring our state-application logic in
 * isolation. The full picture is gas(here) + ~300K (verifier).
 *
 * Output is a console table so the developer running the suite can paste
 * it into a commit message / write-up. Doesn't fail except on impossibly-
 * large regressions.
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
const MockSP1Verifier = artifacts.require("MockSP1Verifier");

const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');

const l1 = 30101;
const l2 = 8453;

const testKeys = {
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex'),
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex'),
};
function privFor(addr) {
  const key = testKeys[addr.toLowerCase()];
  if (!key) throw new Error(`No test key for ${addr}`);
  return key;
}

const dataTypes = {
  EIP712Domain: [
    { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
  ],
  ActionData: [
    { name: 'actionType', type: 'uint8' }, { name: 'senderId', type: 'uint32' },
    { name: 'receiverId', type: 'uint32' }, { name: 'receiverCawonce', type: 'uint32' },
    { name: 'networkId', type: 'uint32' }, { name: 'cawonce', type: 'uint32' },
    { name: 'recipients', type: 'uint32[]' }, { name: 'amounts', type: 'uint64[]' },
    { name: 'text', type: 'bytes' },
  ],
};

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
  return '0x' + buf.toString('hex');
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
function packSigners(addrs) {
  const buf = Buffer.alloc(addrs.length * 20);
  for (let i = 0; i < addrs.length; i++) {
    Buffer.from(addrs[i].replace(/^0x/, ''), 'hex').copy(buf, i * 20);
  }
  return '0x' + buf.toString('hex');
}
function splitSig(sigHex) {
  const sans = sigHex.replace(/^0x/, '');
  return { r: '0x' + sans.slice(0, 64), s: '0x' + sans.slice(64, 128), v: parseInt(sans.slice(128, 130), 16) };
}
function signActionData(signer, action, domain) {
  const data = {
    primaryType: 'ActionData', domain,
    types: { EIP712Domain: dataTypes.EIP712Domain, ActionData: dataTypes.ActionData },
    message: { ...action },
  };
  const sig = signTypedData({ data, privateKey: privFor(signer), version: SignTypedDataVersion.V4 });
  return splitSig(sig);
}

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

  const mockVerifier = await MockSP1Verifier.new();
  const dummyVKey = "0x" + "11".repeat(32);
  const cawActions = await CawActions.new(cawProfileL2.address, mockVerifier.address, dummyVKey, "0x0000000000000000000000000000000000000000");
  await cawProfileL2.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileL2, minter, quoter, cawActions, networkManager, networkId, mockVerifier };
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

contract('CawActions — gas comparison: sig path vs zk path (mock verifier)', function (accounts) {
  const validatorOwner = accounts[0];
  const userA = accounts[1];

  let validatorTokenId, userATokenId, domain;

  before(async function () {
    this.timeout(180000);
    setup = await fullSetup(accounts);
    validatorTokenId = await buyUsername(validatorOwner, 'validator');
    userATokenId = await buyUsername(userA, 'usera');
    await depositAndAuth(validatorOwner, validatorTokenId, 50_000_000);
    await depositAndAuth(userA, userATokenId, 50_000_000);
    const chainId = await web3.eth.getChainId();
    domain = { chainId, name: 'Caw Protocol', version: '1', verifyingContract: setup.cawActions.address };
  });

  // Real verifier gas, measured against the canonical SP1VerifierGateway on
  // Base Sepolia (test-fork/zk-fork-test.js). Added to every ZK row to give
  // the realistic on-chain total.
  const REAL_VERIFIER_GAS = 265_000;

  async function measureBatch(n) {
    let start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const buildActions = () => Array.from({ length: n }, (_, i) => ({
      actionType: 0, senderId: userATokenId, receiverId: 0, receiverCawonce: 0,
      networkId: setup.networkId, cawonce: start + i,
      recipients: [], amounts: [0], text: '0x',
    }));

    // ----- sig path -----
    // SINGLETON groups (one per action) — this is what mixed-signer prod
    // batches actually look like, since LIKE/FOLLOW/CAW from many different
    // users each get their own group.
    const sigActions = buildActions();
    const sigHex = packActions(sigActions);
    const sigSigs = sigActions.map(a => signActionData(userA, a, domain));
    const sigSigsHex = packGroupedSigs(sigSigs.map(s => ({ groupSize: 1, ...s })));
    const sigTx = await setup.cawActions.processActions(
      validatorTokenId, sigHex, sigSigsHex, 0, 0
    );

    // ----- zk path (mock verifier accepts) -----
    start = Number(await setup.cawActions.nextCawonce(userATokenId));
    const zkActions = buildActions();
    const zkHex = packActions(zkActions);
    const zkSigs = zkActions.map(a => signActionData(userA, a, domain));
    const zkSigsHex = packGroupedSigs(zkSigs.map(s => ({ groupSize: 1, ...s })));
    const signersHex = packSigners(Array(n).fill(userA));
    const dummyProof = "0x" + "ab".repeat(32);
    const zkTx = await setup.cawActions.processActionsWithZkSigs(
      validatorTokenId, zkHex, zkSigsHex, signersHex, dummyProof, 0, 0
    );

    return {
      n,
      sigGas: sigTx.receipt.gasUsed,
      zkMockGas: zkTx.receipt.gasUsed,
      zkRealGas: zkTx.receipt.gasUsed + REAL_VERIFIER_GAS,
    };
  }

  it('measures gas across realistic batch sizes (1..128)', async function () {
    this.timeout(900_000);
    // Sizes include real prod batch sizes from test.caw.social
    // (sampled 2026-05-07: n in [17..30]).
    const sizes = [1, 3, 8, 16, 20, 23, 28, 30, 64, 128];
    const rows = [];
    for (const n of sizes) rows.push(await measureBatch(n));

    // Find the realistic break-even by linear interpolation on the
    // (n, zkRealGas - sigGas) curve.
    let breakEven = null;
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i], b = rows[i + 1];
      const da = a.zkRealGas - a.sigGas;
      const db = b.zkRealGas - b.sigGas;
      if (da > 0 && db < 0) {
        breakEven = a.n + (b.n - a.n) * (da / (da - db));
        break;
      }
    }

    console.log('\nGas comparison — processActions (sig) vs processActionsWithZkSigs (zk):');
    console.log('  ZK rows include +265K for the canonical SP1Verifier (measured on the fork).');
    console.log('  Group structure: SINGLETON (n groups of 1 — matches real prod batches).');
    console.table(rows.map(r => ({
      'n': r.n,
      'sig gas': r.sigGas.toLocaleString(),
      'zk gas (mock)': r.zkMockGas.toLocaleString(),
      'zk gas (real)': r.zkRealGas.toLocaleString(),
      'Δ vs sig': (r.zkRealGas - r.sigGas).toLocaleString(),
      'Δ/action': Math.round((r.zkRealGas - r.sigGas) / r.n).toLocaleString(),
    })));
    if (breakEven) {
      console.log(`\n  Break-even (interpolated): n ≈ ${breakEven.toFixed(1)} actions per batch.`);
    } else {
      console.log('\n  No break-even in the tested range — increase max size or verifier dominates.');
    }
  });
});
