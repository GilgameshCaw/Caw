'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const provenance = require('../scripts/deployment-provenance');
const { verifyManifestEntry } = require('../scripts/verify-creation-receipt');
const address = '0x' + 'ab'.repeat(20);
const txHash = '0x' + '12'.repeat(32);
const blockHash = '0x' + '34'.repeat(32);
const otherHash = '0x' + '56'.repeat(32);
const chainId = 84532;

function rpc() {
  const data = {
    chain: '0x' + chainId.toString(16),
    tx: { hash: txHash, to: null, chainId: BigInt(chainId), blockNumber: 100, blockHash, index: 0 },
    receipt: { hash: txHash, to: null, status: 1, contractAddress: address, blockNumber: 100, blockHash, index: 0 },
    block: { number: 100, hash: blockHash },
  };
  const calls = [];
  const provider = {
    send: async (method, params) => { assert.equal(method, 'eth_chainId'); assert.equal(params.length, 0); calls.push(method); return data.chain; },
    getTransaction: async hash => { assert.equal(hash, txHash); calls.push('transaction'); return data.tx; },
    getTransactionReceipt: async hash => { assert.equal(hash, txHash); calls.push('receipt'); return data.receipt; },
    getBlock: async height => { assert.equal(height, data.receipt.blockNumber); calls.push('block'); return data.block; },
    getBlockNumber: () => { throw new Error('A sampled head must not supply a creation floor'); },
  };
  return { data, provider, calls };
}
function expectedRecord() {
  return { chainId, contractAddress: address, transactionHash: txHash, blockNumber: 100, blockHash, transactionIndex: 0 };
}

test('captures exact creation receipt, including transaction index zero', async () => {
  const f = rpc();
  assert.deepEqual(await provenance.readCreationRecord(f.provider, txHash, address, chainId), expectedRecord());
  assert.deepEqual(f.calls, ['eth_chainId', 'receipt', 'transaction', 'block']);
});

const mutations = {
  'wrong RPC chain': f => { f.data.chain = '0x1'; },
  'malformed RPC chain': f => { f.data.chain = '84532'; },
  'missing transaction': f => { f.data.tx = null; },
  'missing receipt': f => { f.data.receipt = null; },
  'failed receipt': f => { f.data.receipt.status = 0; },
  'unknown receipt status': f => { f.data.receipt.status = null; },
  'wrong receipt hash': f => { f.data.receipt.hash = otherHash; },
  'wrong transaction hash': f => { f.data.tx.hash = otherHash; },
  'ordinary transaction': f => { f.data.tx.to = address; },
  'ordinary receipt': f => { f.data.receipt.to = address; },
  'wrong transaction chain': f => { f.data.tx.chainId = 1n; },
  'wrong created address': f => { f.data.receipt.contractAddress = '0x' + 'cd'.repeat(20); },
  'missing created address': f => { f.data.receipt.contractAddress = null; },
  'negative block': f => { f.data.receipt.blockNumber = -1; },
  'unsafe block': f => { f.data.receipt.blockNumber = Number.MAX_SAFE_INTEGER + 1; },
  'fractional block': f => { f.data.receipt.blockNumber = 1.5; },
  'string block': f => { f.data.receipt.blockNumber = '100'; },
  'missing block hash': f => { f.data.receipt.blockHash = null; },
  'zero block hash': f => { f.data.receipt.blockHash = '0x' + '00'.repeat(32); },
  'negative index': f => { f.data.receipt.index = -1; },
  'missing index': f => { delete f.data.receipt.index; },
  'mismatched index': f => { f.data.tx.index = 1; },
  'mismatched transaction block': f => { f.data.tx.blockNumber = 101; },
  'mismatched transaction block hash': f => { f.data.tx.blockHash = otherHash; },
  'missing canonical block': f => { f.data.block = null; },
  'reorganized canonical block': f => { f.data.block.hash = otherHash; },
  'wrong canonical height': f => { f.data.block.number = 101; },
  'RPC read error': f => { f.provider.getTransactionReceipt = async () => { throw new Error('unavailable'); }; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, async () => {
    const f = rpc(); mutate(f);
    await assert.rejects(provenance.readCreationRecord(f.provider, txHash, address, chainId));
  });
}
test('rejects invalid expected identity before RPC reads', async () => {
  for (const args of [[otherHash.slice(0, 12), address, chainId], [txHash, '0x'+'00'.repeat(20), chainId], [txHash, address, 0]]) {
    const f = rpc();
    await assert.rejects(provenance.readCreationRecord(f.provider, ...args));
    assert.equal(f.calls.length, 0);
  }
});

