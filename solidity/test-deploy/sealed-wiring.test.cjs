'use strict';

// Dependency-free runner tests. Execute the real step table and phase runner,
// with contract/RPC boundaries replaced by deterministic doubles. Never run main.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ZERO = '0x' + '00'.repeat(20);
const address = n => '0x' + n.toString(16).padStart(40, '0');
const padded = value => '0x' + value.slice(2).padStart(64, '0');
const deny = () => { throw new Error('External I/O is disabled in this test'); };

for (const chain of ['L1', ...load().L2_CHAIN_KEYS]) {
  for (const [kind, getter] of [['CawProfileLedger', 'cawActions'], ['CawProfileLedger', 'capOracle'],
    ['CawProfileLedger', 'erc1271Sibling'], ['CawCapOracle', 'cawActions']]) {
    for (const failure of ['read', 'mismatch', 'handle']) {
      test(`constructor ${chain} ${kind}.${getter} ${failure} blocks every finalizer`, async () => {
        const f = fixture();
        assert.ok(chain === 'L1' || f.api.L2_CHAIN_KEYS.includes(chain));
        const key = `${kind}_${chain}`;
        if (failure === 'handle') delete f.contracts[key];
        else f.fault.set(`${key}:${getter}`, () => {
          if (failure === 'read') throw new Error('RPC unavailable');
          return address(999);
        });
        await assert.rejects(f.d.deployPhase(7), error => error.name === 'FatalDeployError');
        assert.equal(f.seals().length, 0);
      });
    }
  }
  for (const kind of ['CawProfileLedger', 'CawCapOracle', 'CawActions', 'CawActionsERC1271']) {
    test(`constructor missing ${kind}_${chain} blocks every finalizer`, async () => {
      const f = fixture();
      delete f.d.state.addresses[`${kind}_${chain}`];
      await assert.rejects(f.d.deployPhase(7), error => error.name === 'FatalDeployError');
      assert.equal(f.seals().length, 0);
    });
  }
}

test('constructor earlier nonce read failure aborts sealed generation', async () => {
  const f = fixture();
  const step = f.api.LINKING_STEPS.find(s => s.chain === 'L2' && /nonce-prediction check/.test(s.name));
  f.fault.set('CawProfileLedger_L2:cawActions', () => { throw new Error('RPC unavailable'); });
  const execute = f.d.executeLink;
  f.d.executeLink = item => item === step || item.phase === 7 ? execute.call(f.d, item) : Promise.resolve();
  await assert.rejects(async () => { await f.d.deployPhase(1); await f.d.deployPhase(7); }, error => error.name === 'FatalDeployError');
  assert.equal(f.seals().length, 0);
});

test('constructor checks do not read bindings in unsealed development', async () => {
  const f = fixture(false);
  for (const key of f.slots.keys()) {
    if (/:cawActions$|:capOracle$|:erc1271Sibling$/.test(key)) {
      f.fault.set(key, () => assert.fail('unsealed binding read'));
    }
  }
  await f.d.deployPhase(7);
  assert.equal(f.seals().length, 0);
  assert.equal(f.events.filter(e => /:cawActions$|:capOracle$|:erc1271Sibling$/.test(e)).length, 0);
});

function load() {
  const scripts = path.resolve(__dirname, '../scripts');
  const file = process.env.CAW_DEPLOY_TEST_SOURCE || path.join(scripts, 'deploy.js');
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const entrypoint = "\nmain().catch(e => {\n  console.error('\\nDeployment failed:', e);\n  process.exit(1);\n});\n";
  assert.ok(source.endsWith(entrypoint), 'Deployment entrypoint changed: review test isolation');
  const blocked = new Proxy({}, { get: () => deny });
  const context = {
    module: { exports: {} }, __dirname: scripts,
    process: { env: {}, argv: [], exit: deny },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'path') return path;
      if (name === 'ethers') return { ethers: new Proxy({
        ZeroAddress: ZERO,
        zeroPadValue(value, bytes) {
          assert.equal(bytes, 32);
          assert.match(value, /^0x[0-9a-fA-F]{40}$/);
          return padded(value);
        },
      }, { get: (object, key) => key in object ? object[key] : deny }) };
      if (name === 'fs' || name === 'child_process') return blocked;
      if (name === 'dotenv') return { config() {} };
      if (name === './lz-dvn-config') return { configureLzDvns: deny };
      if (name === '../test/zk-fixtures/groth16-fixture.json') {
        return JSON.parse(fs.readFileSync(path.resolve(scripts, name), 'utf8'));
      }
      throw new Error(`Unexpected deployment dependency: ${name}`);
    },
  };
  vm.runInNewContext(source.slice(0, -entrypoint.length) +
    '\nmodule.exports = {MultiChainDeployer, LINKING_STEPS, CONTRACTS, CHAINS, L2_CHAIN_KEYS, FatalDeployError};',
  context, { filename: file, timeout: 1000 });
  return context.module.exports;
}

