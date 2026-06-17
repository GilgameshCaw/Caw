# CAW — Frequently Asked Questions

A plain-language guide for newcomers. For the formal specification, see
[`WHITEPAPER.md`](./WHITEPAPER.md); for the technical architecture, see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## The basics

### What is CAW?

CAW is a fully on-chain social network — a trustless, decentralized place to
post, like, follow, and tip. Every action you take is a cryptographically
signed message recorded on a blockchain, so your posts and your identity
aren't owned by any company that could delete them, sell them, or lock you
out. Once the contracts were deployed, no party — including the people who
deployed them — can shut it down, censor it, extract fees from it, or upgrade
it against its users.

### How is that different from Twitter/X or Mastodon?

On a normal platform, a company owns the servers, your account, and the rules,
and can change any of them. On a federated network (like Mastodon), a server
operator can still ban or shadow-ban you. On CAW, **the protocol has no admin
keys at all** — there is no operator who can be subpoenaed, pressured, or
compromised into removing your content. Frontends can choose what *they* show,
but they can't touch the underlying record, and you can always move to another
frontend without losing anything.

### Is CAW a token, an app, or a protocol?

All three relate, but they're distinct. **CAW** is the protocol (the rules, in
smart contracts). The **CAW token** is used to pay for actions and to mint
identity. An **app** (frontend) is just one window into the protocol — there
can be many, and they're interchangeable.

### What makes CAW different from other crypto social projects?

To be clear up front: CAW **is** built on blockchains — identity is an NFT on
Ethereum mainnet, and every action is a transaction on an L2. The difference
isn't "on-chain vs. not." It's *where the social data actually lives*.

Many crypto-social projects are ordinary apps with a token bolted on: the posts,
the social graph, and the feed live in the company's own database/servers, and
the blockchain is used only for a token, a login, or to anchor a hash. If that
company goes away, the social data can go with it.

CAW puts the social data itself on-chain — the bytes of every post live in the
transaction's calldata, secured by the same blockchains that secure Bitcoin and
DeFi. There's no operator-owned database holding your posts hostage, no admin
keys, and no single server whose disappearance loses your history. So the
distinction is "fully on-chain, ownerless social data" vs. "an app that
references a chain" — not a claim that CAW somehow isn't on a blockchain.

### Who runs CAW?

No one, by design. CAW "began without a developer, without official socials,
and without a roadmap. A contract was deployed, and a community formed around
it." The protocol is a public utility, not a company.

## Identity

### What is my identity on CAW?

Your identity is an NFT (an ERC-721 token) minted on Ethereum mainnet. Your
username lives in that NFT. Because it's an NFT you own, no one can take your
account or your handle from you.

### Why do usernames cost CAW to mint?

Usernames are scarce, so they're priced by burning CAW — and **shorter names
cost exponentially more**. This keeps the namespace from being squatted and
gives short handles real value. Current burn tiers (from the minting contract):

| Username length | CAW burned |
|-----------------|-----------|
| 5 characters    | 200,000,000 |
| 6 characters    | 20,000,000 |
| 7 characters    | 10,000,000 |
| 8+ characters   | 1,000,000 |

