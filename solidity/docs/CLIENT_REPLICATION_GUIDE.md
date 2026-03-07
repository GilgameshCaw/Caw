# Client Replication Guide

This guide explains how CAW Protocol clients can set up cross-chain replication to archive their users' actions on additional blockchains.

## What is Replication?

Replication allows a CAW client to send copies of all processed actions to archive chains. This provides:

- **Redundancy**: Actions are stored on multiple chains
- **Accessibility**: Users can access their history from different networks
- **Permanence**: Archive chains may have different data availability guarantees

When a user submits an action (post, like, follow, etc.), the action is:
1. Processed on the primary L2 (e.g., Base)
2. Replicated to all configured archive chains via LayerZero

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         L1 (Ethereum)                           │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │  CawClientManager   │    │          CawName                │ │
│  │  - addReplication() │───▶│  - syncReplication()            │ │
│  │  - removeReplication│    │  - syncReplicationRemoval()     │ │
│  └─────────────────────┘    └──────────────┬──────────────────┘ │
└────────────────────────────────────────────│────────────────────┘
                                             │ LayerZero
┌────────────────────────────────────────────▼────────────────────┐
│                         L2 (Base)                               │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │      CawNameL2      │───▶│    CawActionsReplicator         │ │
│  │ - setReplicationPeer│    │    - updatePeer()               │ │
│  └─────────────────────┘    │    - replicate() ◀── CawActions │ │
│                             └──────────────┬──────────────────┘ │
└────────────────────────────────────────────│────────────────────┘
                                             │ LayerZero
┌────────────────────────────────────────────▼────────────────────┐
│                    Archive Chain (e.g., Arweave L2)             │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   CawActionsArchive                         ││
│  │                   - Stores action events                    ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Setting Up Replication

### Prerequisites

1. You must be the owner of a registered CAW client
2. You need the LayerZero endpoint ID of the archive chain
3. You need the address of the `CawActionsArchive` contract on that chain

### Add Replication Destination

Call `CawClientManager.addReplication()` on L1 (Ethereum). The config is **automatically synced to L2** via LayerZero:

```solidity
function addReplication(
    uint32 clientId,     // Your client ID
    uint32 eid,          // LayerZero endpoint ID of archive chain
    address target       // CawActionsArchive contract address
) external payable;      // Requires ETH for LayerZero fees
```

**Example:**
```javascript
// Using ethers.js
const clientId = 1;
const arweaveEid = 30101; // Example endpoint ID
const archiveContract = "0x1234..."; // CawActionsArchive address

// Get quote for LayerZero fee
const quote = await clientManager.replicationSyncQuote(arweaveEid, archiveContract);

// Add replication (auto-syncs to L2)
await clientManager.addReplication(clientId, arweaveEid, archiveContract, {
    value: quote.nativeFee
});
```

**Limits:**
- Maximum 4 replication destinations per client
- Cannot add the same chain twice

### Verify Configuration

After adding, verify the config on L2:

```javascript
// On L2 (Base)
const destinations = await replicator.getReplicationDestinations(clientId);
console.log(destinations);
// [{eid: 30101, target: "0x1234..."}]
```

## Removing Replication

Removal is also automatic - just call `removeReplication()`:

```javascript
// Get quote for LayerZero fee
const quote = await clientManager.replicationSyncQuote(arweaveEid, ethers.constants.AddressZero);

// Remove replication (auto-syncs to L2)
await clientManager.removeReplication(clientId, arweaveEid, {
    value: quote.nativeFee
});
```

### Manual Sync (Recovery)

If auto-sync fails for any reason, you can manually sync:

```javascript
// Manual sync for add
await cawName.syncReplication(clientId, replicationIndex, baseEid, 0, {
    value: quote.nativeFee
});

// Manual sync for removal
await cawName.syncReplicationRemoval(clientId, arweaveEid, baseEid, 0, {
    value: quote.nativeFee
});
```