function fixture(sealed = true) {
  const api = load();
  const d = Object.create(api.MultiChainDeployer.prototype);
  const addresses = Object.fromEntries(Object.keys(api.CONTRACTS).map((key, i) => [key, address(i + 1)]));
  const slots = new Map();
  const contracts = {};
  const events = [];
  const fault = new Map();
  const read = async key => {
    events.push(`read:${key}`);
    if (fault.has(key)) return fault.get(key)();
    assert.ok(slots.has(key), `Unexpected contract read: ${key}`);
    return slots.get(key);
  };
  const receipt = { status: 1, blockNumber: 12 };
  const write = async (key, value) => {
    events.push(`write:${key}`);
    if (fault.has(`write:${key}`)) return fault.get(`write:${key}`)();
    slots.set(key, value);
    return { hash: '0x' + 'ab'.repeat(32), wait: async () => receipt };
  };
  for (const key of Object.keys(addresses)) {
    contracts[key] = {
      cawActions: () => read(`${key}:cawActions`),
      capOracle: () => read(`${key}:capOracle`),
      erc1271Sibling: () => read(`${key}:erc1271Sibling`),
      cawProfile: () => read(`${key}:cawProfile`),
      minter: () => read(`${key}:minter`),
      peers: eid => read(`${key}:peers:${eid}`),
      owner: () => read(`${key}:owner`),
      setCawProfile: value => write(`${key}:cawProfile`, value),
      setMinter: value => write(`${key}:minter`, value),
      setPeer: (eid, value) => write(`${key}:peers:${eid}`, value),
      transferOwnership: value => write(`${key}:owner`, value),
      finalizeBootstrap: async () => {
        events.push(`seal:${key}`);
        return write(`${key}:owner`, ZERO);
      },
    };
  }
  for (const key of ['CawNetworkManager', 'CawBuyAndBurn']) slots.set(`${key}:cawProfile`, addresses.CawProfile);
  for (const key of ['CawNetworkManager', 'CawProfile']) slots.set(`${key}:minter`, addresses.CawProfileMinter);
  for (const chain of ['L1', ...api.L2_CHAIN_KEYS]) slots.set(`PathwayExpander_${chain}:owner`, address(999));
  for (const chain of ['L1', ...api.L2_CHAIN_KEYS]) {
    slots.set(`CawProfileLedger_${chain}:cawActions`, addresses[`CawActions_${chain}`]);
    slots.set(`CawProfileLedger_${chain}:capOracle`, addresses[`CawCapOracle_${chain}`]);
    slots.set(`CawProfileLedger_${chain}:erc1271Sibling`, addresses[`CawActionsERC1271_${chain}`]);
    slots.set(`CawCapOracle_${chain}:cawActions`, addresses[`CawActions_${chain}`]);
  }
  for (const chain of api.L2_CHAIN_KEYS) {
    slots.set(`CawProfileLedger_${chain}:peers:${api.CHAINS.testnetL1.lzEid}`, padded(addresses.CawProfile));
    slots.set(`CawProfile:peers:${api.CHAINS['testnet' + chain].lzEid}`, padded(addresses[`CawProfileLedger_${chain}`]));
    for (const kind of ['CawChallengeRelay', 'CawActionsArchive']) {
      slots.set(`${kind}_${chain}:owner`, addresses[`PathwayExpander_${chain}`]);
    }
    for (const other of api.L2_CHAIN_KEYS) {
      if (other === chain) continue;
      slots.set(`CawChallengeRelay_${chain}:peers:${api.CHAINS['testnet' + other].lzEid}`, padded(addresses[`CawActionsArchive_${other}`]));
      slots.set(`CawActionsArchive_${other}:peers:${api.CHAINS['testnet' + chain].lzEid}`, padded(addresses[`CawChallengeRelay_${chain}`]));
    }
  }
  d.state = { addresses, linking: {}, finalizations: {} };
  d.env = 'testnet';
  d.finalizeBootstrapRequested = sealed;
  d.getChainKey = chain => 'testnet' + chain;
  d.initChain = async () => {};
  d.getContract = key => contracts[key];
  d.retry = operation => operation();
  d.deploy = async () => {};
  d.saveState = () => events.push('save');
  const actualExecute = d.executeLink;
  // All required Phase-7 steps use the real implementation. Optional network
  // broadcasts/approvals deliberately fail, exercising the runner's distinction.
  d.executeLink = async function (step) {
    if (step.phase === 7 && step.sealedRequired !== true) {
      events.push(`optional:${step.name}`);
      throw new Error('Optional broadcast/approval unavailable');
    }
    return actualExecute.call(this, step);
  };
  const bootstrap = api.LINKING_STEPS.filter(step =>
    (step.phase === 2 && ['CawNetworkManager', 'CawBuyAndBurn'].includes(step.contract) &&
      ['setCawProfile', 'setMinter'].includes(step.method)) ||
    (step.phase === 5 && step.method === 'setPeer'));
  const proofs = api.LINKING_STEPS.filter(step => /\(sealed (wiring|mesh) read-back\)/.test(step.name));
  const seals = () => events.filter(event => event.startsWith('seal:'));
  return { api, d, contracts, slots, fault, events, bootstrap, proofs, seals, receipt };
}

