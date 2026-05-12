# CAW Native

Native iOS and Android wrappers for the CAW web app, with a built-in self-custody wallet so users never have to bounce out to MetaMask.

## What this is

A thin native shell around the existing `client/src/services/FrontEnd` web app, plus a wallet module that owns and signs with the user's keys on-device. The web app continues to ship as-is — the native shell injects a wallet provider so the same `wagmi` / signing code paths work without an external wallet.

## Goals

- **Zero-knowledge default**: a user with no crypto background can sign up, buy CAW with Apple Pay / Google Pay, mint a username, and post — without ever seeing a seed phrase.
- **Power-user parity**: users who already have wallets can import them (seed phrase, private key, JSON keystore), hold multiple accounts, and switch between them.
- **MetaMask-equivalent custody model**: keys live on the user's device, encrypted at rest with a user-chosen password. We never see plaintext keys. Lose password + lose all backups = lose account (same tradeoff every non-custodial wallet has).
- **One codebase per platform**: native wrappers do the wallet + biometrics + cloud backup; the web app stays the source of truth for UI.

## Non-goals

- We are not building a general-purpose wallet (no dApp browser, no WalletConnect-as-server, no NFT gallery beyond CAW profiles).
- We are not custodying funds. No server ever sees a plaintext key or seed.
- We are not replacing the web app. Desktop/web users keep using MetaMask.

## Architecture at a glance

```
┌──────────────────────────────────────────────────────┐
│  Native shell (iOS: Swift / Android: Kotlin)         │
│                                                      │
│  ┌─────────────────────────────────────┐             │
│  │  WebView (loads the existing CAW    │             │
│  │  web app from client/.../FrontEnd)  │             │
│  └──────────────┬──────────────────────┘             │
│                 │ JS bridge                          │
│  ┌──────────────▼──────────────────────┐             │
│  │  Wallet module                       │            │
│  │   - keystore (Secure Enclave /       │            │
│  │     Android Keystore)                │            │
│  │   - signer (secp256k1, EIP-712)      │            │
│  │   - backup (password-encrypted blob) │            │
│  │   - biometric gate                   │            │
│  └──────────────────────────────────────┘            │
└──────────────────────────────────────────────────────┘
```

The web app talks to the native wallet through an EIP-1193-shaped bridge, so existing wagmi connectors work unchanged.

## Why not ERC-4337 + passkeys (revisit pending)

Initially rejected for L1 cost reasons (smart-account deploy per user, UserOp overhead, and at the time no cheap on-chain P-256 verification). The Fusaka upgrade (Dec 2025) shipped EIP-7951, which collapsed on-chain passkey verification from ~330K gas to ~3.5K gas — removing the biggest specific objection. The remaining costs are real but narrower than before. A fresh cost analysis lives in [`docs/ERC4337_REASSESSMENT.md`](docs/ERC4337_REASSESSMENT.md); the plan in this directory still reflects the EOA-wallet path until that re-analysis lands a different conclusion.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design, native ↔ web bridge, threat model
- [`docs/WALLET.md`](docs/WALLET.md) — key generation, storage, signing, multi-account
- [`docs/BACKUP_AND_RECOVERY.md`](docs/BACKUP_AND_RECOVERY.md) — password vaults, cloud backup, import flows
- [`docs/SESSION_KEYS.md`](docs/SESSION_KEYS.md) — how the native wallet integrates with the existing on-chain QuickSign session-key system
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md) — `mintFor` / `mintAndDepositFor` / `depositFor` and how the relayer uses them
- [`docs/ONRAMP.md`](docs/ONRAMP.md) — Apple Pay / Google Pay → CAW token flow
- [`docs/BROWSER_WALLET.md`](docs/BROWSER_WALLET.md) — browser-only secondary path (passkey + password hybrid), and the migration path from browser to native
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased plan from prototype to ship

## Status

Planning. No code yet.
