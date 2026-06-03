// Truffle library linker — deploys SessionMessageParser and patches its
// address into CawProfileLedger bytecode before any CawProfileLedger.new()
// call. Idempotent: caches the deployed instance across calls so the linker
// only deploys once even when multiple setup helpers invoke it.
//
// KNOWN ISSUE (task #195): with the bundled truffle@5.11.5 in this repo,
// `.link()` AND direct bytecode patching both succeed in clearing the
// placeholder from `CawProfileLedger.bytecode` / `.binary`, but the
// subsequent `CawProfileLedger.new(...)` STILL throws "contains unresolved
// libraries". Suspected cause: truffle recompiles via its own bundled solc
// at test-run start and re-loads the artifact between hook calls.
//
// Foundry tests at solidity/test-foundry/*.t.sol are unaffected (foundry
// auto-links library symbols from artifact metadata). The deploy script
// `solidity/scripts/deploy.js` IS fully working — it deploys
// SessionMessageParser as a phase-1 contract and resolves the placeholder
// via `linkLibraries` config + bytecode patch before `factory.deploy`.
const SessionMessageParser = artifacts.require("SessionMessageParser");
const CawProfileLedger = artifacts.require("CawProfileLedger");

const PLACEHOLDER = "__SessionMessageParser__________________"; // 40 chars

let cachedLib = null;

async function linkSessionMessageParser() {
  if (!cachedLib) cachedLib = await SessionMessageParser.new();
  // Two-step link: (a) register via truffle's link API so it tracks the
  // address in network.links; (b) directly patch the bytecode storage so
  // any path that re-derives from `_json.bytecode` also sees the address.
  // The redundancy is intentional — truffle's checkLibraries flow has been
  // observed to bypass `binary` substitution in some configurations.
  await CawProfileLedger.detectNetwork();
  try {
    await CawProfileLedger.link("SessionMessageParser", cachedLib.address);
  } catch { /* fall through to bytecode patch */ }
  const addrNo0x = cachedLib.address.slice(2);
  for (const target of [CawProfileLedger, CawProfileLedger._json]) {
    if (target && target.bytecode && target.bytecode.includes(PLACEHOLDER)) {
      target.bytecode = target.bytecode.split(PLACEHOLDER).join(addrNo0x);
    }
    if (target && target.deployedBytecode && target.deployedBytecode.includes(PLACEHOLDER)) {
      target.deployedBytecode = target.deployedBytecode.split(PLACEHOLDER).join(addrNo0x);
    }
  }
  return cachedLib;
}

module.exports = { linkSessionMessageParser };
