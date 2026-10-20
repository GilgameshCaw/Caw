#!/usr/bin/env node
'use strict';

// Read-only verification; no signer, deployment, or state-file mutation.
const fs = require('fs');
const { readCreationRecord, validateRecord } = require('./deployment-provenance');

async function verifyManifestEntry(provider, manifest, contractKey, expectedAddress, expectedChainId) {
  if (manifest?.schemaVersion !== 1 || !Object.hasOwn(manifest.contracts || {}, contractKey)) {
    throw new Error('Missing creation metadata or unsupported schema');
  }
  const saved = validateRecord(manifest.contracts[contractKey], expectedAddress, expectedChainId);
  const observed = await readCreationRecord(provider, saved.transactionHash, expectedAddress, expectedChainId);
  if (saved.blockNumber !== observed.blockNumber || saved.transactionIndex !== observed.transactionIndex ||
      saved.blockHash.toLowerCase() !== observed.blockHash.toLowerCase()) {
    throw new Error('Saved creation inclusion no longer matches RPC observation');
  }
  return observed;
}

async function main(args) {
  if (args.length !== 4 || !process.env.CAW_PROVENANCE_RPC_URL) {
    throw new Error('Usage: CAW_PROVENANCE_RPC_URL=<rpc> node scripts/verify-creation-receipt.js <manifest.json> <contractKey> <expectedAddress> <expectedChainId>');
  }
  const [file, key, address, rawChain] = args;
  if (!/^[1-9][0-9]*$/.test(rawChain)) throw new Error('Expected chain ID must be a positive decimal integer');
  const { ethers } = require('ethers');
  const provider = new ethers.JsonRpcProvider(process.env.CAW_PROVENANCE_RPC_URL);
  try {
    const observed = await verifyManifestEntry(provider, JSON.parse(fs.readFileSync(file, 'utf8')), key, address, Number(rawChain));
    console.log(JSON.stringify({ status: 'RPC_CREATION_METADATA_MATCH', contractKey: key, record: observed }, null, 2));
  } finally {
    provider.destroy();
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  // Provider exceptions can contain credential-bearing RPC URLs.
  console.error('Creation metadata verification failed. Check arguments, receipt availability and expected chain/address.');
  process.exitCode = 1;
});

module.exports = { verifyManifestEntry };