test('floor is chain- and address-bound; unknown legacy metadata stays unknown', () => {
  const state = { addresses: { CawActions_L2: address }, creationReceipts: { CawActions_L2: expectedRecord() }, l2DeployBlock: 999 };
  assert.equal(provenance.creationFloor(state, 'CawActions_L2', chainId), 100);
  assert.throws(() => provenance.creationFloor(state, 'CawActions_L2', 1), /chain mismatch/);
  state.addresses.CawActions_L2 = '0x' + 'cd'.repeat(20);
  assert.throws(() => provenance.creationFloor(state, 'CawActions_L2', chainId), /address mismatch/);
  delete state.creationReceipts.CawActions_L2;
  assert.equal(provenance.creationFloor(state, 'CawActions_L2', chainId), undefined);
});
test('public manifest exports only creation fields and rejects a stale generation', () => {
  const state = { addresses: { CawActions_L2: address }, privateKey: 'not-for-export',
    creationReceipts: { CawActions_L2: { ...expectedRecord(), rpcUrl: 'not-for-export' } } };
  const defs = { CawActions_L2: { chain: 'L2' } };
  const chains = { testnetL2: { chainId } };
  const output = provenance.buildCreationManifest(state, defs, chains, 'testnet');
  assert.deepEqual(output, { schemaVersion: 1, environment: 'testnet', contracts: { CawActions_L2: expectedRecord() } });
  assert.ok(!JSON.stringify(output).includes('not-for-export'));
  state.addresses.CawActions_L2 = '0x' + 'cd'.repeat(20);
  assert.throws(() => provenance.buildCreationManifest(state, defs, chains, 'testnet'), /address mismatch/);
});

function runner() {
  const scripts = path.resolve(__dirname, '../scripts');
  const source = fs.readFileSync(path.join(scripts, 'deploy.js'), 'utf8').replace(/\r\n/g, '\n');
  const entrypoint = "\nmain().catch(e => {\n  console.error('\\nDeployment failed:', e);\n  process.exit(1);\n});\n";
  assert.ok(source.endsWith(entrypoint), 'Review isolation if deployment entrypoint changes');
  const f = rpc();
  const events = [];
  let creations = 0;
  let waitFailure = false;
  const deployed = { getAddress: async () => address, deploymentTransaction: () => ({ hash: txHash }),
    waitForDeployment: async () => { events.push('wait'); if (waitFailure) throw new Error('confirmation unavailable'); } };
  const deny = () => { throw new Error('Unexpected external I/O'); };
  const context = { module: { exports: {} }, __dirname: scripts, process: { env: {}, argv: [], exit: deny },
    setTimeout(callback) { callback(); },
    console: { log() {}, warn() {}, error() {} }, require(name) {
      if (name === 'path') return path;
      if (name === 'ethers') return { ethers: { ZeroAddress: '0x'+'00'.repeat(20), formatUnits: String,
        ContractFactory: class { async deploy() { creations++; events.push('send'); return deployed; } } } };
      if (name === 'fs' || name === 'child_process') return new Proxy({}, { get: () => deny });
      if (name === './deployment-provenance') return provenance;
      if (name === './lz-dvn-config') return { configureLzDvns: deny };
      if (name === 'dotenv') return { config() {} };
      if (name === '../test/zk-fixtures/groth16-fixture.json') return JSON.parse(fs.readFileSync(path.resolve(scripts, name), 'utf8'));
      throw new Error('Unexpected import: ' + name);
    } };
  vm.runInNewContext(source.slice(0, -entrypoint.length) + '\nmodule.exports={MultiChainDeployer,CHAINS,CONTRACTS};', context, { timeout: 1000 });
  const api = context.module.exports;
  const d = Object.create(api.MultiChainDeployer.prototype);
  d.env = 'testnet';
  d.state = { addresses: {}, deployerAddress: address };
  d.contracts = {};
  d.initChain = async () => {};
  d.loadArtifact = () => ({ abi: [], bytecode: '0x60', linkReferences: {} });
  const receiptChain = api.CHAINS.testnetL1.chainId;
  f.data.chain = '0x' + receiptChain.toString(16);
  f.data.tx.chainId = BigInt(receiptChain);
  f.provider.getFeeData = async () => ({ maxFeePerGas: null, gasPrice: 1n });
  d.wallets = { testnetL1: { provider: f.provider } };
  d.saveState = () => events.push({ saved: JSON.parse(JSON.stringify(d.state)) });
  d.retry = async fn => { for (let n = 0; n < 3; n++) { try { return await fn(); } catch(e) { if(n===2) throw e; } } };
  return { ...f, api, d, events, creations: () => creations, failWait: value => { waitFailure = value; } };
}

