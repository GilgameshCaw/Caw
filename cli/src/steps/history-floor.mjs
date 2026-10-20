import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyManifestEntry } = require('../../../solidity/scripts/verify-creation-receipt.js');

// Read-only RPC consistency checks, not finality or bytecode authentication.
export async function resolveHistoryFloor({ environment, chainKey, chainId, addresses, manifest, provider }) {
  if (!['testnet', 'mainnet'].includes(environment) || !['L1', 'L2', 'L2b'].includes(chainKey)) {
    throw new Error('Unsupported history deployment selection');
  }
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || manifest?.environment !== environment) {
    throw new Error('History manifest environment or chain mismatch');
  }
  if (!addresses?.CawActions) throw new Error('Selected deployment has no CawActions address');
  const keys = ['CawActions'];
  if (addresses.CawActionsERC1271) keys.push('CawActionsERC1271');
  const blocks = [];
  for (const name of keys) {
    const record = await verifyManifestEntry(provider, manifest, `${name}_${chainKey}`, addresses[name], chainId);
    blocks.push(record.blockNumber);
  }
  return { chainId, chainKey, actions: addresses.CawActions, actionsERC1271: addresses.CawActionsERC1271 ?? null, startBlock: Math.min(...blocks) };
}
