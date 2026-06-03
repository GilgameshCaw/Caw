/**
 * Token-scoped session keys — CawProfileLedger + CawActions enforcement.
 *
 * Covers all design invariants:
 *  1. Wallet-scoped session still works (profileId=0 default path)
 *  2. Token-scoped: right profile -> success
 *  3. Token-scoped: wrong profile -> WrongProfileForSession
 *  4. Transfer clears token-scoped session (tokenSessionEpoch bump)
 *  5. Wallet-scoped survives transfer of a different token
 *  6. Token-scoped revoke via revokeSession (owner can delete)
 *  7. Epoch isolation: two tokens, only transferred token's session dies
 *  8. Nonce isolation: tokenSessionNonce[A] independent of sessionNonce[owner]
 *  9. WITHDRAW scope (bit 6) force-cleared in registerTokenScopedSession
 * 10. Spend limit honored on token-scoped session
 * 11. registerTokenScopedSession requires owner sig — non-owner reverts BadSig
 */

const MintableCaw = artifacts.require("MintableCaw");
const CawNetworkManager = artifacts.require("CawNetworkManager");
const CawProfile = artifacts.require("CawProfile");
const CawProfileLedger = artifacts.require("CawProfileLedger");
const CawProfileMinter = artifacts.require("CawProfileMinter");
const CawProfileQuoter = artifacts.require("CawProfileQuoter");
const CawActions = artifacts.require("CawActions");
const CawBuyAndBurn = artifacts.require("CawBuyAndBurn");
const MockSwapRouter = artifacts.require("MockSwapRouter");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");

const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');
const { expect } = require('chai');

// Custom-error selector helper
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

// Hardhat/truffle dev test private keys (deterministic per BIP-32 seed).
// Truffle dev ganache starts at HH index 5 in this environment.
// accounts[0]=HH#5, accounts[1]=HH#6, accounts[2]=HH#7
// Session keys that only sign off-chain (don't need ganache ETH) can use any
// HH address from this map regardless of whether ganache injects it.
const testKeys = {
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex'),
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex'),
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc': Buffer.from('5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', 'hex'),
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906': Buffer.from('7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', 'hex'),
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65': Buffer.from('47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', 'hex'),
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc': Buffer.from('8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', 'hex'),
  '0x976ea74026e726554db657fa54763abd0c3a0aa9': Buffer.from('92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', 'hex'),
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955': Buffer.from('4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', 'hex'),
};
function privFor(addr) {
  const key = testKeys[addr.toLowerCase()];
  if (!key) throw new Error(`No test key for ${addr}`);
  return key;
}

// Fixed session-key addresses (not injected by ganache; only used for off-chain signing).
// These are deterministic HH addresses with known private keys in testKeys above.
const SK_WALLET  = '0x90f79bf6eb2c4f870365e785982e1f101e93b906'; // HH#3
const SK_TOKEN_A = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'; // HH#4
const SK_TOKEN_B = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'; // HH#0
const SK_EXTRA   = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'; // HH#1
const SK_EXTRA2  = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'; // HH#2

const EIP712DomainTypes = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const ActionDataTypes = [
  { name: 'actionType', type: 'uint8' },
  { name: 'senderId', type: 'uint32' },
  { name: 'receiverId', type: 'uint32' },
  { name: 'receiverCawonce', type: 'uint32' },
  { name: 'networkId', type: 'uint32' },
  { name: 'cawonce', type: 'uint32' },
  { name: 'recipients', type: 'uint32[]' },
  { name: 'amounts', type: 'uint64[]' },
  { name: 'text', type: 'bytes' },
];

const ACTION_TYPE = { caw: 0, like: 1, unlike: 2, recaw: 3, follow: 4, unfollow: 5, withdraw: 6, other: 7 };

// ---- packing helpers (mirrors qs-other-session-test.js) ----
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
    types: { EIP712Domain: EIP712DomainTypes, ActionData: ActionDataTypes },
    message: { ...action },
  };
  const sig = signTypedData({ data, privateKey: privFor(signer), version: SignTypedDataVersion.V4 });
  return splitSig(sig);
}

