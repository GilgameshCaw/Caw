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

### Do I need ETH to use CAW?

Not necessarily. There's a sponsored-mint path so that users who don't hold ETH
(for example, phone-first signups) can still create a profile — a sponsor
submits the transaction on their behalf. Once you have a profile, posting is
paid in CAW.

## Posting, costs, and economics

### What does it cost to post?

Actions (posts, likes, follows, tips) are paid in **CAW tokens**. The cost is
fixed in CAW, with an **ETH-denominated upper bound** so that if the CAW price
spikes, actions never become absurdly expensive. Every CAW spent is either
redistributed to other holders, paid to validators who do the work of recording
actions, or burned. **There is no protocol treasury** — no company takes a cut.

### Are direct messages free?

Yes. DMs are encrypted end-to-end and stored off-chain, intentionally outside
the protocol's economic loop — free to send, free to read. Spam is handled at
the relay/rate-limit layer, not by charging you.

### Where does my post actually live?

The full text of your post lives forever in the **calldata** of a blockchain
transaction on an L2. The blockchain that secures it is the same kind of chain
that secures Bitcoin and DeFi — its durability is a property of the chain, not
a promise from an operator.

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
