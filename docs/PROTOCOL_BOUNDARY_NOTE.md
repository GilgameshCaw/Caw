# A Note on Subtraction: Identity, Action, and the Space Left Open

> What if CAW could leave more room for others by deciding less for them?

**Status:** A non-binding protocol-boundary thought experiment. No implementation or migration is proposed in this document.

## Starting from CAW's own premise

The original [CAW manifesto](./manifesto.txt) describes a raw toolkit from which people can build their own online societies, and draws a distinction between the protocol and its frontends. The current [developer guide](./FOR_DEVELOPERS.md) also describes signed Actions as a shared data primitive, with independent applications built on top.

This note asks whether that boundary could be drawn even more clearly.

CAW has developed meaningful social features, and that work should not be dismissed. But a feature being useful does not necessarily mean its *meaning* must be defined by the shared protocol.

## The question

What if the smallest common responsibility of CAW were to maintain a verifiable history of **NFT identities and their authorized actions**?

In that model, the protocol would aim to establish only what independent observers need in order to agree on the history:

1. **Identity:** which NFT identity exists, and which on-chain identifier anchors it.
2. **Authority:** who was authorized to act for that identity at the time of each action, including explicitly scoped delegation where applicable.
3. **Continuity:** an ownership transfer is itself part of the record. Earlier actions remain attributed to the authority that performed them; later owners continue the identity's history without rewriting it.
4. **Order and integrity:** actions can be ordered, authenticated, checked for replay or duplication, and independently verified.
5. **Availability:** sufficient data or durable, verifiable references remain accessible for independent reconstruction of history. A hash alone is not the historical content if the referenced data disappears.
6. **Necessary economic safety:** transfers, balances, fees, and authorization checks that protect assets cannot become optional merely by removing social labels.
7. **Exit and return:** the identity and its verifiable record remain usable without the permission, availability, or continued alignment of any particular frontend. A frontend may cease to exist, change its rules, or no longer suit its user; none of those events should make the underlying identity or recorded history inaccessible by design.

The protocol need not declare that an action is a *post*, a *like*, or a *follow* in order for an application to interpret it that way. Nor need it decide how actions should be ranked, displayed, recommended, moderated, or socially valued.

Those are legitimate responsibilities for applications, not necessarily obligations of the shared history layer.

## A simple example

- An NFT username is created and owned by wallet A.
- Wallet A authorizes a signed action associated with that identity.
- Wallet A transfers the NFT to wallet B.
- Wallet B authorizes another action.

The same NFT identity has a continuous history. The ownership change does not erase the past, and the new owner does not become the historical author of the earlier action.

One application may present the actions as social posts. Another may interpret them as an activity log. A third may build something that does not resemble a social network at all.

**CAW would make the history verifiable, not prescribe what the history must mean.**

## The ability to leave — and to return

A frontend is a way to experience the record; it should not become the only doorway back to it.

Imagine someone uses frontend A for years. Then A shuts down, changes its policies, or simply stops being a place where that person wishes to participate. They should be free to stop using A without abandoning their NFT identity or the history already recorded under it.

They might use frontend B, build another interface, or use independent tools to read the protocol directly. They should not have to obtain an export, an approval, or a recovery token from A merely to regain access to the **canonical history** that CAW itself has committed to preserving.

This is more than the ability to *switch applications*. It is the ability to *return to a shared reference point* when any application becomes unsuitable.

Such an exit is meaningful only if:

- The NFT and the authority to use it are not exclusively controlled by the frontend being left behind.
- The canonical record and the data needed to reconstruct it can be obtained and verified independently of that frontend's database or API.
- A compatible alternative can resume authorized activity without depending on the old frontend to approve or relay each action.
- The boundary is honest: private application data, unpublished drafts, local settings, or encrypted material whose keys are lost may **not** be recoverable merely because some actions were recorded on-chain.

A useful test might be: **If frontend A and its database disappeared tomorrow, could an independently operated client verify the NFT's ownership history, reconstruct the recorded actions, and continue from that record?**

This is a proposed design property, not a claim that the current deployment already passes that test. It depends on the availability of the underlying chain, relevant data, authorization keys, and usable submission paths.

## Why consider subtraction?

The more meanings and application behaviors the protocol itself must settle, the more decisions its maintainers are required to make for everyone.

A narrower common core might reduce the number of decisions that require shared authority while leaving more freedom to independent builders. It may also make it easier to preserve the essential record when a particular frontend, developer, or development organization goes away, or when a user no longer agrees with a service's direction.

This is an architectural question, not a claim that smaller code automatically produces decentralization. A smaller core still needs secure rules, reliable data availability, a viable economic model, and a sustainable path for handling defects.

## What this note does **not** ask for

- No removal of the current SNS, its features, or the work that made them possible.
- No immediate changes to contracts, Action types, storage, APIs, fees, or deployed networks.
- No claim that existing `CAW`, `LIKE`, `FOLLOW`, `WITHDRAW`, or other action semantics can be removed safely without compatibility and security analysis.
- No change to maintainers, permissions, governance, licensing, or merge rules.
- No requirement for agreement, adoption, or even a follow-up implementation.

An existing social application can remain valuable even if, conceptually, it is only one of many ways to use a neutral history layer.

## Questions worth leaving open

- What is the *minimum* fact about an identity and an action that all implementations must agree upon?
- Which rules are necessary for security and asset integrity, and which meanings belong to applications?
- Can ownership transfers and historical authorization be verified without trusting a particular indexer or frontend?
- What data must remain available for a historical record to be independently reconstructed?
- Can a user leave a frontend that disappears or no longer suits them, return to the neutral record, and continue elsewhere without that frontend's permission?
- What is the smallest independently usable read/write path, separate from any one hosted UI?
- Could this distinction be expressed as an optional reference model alongside today's system, without requiring an immediate redesign?

## An invitation, not a conclusion

There is a kind of restraint in leaving a space unfilled. Not everything that can be designed needs to be prescribed by the protocol.

**Perhaps CAW can do less at its center so that people can do more at its edges.**

If the answer is that the current architecture already leaves enough room, that is useful to learn as well. The purpose of this note is to make the boundary visible and discussable, not to win a decision.