// Sign a TokenSessionDelegation typed-data message (new typehash).
function signTokenSessionDelegation(signer, { profileId, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce }, l2ContractAddress, chainId) {
  const data = {
    primaryType: 'TokenSessionDelegation',
    domain: { name: 'CawProfileLedger', version: '1', chainId, verifyingContract: l2ContractAddress },
    types: {
      EIP712Domain: EIP712DomainTypes,
      TokenSessionDelegation: [
        { name: 'profileId',        type: 'uint32' },
        { name: 'sessionKey',       type: 'address' },
        { name: 'expiry',           type: 'uint64' },
        { name: 'scopeBitmap',      type: 'uint8' },
        { name: 'spendLimit',       type: 'uint256' },
        { name: 'perActionTipRate', type: 'uint64' },
        { name: 'nonce',            type: 'uint256' },
      ],
    },
    message: { profileId, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce },
  };
  const sig = signTypedData({ data, privateKey: privFor(signer), version: SignTypedDataVersion.V4 });
  return splitSig(sig);
}

// ---- deploy helpers ----
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

  const cawProfileLedger = await CawProfileLedger.new(l1, l2Endpoint.address, "0x0000000000000000000000000000000000000000");
  await l1Endpoint.setDestLzEndpoint(cawProfileLedger.address, l2Endpoint.address);

  const cawProfile = await CawProfile.new(token.address, uri.address, buyAndBurn.address, networkManager.address, l1Endpoint.address, l1, "0x0000000000000000000000000000000000000000");
  await buyAndBurn.setCawProfile(cawProfile.address);
  await cawProfileLedger.setL1Peer(l1, cawProfile.address, false);
  await l2Endpoint.setDestLzEndpoint(cawProfile.address, l1Endpoint.address);
  await cawProfile.setL2Peer(l2, cawProfileLedger.address);

  await networkManager.createNetwork("Test Network", accounts[0], l2, 0, 0, 0, 0, "500000000000");
  const networkId = 1;

  const minter = await CawProfileMinter.new(token.address, cawProfile.address, mockRouter.address);
  await cawProfile.setMinter(minter.address);
  const quoter = await CawProfileQuoter.new(cawProfile.address);

  const cawActions = await CawActions.new(cawProfileLedger.address, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0, 0);
  await cawProfileLedger.setCawActions(cawActions.address);

  return { token, cawProfile, cawProfileLedger, minter, quoter, cawActions, networkManager, networkId };
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

// Register a wallet-scoped session via registerSession (EIP-712).
async function registerWalletSession(ownerAddr, skAddr, opts) {
  const chainId = await web3.eth.getChainId();
  const nonce = Number(await setup.cawProfileLedger.sessionNonce(ownerAddr));
  const exp = opts.expiry;
  const bm = opts.scopeBitmap;
  const sl = opts.spendLimit;
  const tr = opts.perActionTipRate;
  const data = {
    primaryType: 'SessionDelegation',
    domain: { name: 'CawProfileLedger', version: '1', chainId, verifyingContract: setup.cawProfileLedger.address },
    types: {
      EIP712Domain: EIP712DomainTypes,
      SessionDelegation: [
        { name: 'sessionKey',       type: 'address' },
        { name: 'expiry',           type: 'uint64' },
        { name: 'scopeBitmap',      type: 'uint8' },
        { name: 'spendLimit',       type: 'uint256' },
        { name: 'perActionTipRate', type: 'uint64' },
        { name: 'nonce',            type: 'uint256' },
      ],
    },
    message: { sessionKey: skAddr, expiry: exp, scopeBitmap: bm, spendLimit: sl, perActionTipRate: tr, nonce },
  };
  const sigHex = signTypedData({ data, privateKey: privFor(ownerAddr), version: SignTypedDataVersion.V4 });
  await setup.cawProfileLedger.registerSession(ownerAddr, skAddr, exp, bm, sl, tr, nonce, sigHex);
}

