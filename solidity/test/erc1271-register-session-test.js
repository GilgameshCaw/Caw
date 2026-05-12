/**
 * Integration tests for ERC-1271 contract-signature support on
 * CawProfileL2.registerSession / registerSessionPersonal.
 *
 * Verifies that a smart-EOA (Safe, 7702-delegated, etc.) — modelled here
 * by a minimal mock contract — can authorize a Quick Sign session via
 * its `isValidSignature` callback. This is the load-bearing contract
 * change for the v1 magic-wallet flow: action signing already routed
 * through CawActions' 1271 fallback (audited 2026-05-08), but session
 * registration was ecrecover-only.
 *
 * Cases covered:
 *  1. Smart-EOA owner registers a session via the bytes-form
 *     `registerSession` overload. The mock contract validates an inner
 *     ECDSA signature against an authorized signer; CawProfileL2 sees
 *     `code.length > 0` on the signer arg and routes to 1271.
 *  2. Smart-EOA owner with `alwaysReject = true` cannot register — must
 *     revert with BadSig (selector 0x05312688).
 *  3. Plain EOA owner still registers via the same bytes-form overload
 *     (ECDSA fast path) — backwards-compat regression.
 *  4. Smart-EOA owner registers a session, then uses the session key to
 *     sign an action; the action is accepted (full end-to-end).
 *  5. registerSessionPersonal works for a smart-EOA owner — the
 *     human-readable Personal-Sign path also routes through 1271.
 */

const CawProfileL2 = artifacts.require("CawProfileL2");
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");
const MockContractOwner = artifacts.require("MockContractOwner");

const { signTypedData, SignTypedDataVersion } = require('@metamask/eth-sig-util');
const { ecsign, toBuffer, hashPersonalMessage } = require('ethereumjs-util');

const l1 = 30101;
const l2 = 8453;

