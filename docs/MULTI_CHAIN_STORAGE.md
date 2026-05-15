# Multi-chain storage plan

> Terminology: a **Network** is the operator-tier entity in CAW — a hosted deployment with its own L2 venue, fee gates, and validator set. Registered via `CawNetworkManager.createNetwork()`. "Network" here is distinct from the unrelated uses of "client" (HTTP client, frontend app, library instances). Some on-chain storage names still use the legacy `client*` prefix (e.g. `clientHashAtCheckpoint`, `clientReplications`); these are code-level and will be renamed separately.

## Two separate concepts, often confused

CAW has two chain-related axes that are easy to muddle:

| Concept | What it controls | Who picks it | Per-what |
|---|---|---|---|
| **Storage chain** | Where `CawActions` runs. Validators submit batches here, balances + cawonces live here, indexers watch this chain. | Network owner sets at `createNetwork` time (`storageChainEid`) | One per Network |
| **Replication chain** | Where the optimistic archive lives. Validators commit hashes of each batch here for fraud-detection. | Each operator picks for their own node | One per validator process |

These are independent. A Network with `storageChainEid = base` could have validators replicating to Arbitrum, Optimism, or both — whichever each operator chooses.

## Storage-chain support: per-Network, on-chain enforced

Every CAW Network picks one `storageChainEid` at create time. That's the L2 chain where:

- `CawActions` runs — validators submit batches of user actions.
- `CawProfileL2` runs — the L2 mirror of the L1 username NFT.
- The validator's gas is spent — every action submission is a tx on this chain.
- Indexers (`RawEventsGatherer`, `MarketplaceIndexer`) read events from.

Today every Network uses Base (Sepolia for testnet, Base mainnet for prod). That's hardcoded in two senses:

1. **Contract deployment**: `CawActions` and `CawProfileL2` are only deployed on Base.
2. **Off-chain wiring**: the CLI prompts for "L2 RPC URL" assuming Base; the validator service connects to one L2; addresses.ts has a single `CAW_ACTIONS_ADDRESS`.

But the contracts already speak `storageChainEid` as a per-Network property — the data structure is multi-chain-ready.

## Replication-chain support: per-operator, no on-chain enforcement

The replication path is **already permissionless**:

- `CawActionsArchive.submitReplication` only requires `stakes[msg.sender] >= MIN_STAKE`. It doesn't check anything Network-related.
- The slashing path (`resolveChallenge`, `slashIncoherentRoot`) works against any submission on any archive chain that has a peer relationship with the relay.
- An operator with stake on chain X can replicate any Network's batches to chain X, full stop.

This means the CLI's replication question is a per-operator economic choice ("which chain do you have ETH on?"), not a per-Network constraint. Today the CLI lists the one deployed archive chain (Arbitrum Sepolia / Arbitrum One); the structure scales to N.

The legacy `clientReplications` mapping in `CawNetworkManager` exists from the old LZ-batch replication path and is no longer load-bearing — see `BACKLOG: contracts cleanup` below.

## What needs to change to add Arbitrum (or any chain) as a *storage* chain

### Contracts (one-time per chain)

1. **Deploy `CawProfileL2`** on the new chain. Self-contained OApp; needs the chain's LayerZero endpoint address.
2. **Deploy `CawActions`** on the new chain, pointed at the new `CawProfileL2` and the chain's CAW token address.
3. **Configure LayerZero peers**: pair the new `CawProfileL2` with the L1 `CawProfile` so deposit/mint/auth messages flow.
4. **Deploy a `CawActionsArchive`** on whichever chain(s) this storage chain replicates *to*. Canonical pairing is symmetric: Base ↔ Arbitrum (Base storage archives to Arbitrum, Arbitrum storage archives to Base).

The L1 contracts don't change — `CawNetworkManager` already accepts arbitrary `storageChainEid` values at `createNetwork` time.

### Off-chain runtime

A CAW node serves **one Network per install**. The install needs to know which storage chain the Network uses, then configure RPC + contract addresses for that chain. Pseudocode for the install flow:

```
1. operator picks networkId
2. CLI reads CawNetworkManager.getNetwork(networkId).storageChainEid
3. CLI looks up STORAGE_CHAINS[eid] → { name, chainId, cawActions, cawProfileL2, ... }
4. CLI asks for an RPC URL for that chain
5. CLI asks for a replication chain (the canonical pair, default-filled, overridable)
6. generated config + .env reflect the right chain's addresses
```

If you want to serve two Networks on different storage chains, you run two install dirs. The contracts don't constrain it; the runtime just doesn't bother multiplexing.

### CLI changes

Today the CLI has `network=testnet|mainnet` and assumes Base for both. For multi-chain:

1. **Move the network-ID question earlier** — before RPC URLs. Once we know `networkId`, we can query `getNetwork(networkId).storageChainEid` and label every downstream RPC prompt correctly.
2. **Maintain a `STORAGE_CHAINS` table** keyed by EID with `{ name, chainId, cawActionsAddress, cawProfileL2Address, defaultReplicationChain }`. Today it'd have one entry per network-type (testnet/mainnet). New chain = new entry.
3. **`createNetwork` flow** (already in CLI): instead of defaulting storage chain to Base, present the full list from `STORAGE_CHAINS[testnet|mainnet]` and let the operator pick.
4. **`addresses.ts` becomes per-chain, not per-network-type.** Probably reshape as `addresses.base.CAW_ACTIONS`, `addresses.arbitrum.CAW_ACTIONS`, etc., with the existing flat exports as deprecated aliases.
5. **Replication chain default** — derive from the storage chain via `STORAGE_CHAINS[eid].defaultReplicationChain` rather than hardcoding "Arbitrum".

### Service configs

The generated `client/config.json` would change from one `RawEventsGatherer` entry to one keyed off the Network's storage chain:

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

`cawActionsAddress` becomes explicit instead of imported from `addresses.ts`. Similarly for `Validator` and any other service that references chain-specific addresses.

### Estimated scope

| Task | Estimate |
|---|---|
| Restructure `addresses.ts` as `addresses.<chain>.<symbol>` with deprecated flat aliases | 1–2 hours |
| Build `STORAGE_CHAINS` table with chain metadata + canonical replication pairs | 30 min |
| CLI: ask networkId first, read storageChainEid, drive L2 RPC label + addresses | 1 hour |
| `client/config.json` generation: parameterize chain-specific addresses | 1 hour |
| `RawEventsGatherer` / `Validator` / `MarketplaceIndexer`: accept chain config from service config instead of importing addresses | 2–4 hours |
| Test on testnet by deploying `CawActions` to Arbitrum Sepolia and creating a test Network | 1–2 hours |

Total: ~one full day of focused work.

## Recommended ordering

1. **Deploy contracts to second chain first** so the off-chain refactor has something real to test against.
2. **Migrate one reference** (probably `ValidatorService`'s chain ID + address lookup) to the new shape before changing everything.
3. **CLI reorder is cheap** — move network-ID earlier, derive labels. Doable in a couple of commits.
4. The replication-chain side of this is already "done" — it's per-operator and the CLI structure for picking a chain already exists. New chain = one entry in the replication-chain table.

## Related: BACKLOG: contracts cleanup

The `clientReplications` / `clientReplicationEnabled` plumbing in `CawNetworkManager` is dead code from the old LZ-batch replication path. With optimistic-archive, replication is per-operator and permissionless — nothing on-chain needs to know which chains a Network "expects". See `PROJECT_BACKLOG.md` → "Remove `clientReplications` from CawNetworkManager" for the cleanup list. Worth doing at the next contract redeploy cycle.
