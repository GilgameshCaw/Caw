# Session keys (QuickSign integration)

The CAW contracts already have on-chain session keys. The native wallet doesn't replace them — it just becomes the master key that registers and rotates them.

See `docs/SESSION_KEYS.md` (the existing one in the repo root `docs/`) for the contract-level details. This doc covers how the native wallet plugs in.

## Recap of what already exists

- `CawProfileL2.registerSession(owner, sessionKey, expiry, scopeBitmap, spendLimit, sig)` stores a delegated session on-chain.
- `CawActions._verifySignatureMem` accepts a signature from either the NFT owner or any registered session key whose expiry/scope/spend cap is valid.
- The current web app (`client/src/services/FrontEnd`) generates session keys in-browser, encrypts them with `deriveKey(walletSignature)`, and stores them locally. Posts/likes/follows are signed by these session keys with no wallet popup.

This whole system stays. The native wallet inherits the role today played by MetaMask: producing the EIP-712 signature that registers a session.

## How native fits in

```
┌────────────────────────────────────────────────────────────┐
│ Native wallet (master key)                                 │
│   - Hardware-protected secp256k1                           │
│   - Signs registerSession() EIP-712 once per rotation     │
└──────────────┬─────────────────────────────────────────────┘
               │ EIP-712 signature
               ▼
┌────────────────────────────────────────────────────────────┐
│ CawProfileL2 contract                                      │
│   sessions[owner][sessionKey] = (expiry, scope, spendLimit)│
└──────────────▲─────────────────────────────────────────────┘
               │ on-chain check
┌────────────────────────────────────────────────────────────┐
│ Session key (in WebView local storage, encrypted)          │
│   - Generated in-app, never leaves the device unencrypted  │
│   - Signs every CAW action (post, like, follow, recaw)     │
└────────────────────────────────────────────────────────────┘
```

The session-key encryption key today is derived from a wallet signature. In native, we replace that with: **session-key private key encrypted by the native wallet module** under a per-app-install key in the Secure Enclave / Keystore. The WebView never sees plaintext session keys at rest.

## Lifecycle

### First-time enable (or after expiry)

1. User taps "Enable QuickSign" (or it auto-prompts on first action after expiry).
2. Web app builds a `registerSession` EIP-712 payload: spend cap, expiry, scope bitmap, generated session pubkey.
3. Web app calls `bridge.signTypedData(masterAddress, payload)`.
4. Native shows a biometric prompt with a clear summary: "Allow CAW to post on your behalf for 24 hours up to 100 CAW?"
5. Native returns the signature; web app submits the registration tx (or has the validator service submit it, same as today).
6. Session key plaintext lives only in memory + an at-rest encrypted blob keyed by the native module.

### Why this stays separate from on-ramp / mint

A natural-looking optimization would be to bundle session registration into `mintAndDepositFor` so the user finishes onboarding "ready to post" without an extra biometric. We don't do this — see [`CONTRACTS.md`](CONTRACTS.md) for the full reasoning. The short version: granting spending authority to a session key is a different kind of decision from receiving a profile and funds, and bundling them obscures what the user is actually authorizing. The cost of keeping them separate is one extra biometric tap during onboarding, which is acceptable.

There's also a contract-shape issue worth being aware of: the current `sessions[wallet][sessionKey]` mapping is keyed by wallet address, not `(wallet, tokenId)`. A session key registered for a wallet has authority over **every profile that wallet currently owns or ever acquires in the future**. This is fine when the user explicitly enables QuickSign on a wallet they understand they're delegating from, but it's a sharp edge worth knowing about — and a reason not to silently bundle session registration into other flows. A future contract refactor to scope sessions per `(wallet, tokenId)` is on the table; even with that change, we'd still want session enable to be a deliberate, separate user action.

### Day-to-day signing

Unchanged from today: the in-app session key signs actions in JS, with no native involvement at all. This is the whole point — native handles only the rare master-key operations.

### Rotation

Default: 24h expiry, auto-rotate on expiry. We can also offer "always-on QuickSign" by auto-rotating in the background a few minutes before expiry — biometric prompt with no extra explanation needed since the user already opted in once.

### Revocation

User taps "Disable QuickSign" → web app calls the contract's revoke method (signed by master key, biometric prompt) → on-chain session record cleared → in-app session key wiped.

## Spend cap UX

The on-chain spend cap is enforced contract-side, but we surface it well in the UI:

- Onboarding default: low cap suitable for normal posting (e.g., 50 CAW / 24h).
- Power user: customizable in settings.
- When a session is approaching its cap, the app warns and offers re-up early instead of failing on submit.

## Scope bitmap

The contract already restricts session keys from withdrawing. We expose toggles for the other action types so users can, e.g., enable QuickSign for posting but require master-key approval for follows or transfers. Default: post / like / follow / recaw on; everything else off.

## What about the password?

Master-key biometric prompts during the active session window don't require the vault password. Registering a session is a low-tier operation; it's the same as any other day-to-day signature. The vault password is only needed for high-tier ops (export seed, send transaction, remove account) or after a fresh install / cold start.
