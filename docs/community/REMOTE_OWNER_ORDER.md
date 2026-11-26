# Delayed username ownership updates

This change follows the local transfer fix in #504 and the NFT-01 finding in #424. It covers an ownership update that reaches the remote ledger after another update for the same NFT.

The authenticated LayerZero endpoint supplies the source channel and packet nonce. The ledger accepts remote ownership writes on its configured L1 channel and remembers the last applied packet nonce separately for each token. A newer packet can update an owner at the same source block height. Older packets, equal nonces and lower source block stamps cannot overwrite the current owner. An unrelated token can still receive an earlier packet. Changing owners uses the existing wallet and token session invalidation path.

A mint bundle identifies its authorizing owner in its final ownership entry. Before applying the bundle, the ledger checks whether that entry is fresh. A stale bundle can still settle its deposit and authentication. It skips the signing grant and emits `StaleSessionGrantSkipped`. A wallet-wide ownership loss also suppresses an older grant for another NFT. A mint bundle cannot replace an existing session or reinstall an explicitly revoked key. The owner can authorize that key again on the destination ledger. Deposit settlement relies on LayerZero's normal once-only packet delivery.

From `solidity/`, run:

```sh
forge test --match-path test-foundry/RemoteOwnerOrder.t.sol
forge test --match-path test-foundry/LocalOwnerOrder.t.sol
```

The remote tests call the ledger's public LayerZero receive entry point through a mocked endpoint with its configured peer. They cover reversed delivery across blocks and within one block, the same owner returning after an observed transfer, settlement of a delayed deposit, skipped signing grants, and an unrelated token's valid grant. They do not use a public bridge.

The source increments a 64-bit generation on mint and each actual ownership change. Self-transfers leave it unchanged. Both the fee quoter and sender read the same queued snapshot. Each remote ownership stamp carries the source block height in its high 64 bits and the transfer generation in its low 64 bits. When the generation advances, the destination invalidates the prior wallet and token sessions even if it sees the same owner twice. An unchanged generation preserves freshly registered sessions. Packet order and generation share one storage slot per token.

Run `forge test --match-path test-foundry/RemoteOwnerRoundTrip.t.sol` to repeat the end-to-end contract check. It forwards the actual payload produced by the profile's send path through a test endpoint. The destination learns of both transfers only after the queue is flushed and the update delivered. Until then it can still accept an existing session. No public bridge timing or deployment is claimed.

The updated profile, fee quoter, ledger and client must use the same packet format. The remote selectors changed with the move to 128-bit stamps. A mixed-version pair cannot process these ownership messages. Existing immutable deployments need a separately agreed cutover before funds or messages use the new route.

A new sender budgets an additional 45,000 gas per included ownership entry for recording remote order and wallet-wide ownership loss. The ledger preserves existing storage positions and adds a dispatch nonce in spare space and mappings for packet order, ownership loss and revoked grants. Existing immutable deployments require a separate deployment and migration decision.
