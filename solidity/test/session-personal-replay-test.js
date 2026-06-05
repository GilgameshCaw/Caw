/**
 * Regression: registerSessionPersonal must reject replays of the same
 * personal-sign payload.
 *
 * The personal-sign message has a fixed-shape (13 lines, no nonce), so
 * without explicit replay protection, a held signature could be
 * re-submitted to undo a revocation. Audit fix 2026-05-08 (Issue L2-2):
 * the contract now tracks consumed digests in `consumedSessionMessage`.
 *
 * This test:
 *   1. Builds a valid personal-sign payload (a wallet authorising a
 *      session key for some expiry).
 *   2. Submits it — session is registered.
 *   3. Revokes the session.
 *   4. Re-submits the SAME signed message.
 *   5. Asserts revert with "Message already consumed".
 *
 * Without the fix, step 5 would succeed and the revoked session would be
 * live again until the message's expiry.
 */
const MockLayerZeroEndpoint = artifacts.require("MockLayerZeroEndpoint");
const CawProfileLedger = artifacts.require("CawProfileLedger");

const { linkSessionMessageParser } = require('./helpers/link-libraries');

const { ecsign, toBuffer, hashPersonalMessage } = require('ethereumjs-util');

const l1 = 30101;
const l2 = 8453;

const testKeys = {
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex'),
};

contract('CawProfileLedger — registerSessionPersonal replay protection', function (accounts) {
  const owner = accounts[0]; // MUST match a key in testKeys (Hardhat default[0])
  const sessionKey = '0x1234567890abcdef1234567890abcdef12345678';

  let cawProfileLedger;

  before(async function () {
    const l2Endpoint = await MockLayerZeroEndpoint.new(l2);
    await linkSessionMessageParser();
    cawProfileLedger = await CawProfileLedger.new(l1, l2Endpoint.address, "0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000bEEF", "0x000000000000000000000000000000000000dEAD", "0x000000000000000000000000000000000000cAFE", false, accounts[0]);
  });

  function buildPersonalMessage() {
    // Format: 13 lines exactly matching the parser in _parseSessionMessage.
    // Use a far-future expiry so block.timestamp never passes it during the test.
    return [
      'Enable Quick Sign',
      '------------------',
      'Spend limit:',
      '5M CAW',
      '',
      'Tip per action:',
      '1000 CAW',
      '',
      'Expires:',
      '25 April 2099 00:00:00 UTC',
      '',
      'CAW Key:',
      sessionKey,
    ].join('\n');
  }

  function signPersonal(message, privKey) {
    const digest = hashPersonalMessage(toBuffer('0x' + Buffer.from(message, 'utf8').toString('hex')));
    const sig = ecsign(digest, privKey);
    // Pack as r||s||v for the bytes-form registerSessionPersonal overload.
    const v = sig.v.toString(16).padStart(2, '0');
    return '0x' + sig.r.toString('hex') + sig.s.toString('hex') + v;
  }

  it('first submission registers the session, second reverts as already-consumed', async function () {
    const message = buildPersonalMessage();
    const messageHex = '0x' + Buffer.from(message, 'utf8').toString('hex');
    const privKey = testKeys[owner.toLowerCase()];
    const sigHex = signPersonal(message, privKey);

    // First submission — session registered.
    await cawProfileLedger.registerSessionPersonal(owner, messageHex, sigHex);
    const session = await cawProfileLedger.sessions(owner, sessionKey);
    expect(Number(session.expiry), 'session is registered after first call').to.be.greaterThan(0);

    // User revokes (any reason).
    await cawProfileLedger.revokeSession(sessionKey, { from: owner });
    const revoked = await cawProfileLedger.sessions(owner, sessionKey);
    expect(Number(revoked.expiry), 'session zeroed after revoke').to.equal(0);

    // Replay the SAME signed message — must revert. The custom error is
    // `Replayed()` (was the "replay" require-string before the v1-passkey
    // refactor). Older clients still surface the selector hex in the message.
    let reverted = false;
    let reason = '';
    try {
      await cawProfileLedger.registerSessionPersonal(owner, messageHex, sigHex);
    } catch (err) {
      reverted = true;
      reason = (err.message || '').toLowerCase();
    }
    expect(reverted, 'replay should revert').to.equal(true);
    // Match either the custom error name (when truffle/ganache decodes it) or
    // the raw selector 0xf6c62c02 = bytes4(keccak256("Replayed()")).
    expect(reason).to.match(/replay|replayed|0xf6c62c02/);

    // Confirm session stayed revoked.
    const stillRevoked = await cawProfileLedger.sessions(owner, sessionKey);
    expect(Number(stillRevoked.expiry), 'session must remain zero after replay attempt').to.equal(0);
  });
});