## Cost Considerations

Replication adds costs to every action:

1. **LayerZero Fee**: Each replication destination incurs a cross-chain message fee
2. **Gas on Archive Chain**: The archive contract's receive function consumes gas

### Estimating Costs

Users can get a quote before submitting actions:

```javascript
// On L2
const actionData = { /* action details */ };
const payload = ethers.utils.defaultAbiCoder.encode(
    ["tuple(...)[]", "uint8[]", "bytes32[]", "bytes32[]"],
    [actions, v, r, s]
);

const [quote, chainCount] = await replicator.quoteReplication(
    clientId,
    payload,
    false // payInLzToken
);

console.log(`Replicating to ${chainCount} chains costs ${quote.nativeFee} wei`);
```

### Who Pays?

The user submitting the action pays replication costs. This is included in the `msg.value` when calling `CawActions.processActions()`.

## Historical Migration

If you add a new archive chain, you can migrate historical actions. This is trustless - anyone can call it, and all data is verified on-chain.

```solidity
function migrateHistoricalBatch(
    MigrationParams calldata params,
    ICawActions.ActionData[] calldata actions,
    uint8[] calldata v,
    bytes32[] calldata r,
    bytes32[] calldata s,
    bytes32[256] calldata allR
) external payable;
```

The migration verifies:
1. The r values chain correctly to on-chain checkpoints
2. Each action's signature matches its r value
3. Each action was actually processed (cawonce marked as used)
4. Each action hasn't been migrated already (bitmap tracking)

## Security Model

### Permission Summary

| Action | Who Can Call | Verification |
|--------|--------------|--------------|
| Add replication | Client owner only | `onlyClientOwner` modifier |
| Remove replication | Client owner only | `onlyClientOwner` modifier |
| Sync to L2 | Client owner only | Checks `clientManager.getClientOwner()` |
| Trigger replication | CawActions only | `msg.sender == cawActions` |
| Migrate history | Anyone | Cryptographic verification |

### Trust Assumptions

1. **Client owners control their replication**: Only the registered owner can add/remove destinations
2. **Users pay for replication**: Replication costs are transparent and quoted upfront
3. **L1 is the source of truth**: Replication config originates on L1 and syncs to L2
4. **Archive contracts are trusted**: The client owner chooses which contracts receive replicated data

### Immutable Parameters

After deployment, these cannot be changed:
- `CawActionsReplicator.cawActions` - Only this contract can trigger replication
- `CawActionsReplicator.cawNameL2` - Only this contract can update peers
- `CawActionsReplicator.RECEIVE_GAS_LIMIT` - Fixed at 50,000

The replicator contract is ownerless after deployment - no admin can change behavior.

## Troubleshooting

### "Invalid destination for client"
The destination chain hasn't been synced. Call `CawName.syncReplication()`.

### "Peer not set"
The replicator doesn't have the peer configured. Verify sync completed successfully.

### "Maximum 4 replication destinations"
Remove an existing destination before adding a new one.

### Replication not working
1. Check that replication is enabled: `clientManager.clientReplicationEnabled(clientId)`
2. Verify destinations are synced: `replicator.getReplicationDestinations(clientId)`
3. Ensure sufficient msg.value for LayerZero fees

## Contract Addresses

| Network | Contract | Address |
|---------|----------|---------|
| Ethereum | CawClientManager | TBD |
| Ethereum | CawName | TBD |
| Base | CawNameL2 | TBD |
| Base | CawActionsReplicator | TBD |
| Base | CawActions | TBD |

## LayerZero Endpoint IDs

| Chain | Endpoint ID |
|-------|-------------|
| Ethereum Mainnet | 30101 |
| Base | 30184 |
| Arbitrum | 30110 |
| Optimism | 30111 |

See [LayerZero docs](https://docs.layerzero.network/contracts/endpoint-addresses) for full list.
