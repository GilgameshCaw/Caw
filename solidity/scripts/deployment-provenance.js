'use strict';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function requireValue(ok, message) {
  if (!ok) throw new Error(`Deployment provenance: ${message}`);
}
function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}
function validAddress(value) {
  return typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/i.test(value);
}
function validHash(value) {
  return typeof value === 'string' && HASH.test(value) && !/^0x0{64}$/i.test(value);
}
function validateRecord(record, address, chainId) {
  requireValue(record && Number.isSafeInteger(chainId) && chainId > 0, 'invalid expected chain');
  requireValue(record.chainId === chainId, 'record chain mismatch');
  requireValue(validAddress(address) && same(record.contractAddress, address), 'record address mismatch');
  requireValue(validHash(record.transactionHash) && validHash(record.blockHash), 'invalid transaction/block hash');
  requireValue(Number.isSafeInteger(record.blockNumber) && record.blockNumber >= 0, 'invalid block number');
  requireValue(Number.isSafeInteger(record.transactionIndex) && record.transactionIndex >= 0, 'invalid transaction index');
  return record;
}

// RPC-consistent creation metadata, not a consensus/finality or bytecode proof.
// Only direct CREATE deployment transactions are supported by this deployer.
async function readCreationRecord(provider, transactionHash, address, chainId) {
  requireValue(validHash(transactionHash), 'invalid creation transaction hash');
  requireValue(validAddress(address), 'invalid expected contract address');
  requireValue(Number.isSafeInteger(chainId) && chainId > 0, 'invalid expected chain');
  const reportedChain = await provider.send('eth_chainId', []);
  requireValue(typeof reportedChain === 'string' && /^0x[0-9a-fA-F]+$/.test(reportedChain) &&
    BigInt(reportedChain) === BigInt(chainId), 'RPC chain mismatch');
  const [receipt, tx] = await Promise.all([
    provider.getTransactionReceipt(transactionHash), provider.getTransaction(transactionHash),
  ]);
  requireValue(receipt && tx, 'creation transaction/receipt unavailable; retain pending record and retry');
  requireValue(receipt.status === 1, 'creation receipt unsuccessful');
  requireValue(same(receipt.hash, transactionHash) && same(tx.hash, transactionHash), 'transaction hash mismatch');
  requireValue(tx.to === null && receipt.to === null, 'not a direct contract creation');
  requireValue(typeof tx.chainId === 'bigint' && tx.chainId === BigInt(chainId), 'transaction chain mismatch');
  requireValue(same(receipt.contractAddress, address), 'creation address mismatch');
  const record = validateRecord({
    chainId,
    contractAddress: address.toLowerCase(),
    transactionHash: transactionHash.toLowerCase(),
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    transactionIndex: receipt.index,
  }, address, chainId);
  requireValue(tx.blockNumber === record.blockNumber && same(tx.blockHash, record.blockHash), 'transaction/receipt block mismatch');
  requireValue(tx.index === record.transactionIndex, 'transaction/receipt index mismatch');
  const block = await provider.getBlock(record.blockNumber);
  requireValue(block && block.number === record.blockNumber && same(block.hash, record.blockHash),
    'creation block is not the RPC current canonical block at that height');
  return { ...record, blockHash: record.blockHash.toLowerCase() };
}

function creationFloor(state, contractKey, chainId) {
  const record = state.creationReceipts?.[contractKey];
  if (!record) return undefined; // legacy deployments remain unknown, never guessed
  return validateRecord(record, state.addresses[contractKey], chainId).blockNumber;
}

function buildCreationManifest(state, definitions, chains, env) {
  const contracts = {};
  for (const key of Object.keys(state.creationReceipts || {}).sort()) {
    const definition = definitions[key];
    requireValue(definition && chains[env + definition.chain], `unknown deployment key ${key}`);
    const chainId = chains[env + definition.chain].chainId;
    const record = validateRecord(state.creationReceipts[key], state.addresses[key], chainId);
    // Whitelist public fields. Never export private state, RPC URLs or wallet data.
    contracts[key] = {
      chainId: record.chainId, contractAddress: record.contractAddress,
      transactionHash: record.transactionHash, blockNumber: record.blockNumber,
      blockHash: record.blockHash, transactionIndex: record.transactionIndex,
    };
  }
  return { schemaVersion: 1, environment: env, contracts };
}

function indexedCreationFloor(state, definitions, chains, env, chainId) {
  requireValue(Number.isSafeInteger(chainId) && chainId > 0, 'invalid indexer chain');
  const keys = Object.keys(definitions).filter(key => key.startsWith('CawActions_') &&
    chains[env + definitions[key].chain]?.chainId === chainId);
  requireValue(keys.length <= 1, 'ambiguous indexed deployment chain');
  return keys.length === 1 ? creationFloor(state, keys[0], chainId) : undefined;
}

module.exports = { readCreationRecord, validateRecord, creationFloor, buildCreationManifest, indexedCreationFloor };
