# Architecture

## Overview

CAW Native is a thin native wrapper around the existing CAW web frontend. The native layer's only jobs are:

1. Host the web app in a WebView.
2. Own the user's keys.
3. Sign EIP-712 / personal_sign / transaction payloads when the web app asks.
4. Handle biometrics, cloud backup, and on-ramp purchases.

Everything the user sees — feed, profile, posting, settings — is the same React app from `client/src/services/FrontEnd`, served either from a bundled build or a remote URL.

## Why a WebView, not React Native

- The existing web app is mature, has its own UI system, and is the source of truth. Forking it into RN means maintaining two UIs forever.
- The wallet is the only piece that genuinely needs native. Everything else is UI.
- We can ship UI updates without app-store review by serving the web bundle remotely (with a bundled fallback for offline / first-launch).
- React Native adds value when the native UI and JS share state intricately. Here the wallet exposes a narrow signing API; a WebView + JS bridge is enough.

Tradeoff accepted: WebView UX is slightly worse than native UI for things like scroll polish, keyboard handling, and gestures. We'll patch the rough edges as they come up; if it ever becomes a real problem we can port hot screens to native incrementally.

## Components

### Native shell

- **iOS**: Swift, `WKWebView`, Secure Enclave + Keychain, `LocalAuthentication` (Face ID / Touch ID), CloudKit / iCloud Drive for backup blobs.
- **Android**: Kotlin, `WebView`, Android Keystore, `BiometricPrompt`, Google Drive App Folder API for backup blobs.

Both shells implement the same JS bridge contract (see below) so the web app doesn't branch on platform.

### Wallet module (per platform)

Owns:
- Key generation (BIP-39 seed → BIP-44 derivation, or raw secp256k1)
- Keystore (hardware-protected at rest)
- Signer (EIP-191 personal_sign, EIP-712 typed data, raw transactions)
- Backup encryption / decryption (password-derived AES-GCM)
- Cloud backup upload / download
- Biometric gate

Details in [`WALLET.md`](WALLET.md).

### JS bridge

A narrow, EIP-1193-compatible interface injected into the WebView as `window.cawNative`. The web app's existing wagmi setup gets a custom connector that talks to this bridge instead of MetaMask.

Methods (all async, all return Promises):

```ts
interface CawNativeBridge {
  // Wallet management
  listAccounts(): Promise<Account[]>
  getActiveAccount(): Promise<Account | null>
  setActiveAccount(address: string): Promise<void>
  createAccount(): Promise<Account>            // generates new seed
  importSeed(mnemonic: string): Promise<Account>
  importPrivateKey(hex: string): Promise<Account>
  importKeystore(json: string, password: string): Promise<Account>
  removeAccount(address: string): Promise<void>

  // Signing (all gated by biometric + active session policy)
  personalSign(address: string, message: string): Promise<string>
  signTypedData(address: string, typedData: object): Promise<string>
  signTransaction(address: string, tx: object): Promise<string>
  sendTransaction(address: string, tx: object): Promise<string>  // returns tx hash

  // Backup
  exportSeed(address: string): Promise<string>          // requires biometric + password
  exportKeystore(address: string, password: string): Promise<string>
  setBackupPassword(password: string): Promise<void>
  hasCloudBackup(): Promise<boolean>
  pushCloudBackup(): Promise<void>
  pullCloudBackup(password: string): Promise<Account[]>

  // On-ramp
  openOnramp(params: OnrampParams): Promise<OnrampResult>
}

interface Account {
  address: `0x${string}`
  label: string
  source: 'generated' | 'imported_seed' | 'imported_pk' | 'imported_keystore'
  hasSeed: boolean        // false for raw private-key imports
}
```

The web app detects `window.cawNative` on load and registers a wagmi connector that proxies to it. When running in a desktop browser, the connector is absent and the existing MetaMask / WalletConnect path is used.

### Web app changes

Minimal:
- New wagmi connector `nativeConnector` in `client/src/services/FrontEnd/src/services/wallet/` that wraps the bridge.
- Detect bridge presence on mount; if present, prefer it and hide the "Connect MetaMask" UI.
- Wallet management screens (list accounts, create, import, backup, settings) inside the web app, calling the bridge.

Everything else — feed, posting, QuickSign session enable — keeps working unchanged because the bridge implements EIP-1193's signing surface.

## Threat model

### What we defend against

| Threat | Defense |
|---|---|
| Lost / stolen device | Hardware-backed key storage, biometric gate, OS lock screen |
| Malicious app on same device | Keystore isolation (Secure Enclave / Keystore), no IPC export of plaintext |
| Compromised CAW backend | Backend never sees plaintext keys or seed |
| Phishing site loaded in WebView | Strict allowlist of loadable origins; remote bundles served from a single signed origin |
| Forgotten password | Optional cloud backup recoverable on any device with the password |
| Cloud account compromise (iCloud/Google) | Cloud blob is password-encrypted; attacker needs both the cloud account and the user's password |

### What we don't defend against

- User loses password AND loses every device that ever had the wallet — funds are gone. Same as MetaMask. We surface this clearly during onboarding.
- Sophisticated targeted malware with root on the device. No software wallet survives this.
- User exporting their seed and pasting it somewhere stupid. We add friction (biometric + reveal-then-hide) but ultimately can't prevent it.

### Origins / WebView hardening

- iOS: `WKWebView` with `WKContentRuleList` blocking arbitrary navigation; only the CAW origin and explicit allowlisted on-ramp origins can load.
- Android: `WebViewClient.shouldOverrideUrlLoading` enforces the same allowlist.
- The bridge is **not exposed** to any iframe or cross-origin frame — only to the top-level CAW origin. Inject after page load matches expected origin.
- CSP on the served web bundle restricts script sources.

## Bundle delivery

Two modes, switchable per build:

**Bundled** (default for v1)
- Web app is built into the native binary.
- Updates require an app store release.
- Slowest to iterate but simplest to reason about.

**Remote with bundled fallback** (later)
- App fetches the latest web bundle on launch from a signed CDN URL.
- Falls back to bundled version if fetch fails or signature is invalid.
- Bundle signing key is held by the release pipeline, not the app.
- Lets us ship UI fixes without app review while keeping native code (= the wallet) under store review only.

Defer remote bundles to a later phase; ship bundled first.

## What lives where

```
native/
  ios/
    CawApp/
      WalletModule/        # Swift wallet implementation
      WebViewBridge/       # JS bridge plumbing
      Onramp/              # Apple Pay → on-ramp integration
      ...
  android/
    app/
      src/main/java/.../wallet/
      src/main/java/.../bridge/
      src/main/java/.../onramp/
  shared/
    bridge-types.ts        # TS types for the bridge contract; consumed by web app
    test-vectors/          # Cross-platform signing test vectors
  docs/
```

The web app stays in its current location (`client/src/services/FrontEnd`). The only change there is adding the native wagmi connector.
