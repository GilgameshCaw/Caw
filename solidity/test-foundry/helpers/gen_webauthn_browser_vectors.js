// Real-Chromium WebAuthn vectors for SmartEOAWebAuthnBrowser.t.sol.
// Ceremony options copy FrontEnd/src/services/identity/passkey.ts
// (enrollPasskey / signWithPasskey). Uses a CDP virtual authenticator.
// Usage (from solidity/):
//   node test-foundry/helpers/gen_webauthn_browser_vectors.js \
//     <path to playwright-core> test-foundry/vectors/browser-webauthn.json
// Needs a Chromium that playwright-core can launch.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.resolve(process.argv[2]));
const OUT = process.argv[3];

// Fixed digest; the forge test uses the same value.
const DIGEST = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';

async function main() {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>t</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: true });
  const out = { browser: browser.version(), digest: '0x' + DIGEST, cases: {} };

  // name -> virtual authenticator UV state + userVerification requested by the page
  const cases = {
    uv_required: { hasUV: true, uv: 'required', rk: 'required' },        // what the FE does
    // Authenticator without UV (e.g. a security key with no PIN): UV=0 assertion.
    uv_discouraged: { hasUV: false, uv: 'discouraged', rk: 'discouraged' },
  };

  for (const [name, c] of Object.entries(cases)) {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
        hasUserVerification: c.hasUV, isUserVerified: c.hasUV,
        automaticPresenceSimulation: true,
      },
    });
    const r = await page.evaluate(async ({ digestHex, uv, rk }) => {
      const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
      const cred = await navigator.credentials.create({ publicKey: {
        rp: { name: 'localhost', id: 'localhost' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'w', displayName: 'w' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: rk, requireResidentKey: rk === 'required', userVerification: uv },
        attestation: 'none',
      } });
      const spki = new Uint8Array(cred.response.getPublicKey());
      const xy = spki.slice(spki.length - 64);
      const challenge = new Uint8Array(digestHex.match(/../g).map((h) => parseInt(h, 16)));
      const a = await navigator.credentials.get({ publicKey: {
        challenge, rpId: 'localhost',
        allowCredentials: [{ type: 'public-key', id: cred.rawId }],
        userVerification: uv,
      } });
      return {
        pubX: hex(xy.slice(0, 32)), pubY: hex(xy.slice(32)),
        authenticatorData: hex(a.response.authenticatorData),
        clientDataJSON: hex(a.response.clientDataJSON),
        clientDataJSONText: new TextDecoder().decode(a.response.clientDataJSON),
        derSig: hex(a.response.signature),
      };
    }, { digestHex: DIGEST, uv: c.uv, rk: c.rk });

    const { r: rr, s: ss } = derToRS(Buffer.from(r.derSig, 'hex'));
    const flags = parseInt(r.authenticatorData.slice(64, 66), 16);
    out.cases[name] = {
      pubX: '0x' + r.pubX, pubY: '0x' + r.pubY,
      authenticatorData: '0x' + r.authenticatorData,
      clientDataJSON: '0x' + r.clientDataJSON,
      r: '0x' + rr, s: '0x' + ss,
      flags, clientDataJSONText: r.clientDataJSONText,
    };
    await page.close();
  }
  await browser.close();
  server.close();
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  for (const [n, c] of Object.entries(out.cases)) {
    console.log(n, 'flags=0x' + c.flags.toString(16).padStart(2, '0'), c.clientDataJSONText);
  }
  console.log('browser', out.browser);
}

// ASN.1 DER ECDSA sig -> 32-byte r, s (hex)
function derToRS(der) {
  let i = 2;
  const read = () => {
    if (der[i] !== 0x02) throw new Error('bad DER');
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    return Buffer.concat([Buffer.alloc(32 - v.length), v]).toString('hex');
  };
  return { r: read(), s: read() };
}

main().catch((e) => { console.error(e); process.exit(1); });