test('real deploy path saves pending transaction before waiting, then exact receipt', async () => {
  const f = runner();
  assert.equal(await f.d.deploy('PathwayExpander_L1'), address);
  assert.equal(f.creations(), 1);
  const saved = f.events.findIndex(event => event.saved?.pendingCreationReceipts?.PathwayExpander_L1);
  assert.ok(saved > f.events.indexOf('send') && saved < f.events.indexOf('wait'));
  assert.equal(f.d.state.creationReceipts.PathwayExpander_L1.blockNumber, 100);
  assert.equal(f.d.state.pendingCreationReceipts.PathwayExpander_L1, undefined);
});
test('failed confirmation does not retry creation; resume verifies the saved transaction', async () => {
  const f = runner(); f.failWait(true);
  await assert.rejects(f.d.deploy('PathwayExpander_L1'), /confirmation unavailable/);
  assert.equal(f.creations(), 1);
  assert.ok(f.d.state.pendingCreationReceipts.PathwayExpander_L1);
  assert.equal(f.d.state.addresses.PathwayExpander_L1, undefined);
  assert.equal(await f.d.deploy('PathwayExpander_L1'), address);
  assert.equal(f.creations(), 1);
});
test('failed receipt binding remains pending and cannot be bypassed by force', async () => {
  const f = runner(); f.data.receipt.status = 0;
  await assert.rejects(f.d.deploy('PathwayExpander_L1'), /unsuccessful/);
  await assert.rejects(f.d.deploy('PathwayExpander_L1'), /unsuccessful/);
  await assert.rejects(f.d.deploy('PathwayExpander_L1', true), /Resolve pending/);
  assert.equal(f.creations(), 1);
  assert.equal(f.d.state.creationReceipts, undefined);
});
test('real floor refresh clears sampled legacy heads and uses only the matching receipt', () => {
  const f = runner(); f.d.state.l2DeployBlock = 999;
  f.d.refreshCreationFloor();
  assert.equal(f.d.state.l2DeployBlock, undefined);
  f.d.state.addresses.CawActions_L2 = address;
  f.d.state.creationReceipts = { CawActions_L2: expectedRecord() };
  f.d.refreshCreationFloor();
  assert.equal(f.d.state.l2DeployBlock, 100);
});