test('all bootstrap setters and every directed mesh link are required before sealing', () => {
  const f = fixture();
  assert.equal(f.bootstrap.length, 3 + 2 * f.api.L2_CHAIN_KEYS.length * (f.api.L2_CHAIN_KEYS.length - 1));
  for (const step of f.bootstrap) assert.equal(f.d.isSealedRequiredStep(step), true, step.name);
  assert.equal(f.proofs.length, 2 + 2 * f.api.L2_CHAIN_KEYS.length * (f.api.L2_CHAIN_KEYS.length - 1));
});

for (const index of Array.from({ length: fixture().bootstrap.length }, (_, i) => i)) {
  for (const failure of ['missing-address', 'missing-handle', 'read-failure', 'setter-failure']) {
    test(`bootstrap ${index + 1}: ${failure} aborts before Phase 7`, async () => {
      const f = fixture();
      const step = f.bootstrap[index];
      const args = step.args(f.d.state, { env: f.d.env, ...f.api.CHAINS[f.d.getChainKey(step.chain)] });
      const key = `${step.contract}:${step.method === 'setPeer' ? 'peers:' + args[0] : step.method === 'setMinter' ? 'minter' : 'cawProfile'}`;
      if (failure === 'missing-address') delete f.d.state.addresses[step.contract];
      if (failure === 'missing-handle') delete f.contracts[step.contract];
      if (failure === 'read-failure') f.fault.set(key, () => { throw new Error('RPC read unavailable'); });
      if (failure === 'setter-failure') {
        f.slots.set(key, step.method === 'setPeer' ? padded(ZERO) : ZERO);
        f.fault.set(`write:${key}`, () => { throw new Error('Transaction rejected'); });
      }
      await assert.rejects(async () => {
        // Keep the real phase error/barrier behavior; isolate this one bootstrap
        // step from unrelated deployment operations, which are not under test.
        const actual = f.d.executeLink;
        f.d.executeLink = item => item === step || item.phase === 7 ? actual.call(f.d, item) : Promise.resolve();
        await f.d.deployPhase(step.phase);
        await f.d.deployPhase(7);
      }, error => error.name === 'FatalDeployError');
      assert.equal(f.seals().length, 0);
      if (failure === 'read-failure') assert.equal(f.events.filter(event => event.startsWith('write:')).length, 0);
    });
  }
}

for (const consumer of ['CawNetworkManager', 'CawBuyAndBurn']) {
  for (const getter of consumer === 'CawNetworkManager' ? ['cawProfile', 'minter'] : ['cawProfile']) {
    test(`${consumer}.${getter}: an incorrect non-zero one-shot slot cannot count as completed`, async () => {
      const f = fixture();
      f.slots.set(`${consumer}:${getter}`, address(999));
      const method = getter === 'minter' ? 'setMinter' : 'setCawProfile';
      const step = f.bootstrap.find(step => step.contract === consumer && step.method === method);
      await assert.rejects(f.d.executeLink(step), /BOOTSTRAP WIRING MISMATCH/);
      assert.equal(f.events.filter(event => event.startsWith('write:')).length, 0);
    });
  }
}

for (const index of Array.from({ length: fixture().bootstrap.length }, (_, i) => i)) {
  test(`bootstrap ${index + 1}: successful receipt without the expected state cannot seal`, async () => {
    const f = fixture();
    const step = f.bootstrap[index];
    const args = step.args(f.d.state, { env: f.d.env, ...f.api.CHAINS[f.d.getChainKey(step.chain)] });
    const key = `${step.contract}:${step.method === 'setPeer' ? 'peers:' + args[0] : step.method === 'setMinter' ? 'minter' : 'cawProfile'}`;
    f.slots.set(key, step.method === 'setPeer' ? padded(ZERO) : ZERO);
    f.fault.set(`write:${key}`, async () => ({
      hash: '0x' + 'cd'.repeat(32), wait: async () => ({ status: 1, blockNumber: 11 }),
    }));
    await f.d.executeLink(step);
    await assert.rejects(f.d.deployPhase(7), error => error.name === 'FatalDeployError');
    assert.equal(f.seals().length, 0);
  });
}

