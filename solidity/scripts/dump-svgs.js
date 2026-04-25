// Deploys CawFontDataA, CawFontDataB, CawProfileURI to the in-process Hardhat
// node and dumps the raw (decoded) SVG for a list of test names to
// /tmp/caw-svgs/<name>.svg.
//
// Run with:  npx hardhat run scripts/dump-svgs.js

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const hre = require('hardhat');

const NAMES = [
  'a', 'f', 'l', 'ab', 'gilgamesh', 'satoshi', 'vitalik',
  'longestname123', 'aaaaaaaaaaaaaa', 'illliilli',
  'ff', 'offy', 'bitcoin', 'ethereum', 'zzzzzz',
];

function loadArtifact(name) {
  const p = path.join(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  await hre.run('compile');

  const provider = new ethers.BrowserProvider({
    request: async ({ method, params }) => hre.network.provider.send(method, params),
  });
  const signer = await provider.getSigner(0);

  async function deploy(name, args = []) {
    const art = loadArtifact(name);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
    const c = await factory.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  const a = await deploy('CawFontDataA');
  const b = await deploy('CawFontDataB');
  const uri = await deploy('CawProfileURI', [await a.getAddress(), await b.getAddress()]);

  const outDir = '/tmp/caw-svgs';
  fs.mkdirSync(outDir, { recursive: true });

  for (const name of NAMES) {
    const data = await uri.generate(name);
    const jsonB64 = data.replace('data:application/json;base64,', '');
    const json = JSON.parse(Buffer.from(jsonB64, 'base64').toString());
    const svgB64 = json.image.replace('data:image/svg+xml;base64,', '');
    const svg = Buffer.from(svgB64, 'base64').toString();
    fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
    console.log(`wrote ${name}.svg (${svg.length} bytes)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
