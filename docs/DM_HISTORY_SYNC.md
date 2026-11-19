# DM history sync between nodes: design note (draft)

In short: this note is about cross-node durability of DM bodies, that is, getting them back from other nodes when one is lost.

Status: a proposal for discussion. No code. Everything below was read from `master` at `97cd13f3`; none of it was run.

## Why

DM bodies are not on chain. They are stored, encrypted, in each node's database, so a node that is lost takes its copies with it, and the chain cannot rebuild them. Today a user who ends up on another node (the node went away, or the user moved) sees none of their earlier DMs there.

The case this note is written for: nodes run by independent operators, with clients spread over them by sticky load balancing. Stickiness keeps a user on one node while that node is up, so the user's own state (session, read marks, deletions) does not need to be merged between nodes. What is needed is the other case: the node a user was on is gone or no longer assigned, and the user lands on a node that has none of their DMs.

## What exists today

- Every DM is relayed to every active peer except the sender's node (`DmRelayService/index.ts`, `relayDmToPeers`, peers from `getPeers`). It is fire-and-forget with a 5 s timeout (`DM_RELAY_TIMEOUT_MS`). A peer that was down, or too slow, never gets the message, and nothing retries it later.
- A peer stores the message under `relayId` (unique), after checking the node signature and the inner `senderSig` against the sender's `DmIdentity.publicKey` (`dm-relay.ts`). The replay window of ±5 minutes applies only to this live relay.
- `senderSig` is made over `{encryptedPayload, senderId, recipientId, conversationId, contentType, timestamp}` (`dmSenderSig.ts`). `timestamp` is supplied by the client in the request body (`dm.ts`, the `POST /messages` handler) and is forwarded to peers.
- DM identities are already synced between nodes (`POST /api/dm/identity/relay`).
- There is no export, import or history sync for DMs.

So copies of most DMs already exist on several nodes; what is missing is a way to get them back.

## Relation to what the docs already say

`docs/SCALING.md` says that DM relay state is "per-node operational state, not the social graph" that does not need cross-node durability, and that a lost indexer database "is a cache miss. Re-index." That is true for posts, follows and balances, which the chain can rebuild. It is not true for DM bodies: nothing on chain can rebuild them. This note asks whether that statement is meant to cover DM bodies, or only the relay bookkeeping, because the answer decides whether this work is wanted at all. `docs/DIRECT_MESSAGING.md` ("Multi-Instance Relay") describes the live relay as best effort, which matches what is above; it says nothing about getting a message back later.

## The gap: the signed timestamp is not stored

`Message` has no column for the `timestamp` that `senderSig` commits to; `createdAt` is `@default(now())` on the receiving node. A stored row therefore cannot be checked against its `senderSig` later, and a node cannot hand a message to another node in a form the other node can verify.

Messages stored before such a column exists cannot be recovered this way. Reconstructing the timestamp from `createdAt` does not work, because the signature needs the exact value.

## Proposal

1. **Store the signed timestamp.** Add a nullable column to `Message` for the `timestamp` from the signed envelope. Fill it when a message is sent (`dm.ts`) and when one is received by relay (`dm-relay.ts`). On a receiving node, use it for ordering. This is small and useful on its own, and it only starts to help for messages stored after it ships, so earlier is better.
2. **A history endpoint on the peer side** (name open, e.g. `POST /api/dm/history/sync`). The requester is a registered node. The request carries the node signature (as the existing envelopes do) and a signature by the user's DM key over `{userId, requesterInstanceId, cursor, limit, issuedAt, nonce}`. The peer checks both, rejects a repeated `nonce`, and answers with a page of 1:1 messages of conversations the user takes part in, each with the fields needed to check `senderSig`. Only messages with a stored signed timestamp and a `senderSig` are returned. Pages are limited and rate-limited per user and per node.
3. **Import on the new node.** For each message: check `senderSig` against the sender's `DmIdentity.publicKey` (so the identities must be present first, via the existing identity relay), skip it if there is no valid signature, drop duplicates by `relayId`, and keep the signed timestamp. Messages without a valid signature are not imported: a peer's answer is not trusted more than a live relay is.
4. **Trigger.** When a user enables DMs on a node that has no history for them, the node asks its peers, starting from the newest signed timestamp it already has. Several peers can be asked; duplicates are dropped by `relayId`.

## What it does not do

- It does not recover messages stored before step 1, or messages that no peer holds (the live relay failed everywhere).
- Per-user state is not synced: read marks, `MessageDeletion`, `ConversationParticipant.leftAt`, reactions, edits. After a move, messages the user had deleted can come back, and read messages show as unread. Syncing them would need signed records of those actions and is a separate design.
- Group DMs are not covered (they are single-node by design today, `dm.ts`, `groupService.ts`).
- A peer can withhold messages. It cannot forge them, because each one is checked against the sender's key.
- It does not change who can read message content.

## Questions for the maintainers

0. `docs/SCALING.md` says DM relay state does not need cross-node durability. Does that cover the DM bodies themselves, or only the relay bookkeeping? If it covers the bodies, the rest of this note is not needed.
1. Is adding a column for the signed timestamp acceptable? If yes, it can go in as its own small pull request first.
2. Is "deleted and read state are not synced in the first version, and the note says so" acceptable?
3. Is limiting the first version to 1:1 DMs right?
4. Should the sync be pulled by the new node when DMs are enabled (as above), or do you prefer a different trigger?
5. Is the signature by the user's DM key the right way for a user to authorise the request, given that the new node must already have that user's `DmIdentity`?

## Not verified

- Nothing was run. The frontend DM enabling flow, `DmService`, `groupService.ts` and the exact request shapes were not read in full.
- How a user's session is bound to a node under sticky load balancing was not checked.
- Whether the live relay reaches every peer in practice (only that the code sends to all active peers).