// Register a token-scoped session via registerTokenScopedSession.
async function registerTokenSession(ownerAddr, opts) {
  const pid = opts.profileId;
  const sk = opts.sessionKey;
  const exp = opts.expiry;
  const bm = opts.scopeBitmap & 0xBF; // mirror contract's force-clear of WITHDRAW bit (bit 6) before signing
  const sl = opts.spendLimit;
  const tr = opts.perActionTipRate;
  const cid = await web3.eth.getChainId();
  const nonce = Number(await setup.cawProfileLedger.tokenSessionNonce(pid));
  const { v, r, s } = signTokenSessionDelegation(ownerAddr, { profileId: pid, sessionKey: sk, expiry: exp, scopeBitmap: bm, spendLimit: sl, perActionTipRate: tr, nonce }, setup.cawProfileLedger.address, cid);
  await setup.cawProfileLedger.registerTokenScopedSession(pid, sk, exp, bm, sl, tr, nonce, v, r, s);
}

// Process a single CAW action signed by `signer` for `senderId`.
async function processCawAction(senderId, signer, validatorId, actionDomain) {
  const cawonce = Number(await setup.cawActions.nextCawonce(senderId));
  const action = {
    actionType: ACTION_TYPE.caw, senderId, receiverId: 0, receiverCawonce: 0,
    networkId: setup.networkId, cawonce, recipients: [], amounts: [0],
    text: '0x' + Buffer.from('hello').toString('hex'),
  };
  const packedHex = packActions([action]);
  const sig = signActionData(signer, action, actionDomain);
  return setup.cawActions.processActions(validatorId, packedHex, packGroupedSigs([{ groupSize: 1, ...sig }]), 0, 0);
}

// ---- Test suite ----

