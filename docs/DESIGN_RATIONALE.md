# CAW — Design Rationale

Why CAW is built the way it is. This doc explains the *reasoning* behind the
protocol's main choices, in plain language. For the formal mechanics see
[`WHITEPAPER.md`](./WHITEPAPER.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md);
for newcomer questions see [`FAQ.md`](./FAQ.md).

## Why put social actions on-chain at all?

Prior attempts at decentralized social each failed a different way:

- **Custodial "decentralization"** runs on one company's servers with admin
  keys that can pause or freeze accounts — decentralized in rhetoric only.
- **Federated decentralization** (e.g. ActivityPub) lets server operators ban
  or shadow-ban; the social graph fragments along server lines.
- **Relay-based decentralization** (e.g. Nostr) signs messages but stores them
  best-effort — there's no guarantee the post you made is retrievable a decade
  later.

CAW's wager is that durability and censorship-resistance should be *structural*,
not voluntary. So identity is an immutable NFT on Ethereum mainnet, and every
action's bytes live forever in an L2 transaction's calldata. Storage durability
becomes a property of the blockchain itself, not an operator's promise.

## Why renounce ownership of the contracts?

Censorship resistance reduces to one fact: **there is no operator to pressure.**
If the contracts had admin keys, those keys could be subpoenaed, stolen, or
coerced into removing content or extracting fees. So every production contract
is renounced after deploy. The only mutation left is permissionlessly adding a
new cross-chain peer (so the protocol can grow to new chains) — and even that
can be renounced. The result: the protocol can extend, but it cannot be paused,
reconfigured, fee-extracted, or upgraded against its users.

This is also why the protocol has **no treasury**. Every CAW spent is
redistributed to holders, paid to validators, or burned. A treasury would be a
pot of value under someone's control — exactly the centralization the design
exists to avoid.

## Why is calldata the source of truth (not contract storage)?

Storing every post in long-term contract storage would be prohibitively
expensive and unnecessary. Instead, the action's bytes live in the
transaction's **calldata**, and on-chain events are *commitments* to that
calldata — not copies of it. The full record is permanently recoverable from
chain history, at a fraction of the cost of state storage. This is why you'll
see the architecture insist that "events are commitments to the calldata, not
copies of it."

## Why the optimistic archive and a two-day challenge window?

Long-term replication to archive chains is **optimistic**: a validator stakes
ETH and submits a batch, and it's *presumed honest* unless challenged. Anyone
watching can dispute a fraudulent submission during a **two-day challenge
window**; a proven fraud slashes the validator's entire stake.

Why optimistic rather than verify-everything-up-front? Because re-verifying
every action on the archive chain would be enormously expensive, and the
honest-majority assumption plus a real economic penalty (full-stake slashing)
makes fraud irrational. Two days is long enough for honest observers to catch
and prove fraud, short enough that finalization isn't endlessly deferred.

## Why fixed CAW costs with an ETH-denominated cap?

Costs are fixed in CAW so the protocol's economics are simple and predictable.
But a fixed CAW cost has a problem: if the CAW price rises a lot, posting could
become absurdly expensive. So there's an **ETH-denominated upper bound**,
enforced by a seven-day price average of a burned-LP Uniswap pair. The cap only
*binds* when the CAW price climbs high enough to make the fixed cost
unaffordable — and when it binds, the protocol's distribution percentages
(to receiver, depositor pool, and validator) are preserved at every price point.
The point is to keep the network usable across wild price swings without ever
introducing a discretionary fee-setter.

## Why sponsored mints?

A protocol that requires every new user to already hold ETH for gas excludes
exactly the people decentralized social should reach — phone-first, crypto-new
users. The sponsored-mint path lets a sponsor submit the minting transaction on
a user's behalf, using signature-based authorization, so a user with no ETH can
still create a profile. The sponsor pays gas and fronts CAW; the user just
signs. It's an onboarding bridge, not a custody arrangement — the resulting
identity NFT is the user's.

## Why are usernames priced by burning, with short names costing more?

Usernames are a scarce namespace. Pricing them by **burning CAW** (rather than
selling them to a treasury) ties their cost to the token's value and removes any
central seller. Making **shorter names cost exponentially more** reflects their
scarcity and desirability, discourages squatting, and gives short handles
genuine, verifiable value. The burned CAW leaves circulation entirely.

## Why is moderation a frontend concern, not a protocol concern?

The protocol stores data trustlessly; anything can be posted to it. Moderation —
deciding what *should* be shown — is a legal, cultural, and aesthetic problem
that varies by audience and jurisdiction. Baking it into the permanent protocol
layer would make it a point of central control and a censorship lever. So the
protocol stays neutral and **frontends moderate**: each can filter, mute, or
hide whatever it likes, while the underlying record stays intact and a user
hidden on one frontend remains present on the protocol (and visible on others).
Separating the *protocol* (forever) from the *frontend* (replaceable) is the
core structural bet of the design.

## Why are DMs off-chain and free?

Direct messages are end-to-end encrypted and kept off-chain, deliberately
outside the protocol's economic loop. Charging per-message would add friction to
private conversation for no protocol benefit, and putting encrypted blobs
on-chain forever serves no one. Spam is better handled where it actually
happens — at the relay/rate-limit layer — than by a spend gate.
