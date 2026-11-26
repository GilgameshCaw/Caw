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

The source still queues token IDs and reads the owner when the queue is flushed. If an NFT leaves and returns to the same owner before either change is sent, the destination can miss both transitions. The remote ledger also cannot revoke a session based on a transfer it has yet to learn about. Detecting every intermediate transfer would require carrying a transfer generation from the source. These limits matter to claims that NFT possession immediately controls a remote account.

A new sender budgets an additional 45,000 gas per included ownership entry for recording remote order and wallet-wide ownership loss. The ledger preserves existing storage positions and adds a dispatch nonce in spare space and mappings for packet order, ownership loss and revoked grants. Existing immutable deployments require a separate deployment and migration decision.