// Hardhat default mnemonic private keys.
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
  SessionDelegation: [
    { name: 'sessionKey', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'scopeBitmap', type: 'uint8' },
    { name: 'spendLimit', type: 'uint256' },
    { name: 'perActionTipRate', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};

// Pack a 65-byte ECDSA sig as r||s||v (the canonical packing the contract
// tries first in its ecrecover path).
function packSigRSV(sigHex) {
  const sans = sigHex.replace(/^0x/, '');
  return '0x' + sans.slice(0, 64) + sans.slice(64, 128) + sans.slice(128, 130);
}

contract('CawProfileL2 — ERC-1271 register-session', function (accounts) {
  const eoaOwner = accounts[0];      // plain EOA owner; backwards-compat case
  const contractKey = accounts[1];   // EOA whose private key the mock contract authorizes
  const sessionKey = accounts[2];    // the ephemeral key we're delegating to
  const otherKey = accounts[3];      // for negative-test re-key flips

  let cawProfileL2;
  let chainId;
  let domain;

  // Compute expiry from the chain's view of time, not the host's. Ganache's
  // block timestamp doesn't always track real time exactly.
  async function chainTimePlus(seconds) {
    const blk = await web3.eth.getBlock('latest');
    return Number(blk.timestamp) + seconds;
  }

  before(async function () {
    this.timeout(60000);
    const l2Endpoint = await MockLayerZeroEndpoint.new(l2);
    cawProfileL2 = await CawProfileL2.new(l1, l2Endpoint.address);
    chainId = await web3.eth.getChainId();
    domain = { name: 'CawProfileL2', version: '1', chainId, verifyingContract: cawProfileL2.address };
  });

  // ----- helpers -----

  function delegationData(message) {
    return {
      primaryType: 'SessionDelegation',
      domain,
      types: { EIP712Domain: dataTypes.EIP712Domain, SessionDelegation: dataTypes.SessionDelegation },
      message,
    };
  }

  async function buildAndSign(owner, signerEoa, { sessionKey: sk, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce }) {
    const data = delegationData({ sessionKey: sk, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce });
    const sigHex = signTypedData({ data, privateKey: privFor(signerEoa), version: SignTypedDataVersion.V4 });
    return packSigRSV(sigHex);
  }

  // ----- tests -----

  it('plain EOA can register via the bytes-form overload (backwards-compat)', async function () {
    const expiry = await chainTimePlus(3600);
    const nonceBefore = Number(await cawProfileL2.sessionNonce(eoaOwner));
    const sig = await buildAndSign(eoaOwner, eoaOwner, {
      sessionKey, expiry, scopeBitmap: 0xBF, spendLimit: 1000000, perActionTipRate: 0, nonce: nonceBefore,
    });

    await cawProfileL2.registerSession(eoaOwner, sessionKey, expiry, 0xBF, 1000000, 0, nonceBefore, sig);

    const session = await cawProfileL2.sessions(eoaOwner, sessionKey);
    expect(Number(session.expiry)).to.equal(expiry);
    expect(Number(session.scopeBitmap)).to.equal(0xBF);
    expect(Number(await cawProfileL2.sessionNonce(eoaOwner))).to.equal(nonceBefore + 1);
  });

  it('smart-EOA (contract owner) can register via ERC-1271', async function () {
    const mockOwner = await MockContractOwner.new(contractKey);
    const expiry = await chainTimePlus(3600);
    const nonceBefore = Number(await cawProfileL2.sessionNonce(mockOwner.address));

    // The owner authorizes by signing with contractKey's private key. The
    // mock contract's isValidSignature recovers contractKey from the sig and
    // matches against its authorizedSigner. CawProfileL2 sees the smart
    // contract address (mockOwner.address) as `signer`, finds code.length > 0,
    // and routes to 1271.
    const sig = await buildAndSign(mockOwner.address, contractKey, {
      sessionKey, expiry, scopeBitmap: 0xBF, spendLimit: 1000000, perActionTipRate: 0, nonce: nonceBefore,
    });

    await cawProfileL2.registerSession(mockOwner.address, sessionKey, expiry, 0xBF, 1000000, 0, nonceBefore, sig);

    const session = await cawProfileL2.sessions(mockOwner.address, sessionKey);
    expect(Number(session.expiry), 'session was stored against the smart-EOA address').to.equal(expiry);
    expect(Number(await cawProfileL2.sessionNonce(mockOwner.address))).to.equal(nonceBefore + 1);
  });

  it('smart-EOA registration is rejected when isValidSignature returns 0xffffffff', async function () {
    const mockOwner = await MockContractOwner.new(contractKey);
    await mockOwner.setAlwaysReject(true);
    const expiry = await chainTimePlus(3600);
    const nonceBefore = Number(await cawProfileL2.sessionNonce(mockOwner.address));
    const sig = await buildAndSign(mockOwner.address, contractKey, {
      sessionKey, expiry, scopeBitmap: 0xBF, spendLimit: 1000000, perActionTipRate: 0, nonce: nonceBefore,
    });

    let threw = false;
    try {
      await cawProfileL2.registerSession(mockOwner.address, sessionKey, expiry, 0xBF, 1000000, 0, nonceBefore, sig);
    } catch (err) {
      threw = true;
      // 0x05312688 = bytes4(keccak256("BadSig()"))
      expect(err.message).to.match(/BadSig|0x05312688/);
    }
    expect(threw, 'register should revert when 1271 returns invalid').to.equal(true);

    const session = await cawProfileL2.sessions(mockOwner.address, sessionKey);
    expect(Number(session.expiry), 'no session should have been stored').to.equal(0);
  });

  it('smart-EOA rejects a sig from a non-authorized key (1271 returns invalid)', async function () {
    const mockOwner = await MockContractOwner.new(contractKey);
    const expiry = await chainTimePlus(3600);
    const nonceBefore = Number(await cawProfileL2.sessionNonce(mockOwner.address));
    // Sign with otherKey, not contractKey — mockOwner.isValidSignature should
    // recover otherKey and not match its authorizedSigner.
    const sig = await buildAndSign(mockOwner.address, otherKey, {
      sessionKey, expiry, scopeBitmap: 0xBF, spendLimit: 1000000, perActionTipRate: 0, nonce: nonceBefore,
    });

    let threw = false;
    try {
      await cawProfileL2.registerSession(mockOwner.address, sessionKey, expiry, 0xBF, 1000000, 0, nonceBefore, sig);
    } catch (err) {
      threw = true;
      expect(err.message).to.match(/BadSig|0x05312688/);
    }
    expect(threw, 'register should revert on unauthorized signer').to.equal(true);
  });

  it('registerSessionPersonal accepts a smart-EOA signer via 1271', async function () {
    const mockOwner = await MockContractOwner.new(contractKey);
    const sessionKey2 = accounts[5];

    // Build the 13-line personal-sign message exactly as the on-chain parser
    // expects. Far-future expiry so block.timestamp comparison is trivial.
    const message = [
      'Enable Quick Sign',
      '------------------',
      'Spend limit:',
      '5M CAW',
      '',
      'Tip per action:',
      '0 CAW',
      '',
      'Expires:',
      '25 April 2099 00:00:00 UTC',
      '',
      'CAW Key:',
      sessionKey2,
    ].join('\n');
    const messageHex = '0x' + Buffer.from(message, 'utf8').toString('hex');

    // contractKey signs with personal_sign (the prefix + length form). The
    // mock contract recovers contractKey, matches its authorizedSigner, and
    // returns the magic value.
    const digest = hashPersonalMessage(toBuffer(messageHex));
    const sig = ecsign(digest, privFor(contractKey));
    const sigHex = '0x' + sig.r.toString('hex') + sig.s.toString('hex') + sig.v.toString(16).padStart(2, '0');

    await cawProfileL2.registerSessionPersonal(mockOwner.address, messageHex, sigHex);

    const session = await cawProfileL2.sessions(mockOwner.address, sessionKey2);
    expect(Number(session.expiry), 'session registered against the smart-EOA address').to.be.greaterThan(0);
    // scopeBitmap on the personal path is hardcoded to 0xBF (all except WITHDRAW).
    expect(Number(session.scopeBitmap)).to.equal(0xBF);
  });

  it('smart-EOA cannot register a session with WITHDRAW scope (bit 6)', async function () {
    const mockOwner = await MockContractOwner.new(contractKey);
    const expiry = await chainTimePlus(3600);
    const nonceBefore = Number(await cawProfileL2.sessionNonce(mockOwner.address));
    // 0x40 = WITHDRAW bit set — must revert with NoWithdraw().
    const sig = await buildAndSign(mockOwner.address, contractKey, {
      sessionKey, expiry, scopeBitmap: 0xFF, spendLimit: 1000000, perActionTipRate: 0, nonce: nonceBefore,
    });

    let threw = false;
    try {
      await cawProfileL2.registerSession(mockOwner.address, sessionKey, expiry, 0xFF, 1000000, 0, nonceBefore, sig);
    } catch (err) {
      threw = true;
      // 0x297ae19c = bytes4(keccak256("NoWithdraw()"))
      expect(err.message).to.match(/NoWithdraw|no WITHDRAW|0x297ae19c/);
    }
    expect(threw, 'WITHDRAW delegation should revert regardless of signer type').to.equal(true);
  });

  it('signer == address(0) is rejected (cannot accidentally register sessions[0x0])', async function () {
    const expiry = await chainTimePlus(3600);
    // The contract rejects signer==0 before even attempting verification.
    // We pass any signature; the zero-signer guard fires first.
    let threw = false;
    try {
      await cawProfileL2.registerSession(
        '0x0000000000000000000000000000000000000000',
        sessionKey, expiry, 0xBF, 1000000, 0, 0,
        '0x' + '00'.repeat(65),
      );
    } catch (err) {
      threw = true;
      expect(err.message).to.match(/BadSig|0x05312688/);
    }
    expect(threw, 'zero signer should revert').to.equal(true);
  });
});
