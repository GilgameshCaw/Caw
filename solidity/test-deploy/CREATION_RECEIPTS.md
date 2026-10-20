# Contract creation metadata

The deployment runner records a successful creation receipt for each newly deployed contract. Its block is the contract's creation height, not a later sampled head. The record binds chain ID, contract address, transaction hash, block number/hash and transaction index.

The runner checks the RPC's explicit `eth_chainId`, the transaction and successful receipt, and the RPC's block hash at the reported height. It uses [ethers v6 transaction and receipt fields](https://docs.ethers.org/v6/single-page/#api_providers). This establishes RPC-consistent metadata; it does not prove consensus, finality, transaction-trie inclusion, source/bytecode equivalence, or historical data availability.

## Deployment and recovery

The pending transaction hash/address/chain are saved before waiting for confirmation. Confirmation and receipt checks run outside the creation retry loop. An interrupted run with that pending record verifies the same transaction on resume rather than creating another contract. A pending failed or unavailable receipt stops recovery; it cannot be bypassed through the `deploy(..., true)` path. An explicit cascade redeployment clears the affected generation's addresses and receipt records together. As with existing deployment state, an operator must preserve the state file; losing it removes this recovery information.

No deployment or historical receipt is invented for an existing address. Old state with no creation record remains unknown. A generation that was already deployed needs separately acquired and verified creation metadata before its history floor can be trusted. This patch does not insert historical testnet values or silently replace missing data with a chain-head sample.

After a completed deployment, the runner writes `client/src/abi/creation-receipts.<environment>.json`, including when `--skip-abi` is used. Only public creation fields are exported, independently of the existing address manifest. The generated file should be reviewed and committed with the corresponding deployment addresses. No RPC URL, private key or whole state file is exported.

Each record has this shape (values below are placeholders, not a deployment):

```json
{
  "schemaVersion": 1,
  "environment": "testnet",
  "contracts": {
    "CawActions_L2": {
      "chainId": 84532,
      "contractAddress": "<expected address>",
      "transactionHash": "<creation transaction hash>",
      "blockNumber": 0,
      "blockHash": "<creation block hash>",
      "transactionIndex": 0
    }
  }
}
```

The legacy `l2DeployBlock` field is retained only for the first L2 and is derived from its matching receipt, or removed if unknown. The deployment runner selects local indexer floors by each indexer's numeric chain ID; it does not copy the first L2's floor onto another chain. Missing local metadata leaves that indexer's existing config unchanged with a warning.

**Remaining consumer work:** the separate installer and fresh-database fallback still need to consume this public metadata, verify the selected deployment, and refuse an unknown historical floor. This PR supplies the provenance foundation; it does not close those consumers or prove complete replay. Chain reorganizations can invalidate previously recorded inclusion; recheck before using a record.

## Read-only verification

With the Solidity package's normal ethers dependency installed, run from `solidity/`:

```sh
CAW_PROVENANCE_RPC_URL='<RPC URL for the expected chain>' node scripts/verify-creation-receipt.js ../client/src/abi/creation-receipts.testnet.json CawActions_L2 '<expected contract address>' 84532
```

Choose the expected address and chain from the reviewed deployment, independently of the input receipt record. A match prints `RPC_CREATION_METADATA_MATCH`; a mismatch exits non-zero. This command creates no signer, submits no transaction and does not modify the manifest. API-key-bearing provider exceptions are not printed.

## Deterministic tests

From the repository root with Node 24, without installed dependencies or RPC access:

```sh
node --test --test-isolation=none --test-concurrency=1 --test-timeout=10000 solidity/test-deploy/deployment-provenance.test.cjs
node --check solidity/scripts/deploy.js
```

Tests use contract/provider doubles and the actual deployment methods. They cover incorrect identity/inclusion, reorganized block observations, interrupted-run recovery without another creation, generation mismatch, public-field export and chain-specific floor selection. They are not EVM deployment tests.

The deploy.js hunks overlap PR #221's receipt/finalization work and need reconciliation if that PR merges first. Keep its PathwayExpander finalization proofs separate from these creation records.


## Installer migration and receipt-less recovery

Indexer-bearing installs now resolve the selected network's storage EID from its L1 network manager before writing configuration. The selected storage RPC must report the corresponding chain. The public receipt manifest must match the environment, selected CawActions address and chain; if an ERC-1271 sibling is present in that deployment, its receipt is required too. The floor is the earliest verified creation block, including zero. Both scanner chainId and backend L2_CHAIN_ID use the selected chain.

The default manifest is client/src/abi/creation-receipts.<environment>.json in the selected install. Set CAW_CREATION_MANIFEST to an explicit local manifest path for recovery. No private .deploy-state.json value or sampled current head is copied into the new config.

For an existing receipt-less deployment, preserve the old config and database. Recover each indexed contract's actual creation transaction independently, then populate a schemaVersion 1 manifest with environment and contracts entries keyed CawActions_<role> and, where present, CawActionsERC1271_<role>. Each entry requires chainId, contractAddress, transactionHash, blockNumber, blockHash and transactionIndex. Verify each record using verify-creation-receipt.js above and the reviewed expected chain/address. Set CAW_CREATION_MANIFEST to that file and rerun installation against matching RPCs. If the creation transaction or its historical receipt is unavailable, installation stops; do not fabricate a receipt or substitute the old 45547765 value. No on-chain recovery transactions are sent by these checks.

These RPC consistency checks do not establish consensus finality, code identity or complete event history. Generated config is not automatically a repaired database. Provider-backed preparation, manifest rejection, block zero, service chain selection and early failure are covered by dependency-double tests; a complete interactive install with real RPC/database services remains a review gate.


Full-generator regression coverage now includes default and alternate storage chains, consistent scanner/environment/address output, no output on missing creation receipts, and a failed second network read. A failed recheck marks installation incomplete rather than silently skipping addresses. Earlier files can already have been written when that late check fails: do not start services; review the RPC and rerun. This is not an atomic-install guarantee. Tests use filesystem/provider doubles, not a live interactive install.


### Diagnostics compatibility and rollout gate

`buildServiceList` remains a topology helper: doctor/update drift checks and regeneration may call it without history. In that case it emits no startBlock and never reads legacy state. Invalid supplied history still rejects. Fresh `generateConfig` continues to require verified receipts before writing files. Topology generation is not proof that an indexer has a valid history floor; retain the explicit-floor startup protection from PR #329.

No recovered creation manifest for the committed testnet generation is included in this branch. Merging this therefore blocks new indexer-bearing installations until a reviewed manifest is committed or supplied through CAW_CREATION_MANIFEST. A redeploy of unrelated contracts does not recover missing CawActions creation receipts. This rollout gate needs explicit review; do not treat passing tests as resolution.


### repairing an installed service list

`regen-config` and `doctor --fix` do not acquire deployment receipts. if their proposed additions include RawEventsGatherer, they refuse to write config rather than append a scanner with a default chain and unknown floor. use the receipt-verified installer with the selected chain RPC and creation manifest, preserving and reviewing existing settings before restart. missing receipts remain a blocker; these commands are not a bypass.

read-only diagnostics and regen-config --dry-run still report missing services. repairs of other services continue when a scanner already exists; its configuration is preserved, not newly validated. late installer failures can still leave earlier output files, so do not restart after an incomplete run.
