const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { Contract } = require(process.env.CAW_ETHERS_PACKAGE || 'ethers');
const source = fs.readFileSync(path.resolve(__dirname, '../../client/src/services/ChainSyncService/index.ts'), 'utf8');
const original = source.slice(source.indexOf('const NETWORK_FEE_EVENT_ABI ='), source.indexOf('// Task Management'));
const start = 'async function getLastSyncedL1FeeBlock()';
const end = 'async function setLastSyncedL1FeeBlock(';
let combined = null;
if (process.env.CAW_CURSOR_SOURCE) {
  const other = fs.readFileSync(process.env.CAW_CURSOR_SOURCE, 'utf8');
  combined = original.slice(0, original.indexOf(start)) + other.slice(other.indexOf(start), other.indexOf(end)) + original.slice(original.indexOf(end));
}
function harness(block, { missing = false, readFailure = false, saveFailure = false } = {}) {
  let cursor = 10, failRead = readFailure, failSave = saveFailure, saves = 0;
  const ranges = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    NETWORK_MANAGER_ADDRESS: '0x1111111111111111111111111111111111111111',
    l1Provider: { getBlockNumber: async () => 60020 },
    prisma: { chainData: {
      findUnique: async () => {
        if (failRead) throw Error('synthetic cursor read failure');
        return missing && saves === 0 ? null : { value: { block: cursor } };
      },
      upsert: async input => {
        if (failSave) throw Error('synthetic checkpoint write failure');
        cursor = input.update.value.block;
        saves++;
      }
    } },
    Contract: function (address, abi) {
      const contract = new Contract(address, abi);
      contract.queryFilter = async (_filter, from, to) => { ranges.push([from, to]); return []; };
      return contract;
    }
  });
  vm.runInContext(stripTypeScriptTypes(block) + '\nglobalThis.run = syncL1FeeEvents;', context);
  return { run: () => context.run(), recover: () => { failRead = failSave = false; },
    state: () => ({ cursor, saves, ranges: [...ranges] }) };
}
test('baseline read failure bootstraps beyond stored cursor', async () => {
  const h = harness(original, { readFailure: true });
  await h.run();
  assert.deepEqual(h.state().ranges[0], [10021, 12020]);
  assert.equal(h.state().cursor, 60020);
});
test('failed checkpoint write retains cursor and retries the same empty range', async () => {
  const h = harness(original, { saveFailure: true });
  await h.run();
  assert.equal(h.state().cursor, 10);
  assert.equal(h.state().saves, 0);
  assert.equal(h.state().ranges.length, 6);
  h.recover();
  await h.run();
  assert.deepEqual(h.state().ranges[0], h.state().ranges[6]);
  assert.equal(h.state().cursor, 60020);
});
test('genuine absent row uses existing lookback bootstrap', async () => {
  const h = harness(original, { missing: true });
  await h.run();
  assert.deepEqual(h.state().ranges[0], [10021, 12020]);
});
for (const [name, enabled] of [['combined read failure makes no RPC query or checkpoint write', !!combined], ['combined absent row retains bootstrap behavior', !!combined]]) {
  test(name, { skip: !enabled }, async () => {
    const missing = name.includes('absent');
    const h = harness(combined, { missing, readFailure: !missing });
    if (missing) {
      await h.run();
      assert.deepEqual(h.state().ranges[0], [10021, 12020]);
    } else {
      await assert.rejects(h.run(), /synthetic cursor read failure/);
      assert.equal(h.state().ranges.length, 0);
      assert.equal(h.state().cursor, 10);
      assert.equal(h.state().saves, 0);
      h.recover();
      await h.run();
      assert.deepEqual(h.state().ranges[0], [11, 2010]);
      assert.equal(h.state().cursor, 60020);
    }
  });
}