contract('Token-scoped sessions', function (accounts) {
  // accounts[0..2] are ganache-injected and have ETH for transactions.
  // They map to HH#5, HH#6, HH#7 in this test environment.
  // Session keys use fixed deterministic HH addresses (off-chain signing only).
  const validatorOwner = accounts[0]; // HH#5 — has key
  const userA          = accounts[1]; // HH#6 — has key
  const userB          = accounts[2]; // HH#7 — has key

  // Session key constants — these only sign off-chain, no ganache ETH needed.
  const walletSessionKey = SK_WALLET;  // HH#3
  const sessionKeyA      = SK_TOKEN_A; // HH#4
  const sessionKeyB      = SK_TOKEN_B; // HH#0

  let validatorId;
  let tokenA;
  let tokenB;
  let futureExpiry;
  let actionDomain;
  let chainId;

  before(async function () {
    this.timeout(180000);
    setup = await fullSetup(accounts);
    validatorId = await buyUsername(validatorOwner, 'validator');
    tokenA = await buyUsername(userA, 'usera');
    tokenB = await buyUsername(userB, 'userb');
    await depositAndAuth(validatorOwner, validatorId, 5_000_000);
    await depositAndAuth(userA, tokenA, 5_000_000);
    await depositAndAuth(userB, tokenB, 5_000_000);
    actionDomain = await getDomain(setup.cawActions);
    chainId = await web3.eth.getChainId();
    const latest = await web3.eth.getBlock('latest');
    futureExpiry = Number(latest.timestamp) + 30 * 86400;
  });

  // ----------------------------------------------------------------
  // Test 1: Wallet-scoped session (profileId=0) still works unchanged
  // ----------------------------------------------------------------
  it('1. wallet-scoped session: register + use on action → success', async function () {
    await registerWalletSession(userA, walletSessionKey, {
      expiry: futureExpiry, scopeBitmap: 0xBF, spendLimit: '5000000', perActionTipRate: 0,
    });
    const sess = await setup.cawProfileLedger.sessions(userA, walletSessionKey);
    expect(Number(sess.profileId)).to.equal(0, 'wallet-scoped: profileId must be 0');
    // Use the session key to sign a CAW action on tokenA
    await processCawAction(tokenA, walletSessionKey, validatorId, actionDomain);
  });

  // ----------------------------------------------------------------
  // Test 2: Token-scoped on right profile → success
  // ----------------------------------------------------------------
  it('2. token-scoped session on correct profile → action succeeds', async function () {
    await registerTokenSession(userA, {
      profileId: tokenA, sessionKey: sessionKeyA, expiry: futureExpiry,
      scopeBitmap: 0xBF, spendLimit: '2000000', perActionTipRate: 0,
    });
    const sess = await setup.cawProfileLedger.sessions(userA, sessionKeyA);
    expect(Number(sess.profileId)).to.equal(tokenA, 'profileId must be tokenA');
    // Action on tokenA using sessionKeyA → should succeed
    await processCawAction(tokenA, sessionKeyA, validatorId, actionDomain);
  });

  // ----------------------------------------------------------------
  // Test 3: Token-scoped on wrong profile → WrongProfileForSession
  // ----------------------------------------------------------------
  it('3. token-scoped session used for wrong profile → WrongProfileForSession', async function () {
    // sessionKeyA is bound to tokenA. Register a second profile under userA.
    // Then try to use sessionKeyA for that second profile.
    this.timeout(60000);
    const tokenA2 = await buyUsername(userA, 'usera2');
    await depositAndAuth(userA, tokenA2, 1_000_000);

    // The existing sessionKeyA is registered under sessions[userA][sessionKeyA] with profileId=tokenA.
    // Use sessionKeyA to sign an action for tokenA2 (same owner, wrong profile).
    await expectRevertWithCustomError(
      processCawAction(tokenA2, sessionKeyA, validatorId, actionDomain),
      'WrongProfileForSession()'
    );
  });

  // ----------------------------------------------------------------
  // Test 4: Transfer clears token-scoped session
  // ----------------------------------------------------------------
  it('4. transfer of tokenA clears its token-scoped session', async function () {
    this.timeout(60000);
    // Register a fresh token-scoped session for tokenA under userA.
    const freshKey = SK_EXTRA; // HH#1
    await registerTokenSession(userA, {
      profileId: tokenA, sessionKey: freshKey, expiry: futureExpiry,
      scopeBitmap: 0xBF, spendLimit: '1000000', perActionTipRate: 0,
    });
    // Confirm it's valid before transfer.
    const sessBefore = await setup.cawProfileLedger.validSession(userA, freshKey);
    expect(Number(sessBefore.expiry)).to.be.greaterThan(0, 'session should be valid before transfer');

    // Transfer tokenA to userB via L1 transferAndSync (LZ mock mirrors to L2).
    const quote = await setup.quoter.syncTransferQuote(tokenA, userB, false);
    await setup.cawProfile.transferAndSync(userB, tokenA, quote.lzTokenFee, {
      from: userA, value: quote.nativeFee.toString(),
    });

    // After transfer, the session should be zeroed (tokenSessionEpoch bumped).
    const sessAfter = await setup.cawProfileLedger.validSession(userA, freshKey);
    expect(Number(sessAfter.expiry)).to.equal(0, 'session must be invalidated after transfer');

    // Transfer tokenA back to userA for subsequent tests.
    const quote2 = await setup.quoter.syncTransferQuote(tokenA, userA, false);
    await setup.cawProfile.transferAndSync(userA, tokenA, quote2.lzTokenFee, {
      from: userB, value: quote2.nativeFee.toString(),
    });
  });

  // ----------------------------------------------------------------
  // Test 5: CL-4 invariant — wallet-scoped session for the TRANSFERRING wallet
  // is invalidated when the wallet transfers any of its tokens. This is the
  // ownerSessionEpoch[prev]++ protection. A separate wallet's session is
  // unaffected.
  // ----------------------------------------------------------------
  it('5. wallet-scoped session for transferring wallet dies; other wallet unaffected', async function () {
    // Test 4 transferred tokenA: userA → userB, then back userB → userA.
    // Each direction bumped ownerSessionEpoch on the FROM side.
    // userA's wallet-scoped session (registered before test 4) should now
    // be invalidated — userA was on the FROM side of both transfers.
    const sessA = await setup.cawProfileLedger.validSession(userA, walletSessionKey);
    expect(Number(sessA.expiry)).to.equal(0,
      'wallet-scoped session for the transferring wallet must be invalidated (CL-4 protection)');

    // Register a fresh wallet-scoped session for userB (who has not transferred
    // anything from outbound in this test sequence — userB only RECEIVED tokenA
    // briefly in test 4 then sent it back, so ownerSessionEpoch[userB] DID bump
    // when userB sent tokenA back. Register AFTER any transfers complete so
    // the session stamps the current epoch.
    const userBWalletKey = SK_EXTRA2;
    await registerWalletSession(userB, userBWalletKey, {
      expiry: futureExpiry, scopeBitmap: 0xBF, spendLimit: '1000000', perActionTipRate: 0,
    });
    const sessB = await setup.cawProfileLedger.validSession(userB, userBWalletKey);
    expect(Number(sessB.expiry)).to.be.greaterThan(0,
      "userB's fresh wallet-scoped session must be valid (registered post-transfers)");
  });

  // ----------------------------------------------------------------
  // Test 6: Token-scoped session can be revoked by owner via revokeSession
  // ----------------------------------------------------------------
  it('6. owner can revoke a token-scoped session via revokeSession()', async function () {
    const revokeKey = SK_EXTRA2; // HH#2
    await registerTokenSession(userA, {
      profileId: tokenA, sessionKey: revokeKey, expiry: futureExpiry,
      scopeBitmap: 0xBF, spendLimit: '1000000', perActionTipRate: 0,
    });
    const sessBefore = await setup.cawProfileLedger.sessions(userA, revokeKey);
    expect(Number(sessBefore.expiry)).to.be.greaterThan(0);

    await setup.cawProfileLedger.revokeSession(revokeKey, { from: userA });

    const sessAfter = await setup.cawProfileLedger.sessions(userA, revokeKey);
    expect(Number(sessAfter.expiry)).to.equal(0, 'session must be deleted after revoke');
  });

  // ----------------------------------------------------------------
  // Test 7: Epoch isolation — two tokens, transfer one, only that session dies
  // ----------------------------------------------------------------
  it('7. epoch isolation: transfer tokenA invalidates its sessions, tokenB sessions unaffected', async function () {
    this.timeout(60000);
    // Register token-scoped sessions for both tokenA and tokenB.
    const keyForA = sessionKeyA; // HH#4, owned by userA
    const keyForB = sessionKeyB; // HH#0, owned by userB

    // Re-register for tokenA (owned by userA).
    await registerTokenSession(userA, {
      profileId: tokenA, sessionKey: keyForA, expiry: futureExpiry,
      scopeBitmap: 0xBF, spendLimit: '1000000', perActionTipRate: 0,
    });
    // Register for tokenB (owned by userB).
    await registerTokenSession(userB, {
      profileId: tokenB, sessionKey: keyForB, expiry: futureExpiry,
      scopeBitmap: 0xBF, spendLimit: '1000000', perActionTipRate: 0,
    });

    // Transfer tokenA to userB.
    const quote = await setup.quoter.syncTransferQuote(tokenA, userB, false);
    await setup.cawProfile.transferAndSync(userB, tokenA, quote.lzTokenFee, {
      from: userA, value: quote.nativeFee.toString(),
    });

    // tokenA session must be dead.
    const sessA = await setup.cawProfileLedger.validSession(userA, keyForA);
    expect(Number(sessA.expiry)).to.equal(0, 'tokenA session must be invalidated after transfer');

    // tokenB session must still be alive.
    const sessB = await setup.cawProfileLedger.validSession(userB, keyForB);
    expect(Number(sessB.expiry)).to.be.greaterThan(0, 'tokenB session must survive tokenA transfer');

    // Restore tokenA ownership for later tests.
    const quote2 = await setup.quoter.syncTransferQuote(tokenA, userA, false);
    await setup.cawProfile.transferAndSync(userA, tokenA, quote2.lzTokenFee, {
      from: userB, value: quote2.nativeFee.toString(),
    });
  });

  // ----------------------------------------------------------------
  // Test 8: Nonce isolation — tokenSessionNonce independent of sessionNonce
  // ----------------------------------------------------------------
  it('8. tokenSessionNonce[A] is independent of sessionNonce[owner]', async function () {
    const ownerNonceBefore = Number(await setup.cawProfileLedger.sessionNonce(userA));
    const tokenNonceBefore = Number(await setup.cawProfileLedger.tokenSessionNonce(tokenA));

    // Register a token-scoped session → bumps tokenSessionNonce, NOT sessionNonce.
    await registerTokenSession(userA, {
      profileId: tokenA, sessionKey: SK_EXTRA, expiry: futureExpiry,
      scopeBitmap: 0xBF, spendLimit: '100', perActionTipRate: 0,
    });

    const ownerNonceAfter = Number(await setup.cawProfileLedger.sessionNonce(userA));
    const tokenNonceAfter = Number(await setup.cawProfileLedger.tokenSessionNonce(tokenA));
    expect(ownerNonceAfter).to.equal(ownerNonceBefore, 'owner sessionNonce must not be bumped by token-scoped registration');
    expect(tokenNonceAfter).to.equal(tokenNonceBefore + 1, 'tokenSessionNonce must increment');

    // Register a wallet-scoped session → bumps sessionNonce, NOT tokenSessionNonce.
    await registerWalletSession(userA, walletSessionKey, {
      expiry: futureExpiry, scopeBitmap: 0xBF, spendLimit: '100', perActionTipRate: 0,
    });
    const ownerNonceAfter2 = Number(await setup.cawProfileLedger.sessionNonce(userA));
    const tokenNonceAfter2 = Number(await setup.cawProfileLedger.tokenSessionNonce(tokenA));
    expect(ownerNonceAfter2).to.equal(ownerNonceAfter + 1, 'sessionNonce must increment on wallet registration');
    expect(tokenNonceAfter2).to.equal(tokenNonceAfter, 'tokenSessionNonce must not change on wallet registration');
  });

  // ----------------------------------------------------------------
  // Test 9: WITHDRAW bit (bit 6) is force-cleared in registerTokenScopedSession
  // ----------------------------------------------------------------
  it('9. WITHDRAW scope bit force-cleared even when scopeBitmap has it set', async function () {
    // Try to register with all bits set (0xFF includes WITHDRAW=bit6).
    await registerTokenSession(userA, {
      profileId: tokenA, sessionKey: SK_EXTRA, expiry: futureExpiry,
      scopeBitmap: 0xFF, spendLimit: '100', perActionTipRate: 0,
    });
    const sess = await setup.cawProfileLedger.sessions(userA, SK_EXTRA);
    // Bit 6 (0x40) must be cleared → stored bitmap = 0xFF & 0xBF = 0xBF
    expect(Number(sess.scopeBitmap)).to.equal(0xBF, 'WITHDRAW bit must be force-cleared');
  });

  // ----------------------------------------------------------------
  // Test 10: Spend limit honored on token-scoped session
  // ----------------------------------------------------------------
  it('10. spend limit is enforced on token-scoped session', async function () {
    // CAW action costs 5000 whole CAW. Set spendLimit below that so second action fails.
    const limitedKey = SK_TOKEN_B; // HH#0 — signs actions off-chain
    await registerTokenSession(userA, {
      profileId: tokenA, sessionKey: limitedKey, expiry: futureExpiry,
      scopeBitmap: 0xBF, spendLimit: '7000', perActionTipRate: 0, // 7000 CAW limit: enough for 1 × 5000 CAW but not 2
    });

    // First action: within limit.
    await processCawAction(tokenA, limitedKey, validatorId, actionDomain);

    // Second action: cumulative spend would be 10000 > 7000 → SessionLimitExceeded.
    await expectRevertWithCustomError(
      processCawAction(tokenA, limitedKey, validatorId, actionDomain),
      'SessionLimitExceeded()'
    );
  });

  // ----------------------------------------------------------------
  // Test 11: registerTokenScopedSession requires owner sig — non-owner reverts BadSig
  // ----------------------------------------------------------------
  it('11. registerTokenScopedSession with non-owner sig reverts BadSig()', async function () {
    const scratchKey = SK_EXTRA2; // HH#2
    const tokenNonce = Number(await setup.cawProfileLedger.tokenSessionNonce(tokenA));
    // Sign as userB (not the owner of tokenA).
    const { v, r, s } = signTokenSessionDelegation(userB, {
      profileId: tokenA, sessionKey: scratchKey, expiry: futureExpiry,
      scopeBitmap: 0xBF, spendLimit: '100', perActionTipRate: 0, nonce: tokenNonce,
    }, setup.cawProfileLedger.address, chainId);

    await expectRevertWithCustomError(
      setup.cawProfileLedger.registerTokenScopedSession(
        tokenA, scratchKey, futureExpiry, 0xBF, '100', 0, tokenNonce, v, r, s
      ),
      'BadSig()'
    );
  });
});