(1–4 character names cost dramatically more — they're rare.) The CAW you spend
to mint is burned, not paid to any treasury.

### Do I need a crypto wallet (like MetaMask) to use CAW?

Not necessarily — there are two paths:

1. **Passkey / biometric signup (no wallet needed).** Sign up with a device
   passkey — Face ID, fingerprint, or your platform's WebAuthn passkey — the same
   way you log into modern apps. No MetaMask, no seed phrase, no ETH to begin.
2. **Bring your own wallet.** If you already use MetaMask, Ledger, or another
   wallet, you can connect it and mint directly.

So a wallet is *one* option, not a requirement.

### What's a "sponsor," and is it always available?

On the passkey path, a **sponsor** is a party that submits your first on-chain
transaction and fronts the gas so a brand-new user with no ETH can get started.
It's an onboarding bridge, not a permanent free ride: **sponsorship depends on a
sponsor being available and willing**, and a given frontend may have limits,
gates, or no sponsor at all. If no sponsorship is available, you'd fund the mint
yourself (with your own wallet/ETH). Don't assume sponsored onboarding is
guaranteed everywhere or forever — it's a convenience some frontends offer, not a
protocol promise.

### Do I need ETH to use CAW?

Not to get started, *if* sponsored onboarding is available — a sponsor covers the
first on-chain step, so a new user with no ETH and no wallet can create a profile.
Without a sponsor, you fund the mint yourself. Either way, ongoing actions are
paid in CAW (see below), not ETH.

### Is posting free?

No — and it's worth being clear about this, because "free" is a common
misconception. Using CAW costs **CAW tokens**: posts, likes, follows, and tips
all spend a small amount of CAW (see the next question for where it goes). What
the passkey/sponsored path removes is the need to hold **ETH for gas** and to
manage a wallet — not the CAW cost of actions itself. The CAW cost is what keeps
the network spam-resistant and funds the people who record your actions on-chain.

## Posting, costs, and economics

### What does it cost to post?

Actions (posts, likes, follows, tips) are paid in **CAW tokens**. The cost is
fixed in CAW, with an **ETH-denominated upper bound** so that if the CAW price
spikes, actions never become absurdly expensive. Every CAW spent is either
redistributed to other holders, paid to validators who do the work of recording
actions, or burned. **There is no protocol treasury** — no company takes a cut.

### Why do I have to pay to post? Isn't social media supposed to be free?

On "free" platforms, you're the product: the company makes money from your data,
attention, and feed placement. CAW's small per-action CAW cost does two things
instead — it keeps spam in check (a cost-per-post is a natural spam brake), and
it funds the validators who record your actions, rather than a company. At the
**protocol** level there's no owner extracting value, no treasury, no ads baked
in. Your identity and your words are yours, stored on-chain.

One honest caveat: the **protocol** doesn't run ads or surveil you, but
**frontends are independent and can do whatever they want** — a given frontend
*could* show ads, track usage, or monetize however it chooses. What CAW
guarantees is at the protocol layer (no owner, no censorship of the record, your
identity is yours); it does not guarantee that every frontend will be
ad-free or privacy-respecting. If you don't like a frontend's choices, you can
use a different one — or run your own — without losing your account or posts.

### Are direct messages free?

Yes. DMs are encrypted end-to-end and stored off-chain, intentionally outside
the protocol's economic loop — free to send, free to read. Spam is handled at
the relay/rate-limit layer, not by charging you.

### Where does my post actually live?

The full text of your post lives forever in the **calldata** of a blockchain
transaction on an L2. The blockchain that secures it is the same kind of chain
that secures Bitcoin and DeFi — its durability is a property of the chain, not
a promise from an operator.

### What blockchain does CAW run on? Is it just Ethereum?

CAW is **omnichain** — it's designed as a protocol that can run across many
chains at once, not locked to any single one. The pieces fit together like this:

- **Ethereum mainnet is the core gateway.** Your identity (the username NFT),
  your CAW balances, and the registry all anchor here. Mainnet is the level you,
  as a user, interact with — minting, depositing, withdrawing all settle to L1.
- **Actions run on an L2**, and **each Network chooses its own L2** (and its own
  archive chain). So "which L2" isn't a fixed property of CAW — it's a choice a
  given Network makes. New chains can be added permissionlessly over time.
- **Archive chains** keep long-term replicated copies, so history is durable in
  more than one place.

Two things worth underlining. First, **you generally don't need to hold gas on
those other chains** — the design (sponsored onboarding + Quick Sign + the
validator handling L2 traffic) means a user can sign up and post without ever
holding ETH on the L2. Cross-chain messaging is handled under the hood (via
LayerZero), not something you operate manually. Second, the specific chains a
deployment uses (e.g. a particular L2 or archive) are that deployment's choices,
not a hardcoded fact about CAW — the protocol is built to be chain-agnostic.

## Networks, mirrors, and frontends

### What's the difference between a "Network" and a "Mirror"?

This trips up a lot of newcomers:

- A **Network** is a registered operator-tier entity — it picks its own L2,
  sets its own fee gates, and runs its own validator. Different Networks are
  effectively different social graphs sharing one root (one CAW token, one
  identity space, one price oracle). Think "many operators, one root," like
  many domains under one DNS.
- A **Mirror** is just an alternate frontend (window) onto the *same* Network.
  Same data, different UI.

So: Networks are separate social spaces; Mirrors are different doors into the
same one.

### If frontends can moderate, isn't that censorship?

The protocol itself never moderates — anything can be posted to it. **Frontends**
moderate: a frontend may filter, hide, or refuse to display content, but it
can't alter the underlying record. A user hidden on one frontend is still fully
present on the protocol and may be visible on another. This separation is
deliberate: moderation is a cultural/legal/aesthetic problem that belongs at the
replaceable frontend layer, not in the permanent protocol layer.

## Trust and safety

### Can the team change the rules later or take my funds?

No. Every production contract is **renounced after deployment** — ownership is
given up so the contracts can't be paused, reconfigured, fee-extracted, or
upgraded by anyone. The protocol can be *extended* to new chains by adding peers
permissionlessly, but it cannot be changed against its users.

### How do I know a claim about CAW is true?

Verify it on-chain. The whitepaper's stance is "for the reader who wants to
verify rather than be told" — every constant has a source-file citation, and
every durability or censorship-resistance claim reduces to an on-chain fact.
Be skeptical of claims made only in social posts (including airdrop or
price-prediction claims); check official channels and the contracts themselves.
