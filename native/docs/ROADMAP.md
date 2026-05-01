# Roadmap

Phased plan from "no code" to "shippable on both stores." Each phase has a single shippable goal and a defined exit criterion.

## Phase 0 — Decisions and prep

**Goal:** lock the contracts the rest of the work depends on.

- [x] Add `mintFor` / `mintAndAuthFor` / `mintAndDepositFor` to `CawProfileMinter` and `depositFor` to `CawProfile` (see [`CONTRACTS.md`](CONTRACTS.md)).
- [ ] Pick the secp256k1 library per platform (iOS likely `secp256k1.swift` or `Web3Auth/Web3.swift`; Android likely `org.web3j` or `org.bitcoinj`).
- [ ] Pick the on-ramp provider for v1 (MoonPay vs Ramp, based on CAW liquidity + Apple Pay region coverage).
- [ ] Lock the JS bridge contract (`shared/bridge-types.ts`).
- [ ] Define the backup blob format v1 (see [`BACKUP_AND_RECOVERY.md`](BACKUP_AND_RECOVERY.md)).
- [ ] Generate cross-platform test vectors (`shared/test-vectors/`).
- [ ] Stand up the relayer service (EOA with ETH, CAW approvals to Minter + Profile, idempotency store keyed off on-ramp provider tx IDs).

**Exit:** all the above are written down and reviewed. No native code yet.

## Phase 1 — iOS shell + WebView

**Goal:** the existing web app runs inside a native iOS app, no wallet yet.

- [ ] Xcode project scaffold under `native/ios/`.
- [ ] `WKWebView` loads the bundled web app (production build of `client/src/services/FrontEnd`).
- [ ] Origin allowlist enforced.
- [ ] Build pipeline: `yarn build` in the web app → bundle copied into the iOS app resources.
- [ ] Runs on simulator and a test device. User can browse feed, log in via existing MetaMask flow (mobile MetaMask via deep link). No native wallet yet.

**Exit:** internal TestFlight build that browses CAW. MetaMask handoff still required for signing.

## Phase 2 — iOS wallet module (single account, no backup)

**Goal:** generate one key on-device, sign EIP-712, integrate with the web app.

- [ ] Wallet module: secp256k1 key generation, in-memory signing, hardware-wrapped at-rest storage.
- [ ] Vault password + Argon2id KDF, biometric gate for daily use.
- [ ] JS bridge: `createAccount`, `getActiveAccount`, `personalSign`, `signTypedData`.
- [ ] `nativeConnector` wagmi connector in the web app.
- [ ] Existing CAW login + QuickSign session enable works end-to-end against the native wallet, no MetaMask.
- [ ] Manual test: mint a username on testnet, post, like, follow.

**Exit:** internal build where a fresh user can create an account, mint a username, and post — all from inside the app. No backup, no import yet.

## Phase 3 — iOS backup + recovery

**Goal:** a user can lose / wipe their device and recover.

- [ ] Cloud backup blob to iCloud Drive ubiquity container.
- [ ] Recovery flow: fresh install → detects backup → password unlock → restored.
- [ ] Seed phrase reveal flow with friction (biometric + password + confirm-words).
- [ ] Keystore JSON export.
- [ ] Round-trip tests: create → wipe → restore → verify identical signatures.

**Exit:** internal build that survives device wipe, with all three backup paths tested.

## Phase 4 — iOS imports + multi-account

**Goal:** power users can bring their own wallets.

- [ ] Import seed phrase, private key, keystore JSON.
- [ ] Multi-account UI in settings: list, switch, label, remove.
- [ ] Per-account backup status indicators.
- [ ] Active account → CAW profile mapping (switching accounts switches the active CAW identity).

**Exit:** internal build with full wallet feature set on iOS, minus on-ramp.

## Phase 5 — On-ramp

**Goal:** Apple Pay → CAW in wallet, no MetaMask, no external wallet.

- [ ] Provider SDK integration (MoonPay or Ramp).
- [ ] Native `openOnramp` bridge method.
- [ ] USDC delivery → auto-swap to CAW via DEX (Uniswap on the chain CAW lives on).
- [ ] Receipt history in wallet UI.
- [ ] Failure / pending state handling.

**Exit:** end-to-end flow from "first launch" to "minted username" using only Apple Pay. Internal beta.

## Phase 6 — Android port

**Goal:** parity with iOS on Android.

- [ ] Android Studio project under `native/android/`.
- [ ] WebView shell.
- [ ] Wallet module with Android Keystore.
- [ ] Backup to Google Drive App Folder.
- [ ] Same JS bridge contract, verified against iOS test vectors.
- [ ] Google Pay on-ramp integration.

**Exit:** Android build at parity with iOS Phase 5.

## Phase 7 — Hardening + ship

**Goal:** App Store and Play Store releases.

- [ ] Security review: threat model walked through end-to-end, hardening verified.
- [ ] External penetration test on the wallet module.
- [ ] App Store / Play Store assets, screenshots, descriptions.
- [ ] Privacy policy updates: clear statement that we never see keys, what's stored where.
- [ ] In-app onboarding tutorial for non-crypto users.
- [ ] Analytics / crash reporting (without leaking sensitive data).
- [ ] Beta program with real users (TestFlight / Play Internal Testing).
- [ ] Submit.

**Exit:** approved on both stores.

## Phase 8 (post-launch) — Nice-to-haves

- Remote bundle delivery for web-app updates without app review.
- Multiple on-ramp providers with price comparison.
- WalletConnect server-side support so the in-app wallet can sign for external dApps.
- Hardware wallet support (Ledger BLE) for power users.
- Social recovery (Shamir-split the backup key across email/SMS/friends).

## Estimating

Honest take: phases 1–4 (iOS through multi-account) are the bulk of the work. On-ramp (5) is mostly integration. Android (6) is roughly half the time of all iOS phases combined since the architecture and contracts are settled by then. Hardening + ship (7) is always longer than expected.

Don't commit to dates until phase 0 is done.