test('missing expected minter address prevents sealing even when both consumer handles exist', async () => {
  const f = fixture();
  delete f.d.state.addresses.CawProfileMinter;
  await assert.rejects(f.d.deployPhase(7), /Required sealed deployment step condition not met/);
  assert.equal(f.seals().length, 0);
});

const proofKeys = [
  'CawNetworkManager:minter', 'CawProfile:minter',
  ...fixture().slots.keys(),
].filter((key, i, all) => all.indexOf(key) === i &&
  (key.endsWith(':minter') || /^Caw(ChallengeRelay|ActionsArchive)_.+:peers:/.test(key)));

for (const key of proofKeys) {
  for (const failure of ['zero', 'wrong', 'read-failure', 'missing-address', 'missing-handle']) {
    test(`pre-seal ${key}: ${failure} prevents every finalizer`, async () => {
      const f = fixture();
      const source = key.split(':')[0];
      if (failure === 'zero' || failure === 'wrong') {
        const value = failure === 'zero' ? ZERO : address(999);
        f.slots.set(key, key.includes(':peers:') ? padded(value) : value);
      }
      if (failure === 'read-failure') f.fault.set(key, () => { throw new Error('RPC read unavailable'); });
      if (failure === 'missing-address') delete f.d.state.addresses[source];
      if (failure === 'missing-handle') delete f.contracts[source];
      await assert.rejects(f.d.deployPhase(7), error => error.name === 'FatalDeployError');
      assert.equal(f.seals().length, 0);
      assert.equal(Object.keys(f.d.state.finalizations).length, 0);
    });
  }
}

test('correct wiring seals only after every chain finishes its read-backs; optional failures do not gate it', async () => {
  const f = fixture();
  const key = proofKeys.find(key => key.includes(':peers:'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reached;
  const entered = new Promise(resolve => { reached = resolve; });
  f.fault.set(key, async () => { reached(); await gate; return f.slots.get(key); });
  const run = f.d.deployPhase(7);
  await entered;
  assert.equal(f.seals().length, 0, 'other chains must wait for the delayed verification');
  release();
  await run;
  assert.equal(f.seals().length, 1 + f.api.L2_CHAIN_KEYS.length);
  assert.equal(Object.keys(f.d.state.finalizations).length, f.seals().length);
  const firstSeal = f.events.findIndex(event => event.startsWith('seal:'));
  for (const proof of proofKeys) assert.ok(f.events.indexOf(`read:${proof}`) >= 0 && f.events.indexOf(`read:${proof}`) < firstSeal);
  assert.ok(f.events.some(event => event.startsWith('optional:')));
});

test('resume re-reads wiring before accepting existing owner-zero finalization records', async () => {
  const f = fixture();
  await f.d.deployPhase(7);
  f.events.length = 0;
  f.slots.set('CawProfile:minter', address(999));
  await assert.rejects(f.d.deployPhase(7), /MINTER WIRING MISMATCH/);
  assert.equal(f.seals().length, 0);
});

test('unsealed development retains optional failure handling and never calls a finalizer', async () => {
  const f = fixture(false);
  assert.equal(f.proofs.length, 2 + 2 * f.api.L2_CHAIN_KEYS.length * (f.api.L2_CHAIN_KEYS.length - 1));
  for (const step of f.bootstrap) assert.equal(f.d.isSealedRequiredStep(step), false);
  for (const key of proofKeys) f.fault.set(key, () => { throw new Error('Must not read sealed-only proof'); });
  await f.d.deployPhase(7);
  assert.equal(f.seals().length, 0);
  for (const key of proofKeys) assert.equal(f.events.includes(`read:${key}`), false);
});

test('correct bootstrap slots skip writes; empty slots are wired before verification', async () => {
  const f = fixture();
  for (const step of f.bootstrap) await f.d.executeLink(step);
  assert.equal(f.events.filter(event => event.startsWith('write:')).length, 0);
  for (const key of f.slots.keys()) {
    if (key === 'CawProfile:minter') continue; // immutable, never set by a linking step
    if (key.endsWith(':cawProfile') || key.endsWith(':minter')) f.slots.set(key, ZERO);
    if (/^Caw(ChallengeRelay|ActionsArchive)_.+:peers:/.test(key)) f.slots.set(key, padded(ZERO));
  }
  for (const step of f.bootstrap) await f.d.executeLink(step);
  await f.d.deployPhase(7);
  assert.equal(f.seals().length, 1 + f.api.L2_CHAIN_KEYS.length);
});
