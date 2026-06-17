# CAW — User Guide

Conceptual how-to for common tasks. CAW has many interchangeable frontends, so
these guides describe *what happens* rather than exact buttons — the wording
varies by app, but the underlying flow is the same. See [`FAQ.md`](./FAQ.md) for
basics and [`DESIGN_RATIONALE.md`](./DESIGN_RATIONALE.md) for the "why."

## Creating a profile (minting your identity)

Your CAW identity is an NFT minted on Ethereum mainnet; your username lives in
it. **You do not need an existing crypto wallet to start** — there are two paths:

- **Passkey / biometric (easiest, no wallet needed).** Sign up with a device
  passkey — Face ID, fingerprint, or your platform's WebAuthn passkey — the same
  way you log into modern apps. No MetaMask, no seed phrase, no ETH required. A
  sponsor covers the on-chain setup so you can begin without holding any crypto.
- **Bring your own wallet.** If you already use MetaMask, Ledger, or another
  wallet, you can connect it and mint directly.

To create your profile:

1. **Choose a username.** Allowed characters are lowercase letters and numbers.
   Remember that shorter names burn far more CAW (see the cost table in
   [`FAQ.md`](./FAQ.md)) — most people pick 8+ characters, which is the cheapest
   tier.
2. **Fund the mint.** Minting burns CAW. With the passkey path a sponsor handles
   this for you; with your own wallet you either already hold CAW or swap ETH to
   CAW as part of minting.
3. **Confirm.** Once the mint lands, the username NFT is yours. No one can take
   it or the handle from you.

## Posting (and what it costs)

A post is an EIP-712-signed message that becomes part of the permanent on-chain
record.

1. Write your post.
2. Your action is signed and submitted. **Posting is not free** — every action
   spends a small amount of **CAW** (posts, likes, follows, and tips are all the
   same underlying signed `Action`, so they all cost CAW). This is what keeps the
   network spam-resistant and pays the validators who record your actions.
3. The cost is fixed in CAW but capped in ETH terms, so it stays reasonable even
   if the CAW price moves a lot.

Note the distinction that trips people up: the passkey/sponsored signup removes
the need to hold **ETH for gas**, but it does **not** make actions free — actions
always cost CAW. "No wallet / no ETH to start" is true; "free to post" is not.

The full text of your post lives forever in the transaction's calldata.

## Quick Sign (session keys) — so you don't sign every action

Signing every single like and follow by hand is tedious. **Quick Sign** (session
keys) lets you authorize a scoped, spend-capped key once, so subsequent actions
go through without a fresh signature each time. It's the standard UX on the
reference frontend. Sessions are bounded (scope + spend cap + expiry) so a
session key can't be abused beyond what you granted. See
[`SESSION_KEYS.md`](./SESSION_KEYS.md) for the mechanics.

## Tipping someone

A tip rewards another user (or a validator). Tips are just another action type,
paid in CAW. On a compose-time tip you attach recipients to your post; a
post-hoc tip sends CAW to a specific user. Either way the value moves on-chain
and is recorded like any other action.

## Following and liking

Follows and likes are actions like any other — signed and recorded on-chain.
Because they're part of the permanent record, your social graph isn't trapped
inside one app: any frontend reading the protocol can reconstruct who you follow
and what you've liked.

## Withdrawing your CAW

CAW deposited for a profile is tracked per-token. Withdrawing your balance back
out is always a **direct** transaction you authorize yourself — it is never
routed through a sponsor. (This is a deliberate safety choice: moving value out
should always require your own signature.)

## Phone-first signup and account recovery

Some frontends support a phone-first flow for users who don't hold ETH:

- **Signup** enrolls a device passkey (biometric/WebAuthn) and generates a
  recovery key, protected by a password-encrypted backup file. A sponsor
  bootstraps your on-chain identity so you don't need ETH to start.
- **Recovery** restores access from your backup file plus your vault password.
  Keep both safe: the backup file alone or the password alone is not enough, and
  no operator can recover the account for you — that's the point of a trustless
  system.

> Security note: your recovery key is the master credential. Treat the backup
> file and its password like the keys to a safe. If you suspect either has
> leaked, rotate your recovery key promptly through your frontend's security
> settings.

## Using multiple frontends (and what a "Mirror" is)

You're never locked into one app. Different frontends ("Mirrors") are just
different windows onto the same Network — same data, different UI. You can
switch frontends without losing your identity, posts, or social graph, because
all of that lives on the protocol, not in the app. (Note: a *Network* is a
separate social space; a *Mirror* is a different door into the same one — see
[`FAQ.md`](./FAQ.md).)

## A note on safety

- The protocol has no admin keys and no treasury; no one can freeze your account
  or take a cut.
- Be skeptical of claims made only in social posts — especially airdrop
  announcements or price predictions. Verify against official channels and the
  contracts themselves.
- Anything posted to the protocol is permanent and public. Frontends choose what
  to display, but the record itself can't be edited or deleted.