test('full-run resume recovers creations before nonce prediction and before any deployment phase', async () => {
  const f = runner();
  f.d.state.pendingCreationReceipts = { CawProfile: {
    chainId: f.api.CHAINS.testnetL1.chainId, contractAddress: address, transactionHash: txHash,
  } };
  f.d.wallets.testnetL1.getNonce = () => { throw new Error('Recovered CawProfile must not be predicted again'); };
  f.d.computeBootstrap = async () => { assert.equal(f.d.state.addresses.CawProfile, address); };
  const phases = [];
  f.d.deployPhase = async phase => {
    assert.equal(f.d.state.addresses.CawProfile, address);
    assert.equal(Object.keys(f.d.state.pendingCreationReceipts).length, 0);
    phases.push(phase);
  };
  await f.d.deployAll();
  assert.deepEqual(phases, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(f.creations(), 0);
});

test('local indexers select their own chain floor, including L1 and the second L2', () => {
  const definitions = { CawActions_L1: { chain: 'L1' }, CawActions_L2: { chain: 'L2' }, CawActions_L2b: { chain: 'L2b' } };
  const chains = { testnetL1: { chainId: 11155111 }, testnetL2: { chainId }, testnetL2b: { chainId: 421614 } };
  const state = { addresses: {}, creationReceipts: {}, l2DeployBlock: 999 };
  for (const [i, key] of Object.keys(definitions).entries()) {
    const id = chains['testnet' + definitions[key].chain].chainId;
    state.addresses[key] = address;
    state.creationReceipts[key] = { ...expectedRecord(), chainId: id, blockNumber: 100 + i };
    assert.equal(provenance.indexedCreationFloor(state, definitions, chains, 'testnet', id), 100 + i);
  }
  assert.equal(provenance.indexedCreationFloor(state, definitions, chains, 'testnet', 999), undefined);
  assert.throws(() => provenance.indexedCreationFloor(state, definitions, chains, 'testnet', String(chainId)), /invalid indexer chain/);
  delete state.creationReceipts.CawActions_L2b;
  assert.equal(provenance.indexedCreationFloor(state, definitions, chains, 'testnet', 421614), undefined);
});

test('read-only manifest verifier requires matching expected identity and observed inclusion', async () => {
  const f = rpc();
  const manifest = { schemaVersion: 1, contracts: { CawActions_L2: expectedRecord() } };
  assert.deepEqual(await verifyManifestEntry(f.provider, manifest, 'CawActions_L2', address, chainId), expectedRecord());
  await assert.rejects(verifyManifestEntry(f.provider, manifest, 'CawActions_L2', address, 1), /chain mismatch/);
  await assert.rejects(verifyManifestEntry(f.provider, manifest, 'unknown', address, chainId), /Missing creation/);
  await assert.rejects(verifyManifestEntry(f.provider, { ...manifest, schemaVersion: 2 }, 'CawActions_L2', address, chainId), /unsupported schema/);
});
for (const field of ['blockNumber', 'blockHash', 'transactionIndex']) {
  test(`read-only verifier rejects a saved ${field} inconsistent with the receipt`, async () => {
    const f = rpc();
    const saved = { ...expectedRecord(), [field]: field === 'blockHash' ? otherHash : 999 };
    await assert.rejects(verifyManifestEntry(f.provider, { schemaVersion: 1, contracts: { CawActions_L2: saved } },
      'CawActions_L2', address, chainId), /no longer matches/);
  });
}

// Execute the actual local-config update block and the continuation after it.
function configUpdate(mode) {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/deploy.js'), 'utf8');
  const start = source.indexOf('    // Resolve each local indexer');
  const end = source.indexOf("    // Rewrite this install's per-network addresses.ts.", start);
  assert.ok(start >= 0 && end > start);
  const writes = [], warnings = [];
  const rows = [{ service: 'RawEventsGatherer', config: { chainId, startBlock: 999 } }];
  const context = { __dirname: '/synthetic/scripts', path,
    deployer: { state: {}, env: 'testnet' }, CONTRACTS: {}, CHAINS: {},
    indexedCreationFloor: () => mode === 'unknown' ? undefined : 100,
    console: { warn: x => warnings.push(x) },
    fs: { existsSync: () => mode !== 'missing',
      readFileSync: () => mode === 'malformed' ? '{' : mode === 'wrong-shape' ? '{}' : JSON.stringify(rows),
      writeFileSync: (_file, data) => { if (mode === 'write-error') throw Error('sensitive local detail'); writes.push(JSON.parse(data)); } },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nglobalThis.continued = true;', context);
  assert.equal(context.continued, true);
  return { writes, warnings };
}
for (const mode of ['malformed', 'wrong-shape', 'write-error']) {
  test(`local config ${mode} preserves later output execution`, () => {
    const r = configUpdate(mode); assert.equal(r.writes.length, 0); assert.equal(r.warnings.length, 1);
    assert.ok(!r.warnings[0].includes('sensitive local detail'));
  });
}
test('local config updates a known floor and leaves missing or unknown config alone', () => {
  assert.equal(configUpdate('valid').writes[0][0].config.startBlock, 100);
  assert.equal(configUpdate('missing').writes.length, 0);
  assert.equal(configUpdate('unknown').writes.length, 0);
});
