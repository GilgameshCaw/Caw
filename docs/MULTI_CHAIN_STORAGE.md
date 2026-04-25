# Multi-chain storage plan

## What "storage chain" means today

Every CAW client picks one `storageChainEid` at create time. That's the L2 chain where:

- `CawActions` lives — validators submit batches of user actions here, and per-token CAW balances + cawonces are bookkept here.
- `CawProfileL2` lives — the L2 mirror of the L1 username NFT, with on-chain message reception (auth, deposit, mint).
- The validator's gas is spent — every action submission is an L2 tx.
- Indexers (`RawEventsGatherer`, `MarketplaceIndexer`) read events from.

Today every client uses Base (Sepolia for testnet, Base mainnet for prod). That's hardcoded in two senses:

1. **Contract deployment**: `CawActions` and `CawProfileL2` are only deployed on Base.
2. **Off-chain wiring**: the CLI prompts for "L2 RPC URL" assuming Base; the validator service connects to one L2; addresses.ts has a single `CAW_ACTIONS_ADDRESS`.

But the contracts already speak `storageChainEid` as a per-client property — the data structure is multi-chain-ready.

## What needs to change for Arbitrum-as-storage

### Contracts (one-time per chain)

For each new storage chain (e.g. Arbitrum One):

1. **Deploy `CawProfileL2`** on the new chain. It's a self-contained OApp; just needs the chain's LayerZero endpoint address.
2. **Deploy `CawActions`** on the new chain, pointed at the new `CawProfileL2` and the chain's CAW token address.
3. **Configure LayerZero peers**: pair the new `CawProfileL2` with the L1 `CawProfile` so deposit/mint messages flow.
4. **Optionally deploy a `CawActionsArchive`** on whatever chain you want this storage chain to replicate to (could be the same Arbitrum, could be different).

The *L1 contracts don't change* — `CawClientManager` already accepts arbitrary `storageChainEid` values at `createClient` time.

### Indexer / runtime (per-instance, per-client)

Today a CAW node runs one `RawEventsGatherer` pointed at one L2. Multi-chain support means:

- **Each client has a storage chain.** When the indexer processes events, it has to be reading from *the chain that client uses*.
- A node serving multiple clients on different storage chains needs **multiple `RawEventsGatherer` instances** (one per chain).

The simplest model: a CAW node serves **one** client per install, reads `storageChainEid` from `CawClientManager.getClient(clientId)` at startup, and configures everything (RPC, contract addresses, chain ID) from there. If you want to serve another client with a different storage chain, you spin up another node.

That's the model the contracts already point at.

### CLI changes

Today the CLI has `network=testnet|mainnet` and assumes Base for both. For multi-chain:

1. **Drop "L2 RPC URL" as a single prompt.** Replace with: ask for the client ID first → query `CawClientManager.getClient(clientId).storageChainEid` from L1 → label the L2 RPC prompt with the actual chain name from a `EID → chain metadata` table.
2. **Maintain a `STORAGE_CHAINS` table** keyed by EID with `{ name, chainId, rpcSampleUrl, cawActionsAddress, cawProfileL2Address }`. Today it'd have one entry per network. New chain = new entry.
3. **`createClient` flow** (already in CLI as of `980bf3a`) extends naturally: instead of defaulting storage chain to Base, present the full list from `STORAGE_CHAINS[network]` and let the operator pick.
4. **addresses.ts** becomes per-chain, not per-network. Probably need to rework as a structured map keyed by chain key — `addresses.base.CAW_ACTIONS`, `addresses.arbitrum.CAW_ACTIONS`, etc. Existing single-name exports become deprecated aliases.

### Service configs

The generated `client/config.json` would change from one `RawEventsGatherer` entry to one keyed off the client's storage chain:

```json
{
  "service": "RawEventsGatherer",
  "config": {
    "chainId": 8453,
    "rpcUrl": "${L2_RPC_URL}",
    "cawActionsAddress": "0x...",
    "startBlock": ...
  }
}
```

`cawActionsAddress` would become explicit instead of imported from `addresses.ts`. Similarly for `Validator` and any other service that references chain-specific addresses.

### Estimated scope

Roughly:

| Task | Estimate |
|---|---|
| Restructure `addresses.ts` as `addresses.<chain>.<symbol>` with deprecated flat aliases | 1–2 hours |
| Build `STORAGE_CHAINS` table with chain metadata | 30 min |
| CLI: read storageChainEid from chain → drive L2 RPC label + addresses | 1 hour |
| `client/config.json` generation: parameterize chain-specific addresses | 1 hour |
| `RawEventsGatherer` / `Validator` / `MarketplaceIndexer`: accept chain config from service config instead of importing addresses | 2–4 hours (touches running code) |
| Test on testnet by deploying `CawActions` to Arbitrum Sepolia and creating a test client | 1–2 hours |

Total: ~one full day of focused work, mostly mechanical.

## Recommended ordering

1. Don't touch any of this until there's a real second-storage-chain driver (a client wanting to deploy to Arbitrum, etc.). The indirection costs zero today; the abstraction it enables is purely future-tense.
2. When the driver shows up, do the contract deploy first, then the off-chain refactor. The off-chain refactor without a deployed second chain has nothing to test against.
3. Migrate **one** existing reference (probably the validator service's chain ID + address lookup) to the new shape before changing everything — sanity-check the abstraction with a real diff before committing to it everywhere.
