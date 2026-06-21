# Scope: defer RainbowKit off the onboarding/first-load critical path

## Problem

`vendor-rainbowkit` is **2.6 MB raw / ~540 kB gzip** and `index` is **2.7 MB raw /
~795 kB gzip**. Both are on the **critical path of every route**, including
`/onboarding` — a passkey flow that needs no wallet-connect UI at all. Even with
edge gzip now on (3.4× smaller wire), that's still ~1.3 MB gzip the browser must
fetch + parse before the onboarding page can paint.

### Why it's on the critical path

`main.tsx` statically imports:
- line 20 `import "@rainbow-me/rainbowkit/styles.css"`
- line 23 `import Web3Provider from "./config/Web3Provider"`

`Web3Provider` wraps the **entire** `<App/>` in `<WagmiProvider>` →
`<RainbowKitProvider>`. Both are constructed at root before any route renders.
Rollup pulls all of `@rainbow-me/*` into `vendor-rainbowkit` (good — it's a named
manual chunk), but the **entry chunk statically depends on it**, so it's fetched
eagerly regardless of route.

### The central obstacle (why this isn't a one-line lazy import)

`wagmiConfig` is built by **`getDefaultConfig()` — which is exported from
`@rainbow-me/rainbowkit`** (`Web3Provider.tsx:4,115`), not from `wagmi`. So
wagmi's config is *coupled to rainbowkit at the config layer*. You cannot get a
working `WagmiProvider` config without importing rainbowkit today.

And the app genuinely needs `WagmiProvider` on nearly every route, including
onboarding: the passkey path's chain reads (`useReadContract`,
`useTokenDataUpdate`, `usePasskeySignIn` → balance/lens reads) all run through
wagmi hooks. So we can't drop `WagmiProvider` from onboarding — only the
**RainbowKit connect-UI layer** (`RainbowKitProvider`, the wallet modal, the
wallet connector list) is dead weight there.

## Strategy: split wagmi-config from rainbowkit-UI, lazy-load the UI

Two independent wins, in priority order:

### Win 1 — build `wagmiConfig` WITHOUT `getDefaultConfig` (decouple from RK)

Replace `getDefaultConfig({...})` with wagmi's own `createConfig()` +
`connectorsForWallets()` (from `@rainbow-me/rainbowkit` — still RK, but a much
smaller surface) **or** plain wagmi connectors. The goal: `wagmiConfig` lives in a
module that does NOT import the RainbowKit React component tree (provider, modal,
theme, 6-wallet connector bundle).

- If we use `connectorsForWallets`, the wallet *connector* code (metaMaskWallet,
  walletConnectWallet, …) still comes from RK and still gets pulled — so for a
  full win, the connector list itself must be lazy (only loaded when the user
  opens the wallet modal). This is the harder part.
- Cleanest target: a tiny `wagmiConfig.ts` that imports only `wagmi` +
  `wagmi/chains` + viem `http`. Wallet connectors are injected lazily.

### Win 2 — lazy-mount `RainbowKitProvider` + connect modal only when needed

Wrap the RainbowKit React layer in `React.lazy()` and mount it only when a
**Population-A** user (or any route that renders `<ConnectButton/>`) actually
needs the connect UI. Onboarding (Population-B passkey) never mounts it.

- `Web3Provider` becomes: always-on `<WagmiProvider config={wagmiConfig}>` +
  `<QueryClientProvider>`, and a `<Suspense>`-wrapped lazy `<RainbowKitLayer>`
  that's only rendered when needed.
- Gate on: route needs wallet UI (anything importing `ConnectButton`,
  `WalletAccountButton`, or the marketplace modals) → mount the layer.
  Onboarding / recovery / feed-read → skip it.
- `@rainbow-me/rainbowkit/styles.css` (main.tsx:20) moves into the lazy layer too,
  so the RK CSS doesn't ship in the entry.

## Consumers of RainbowKit / wagmi (impact surface)

Static `@rainbow-me` / wagmi importers found (grep):
`main.tsx`, `config/Web3Provider.tsx`, `components/{PollDisplay, PostMintOnboarding,
ProfileChooser, FeedItem, PostForm, MobilePostModal}`, `components/buttons/{WalletAccountButton,
ConnectButton}`, `components/modals/{TipModal, PlaceBidModal, BuyModal, CreateListingModal,
ViewOffersModal, MakeOfferModal}`, `layouts/MainLayout`, `hooks/{useSessionKey,
useEnsureWallet}`, `api/actions.ts`.

- Most of these use **wagmi hooks** (`useAccount`, `useReadContract`, …) — those
  need `WagmiProvider` (kept always-on) but NOT `RainbowKitProvider`. Safe.
- Only the **connect UI** consumers (`ConnectButton`, `WalletAccountButton`,
  RainbowKit's `useConnectModal`/`ConnectButton.Custom`) need the lazy RK layer.
  Audit each: which call `@rainbow-me/rainbowkit` React APIs vs only wagmi.

## Hard constraints / known traps (from existing code comments)

1. **Chunk dep-order fragility** (vite.config.ts:155-163): a previous attempt to
   split react/wagmi/tanstack into separate manual chunks crashed with
   `Cannot read properties of undefined (reading 'createContext')` because Rollup
   didn't emit the dep-order modulepreload edge. **Do NOT add more manualChunks
   splits.** The lazy-import approach (React.lazy) sidesteps this because the
   dynamic import gets its own correctly-ordered chunk graph automatically.
2. **`getDefaultConfig` side effects**: it registers WalletConnect metadata and
   the projectId loud-fail (Web3Provider.tsx:108). Preserve the prod
   projectId-unset throw when refactoring config.
3. **`wagmiConfig` is exported** (`export const wagmiConfig`) and imported
   elsewhere (e.g. `api/actions.ts` for `getPublicClient`/`readContract`). Keep
   the export path stable or update importers — grep `from.*Web3Provider` and
   `wagmiConfig`.
4. **PWA precache** (vite.config.ts:271 `maximumFileSizeToCacheInBytes: 5MB`):
   if a new lazy RK chunk is created, confirm it's still precached or
   intentionally runtime-cached; a chunk-404 post-deploy triggers the
   lazyWithReload path (routes.tsx).
5. **SSR/prerender**: `__prerender` route proxies to node (nginx test2:128). If
   RK is lazy, ensure the prerender path doesn't hard-require it at module load.

## Phases

1. **Measure baseline** — `yarn build`, record entry + vendor-rainbowkit gzip
   sizes and the onboarding-route import graph (what the onboarding entry pulls).
   `npx vite-bundle-visualizer` or rollup `--stats` to confirm RK is in the
   onboarding critical path and quantify the removable bytes.
2. **Decouple config (Win 1)** — extract `wagmiConfig` into its own module built
   without the RainbowKit React tree. Verify wagmi hooks still work on a
   non-wallet route. This alone may move RK's *provider/modal* out of entry even
   if connectors still cost something.
3. **Lazy RK layer (Win 2)** — `React.lazy(() => import('./RainbowKitLayer'))`,
   Suspense-wrapped, mounted only when wallet UI is needed; move RK CSS into it.
4. **Audit the 20 importers** — confirm none break when RK provider is absent on
   onboarding; convert any that statically import RK React APIs to either lazy or
   wagmi-only equivalents.
5. **Build + measure win** — confirm onboarding entry no longer pulls
   vendor-rainbowkit; record new gzip on the onboarding critical path.
6. **QA on test2** — incognito cold-load `/onboarding?code=…` waterfall before/after;
   then a Population-A wallet-connect flow still works (modal lazy-loads on click);
   marketplace modals still open.

## Expected win

Onboarding critical path drops by **~540 kB gzip** (the entire vendor-rainbowkit
chunk) plus the RK slice of the entry chunk. Population-A users pay a one-time
~540 kB lazy fetch the moment they click "Connect Wallet" — acceptable, since
that's an explicit wallet action, and it's cached thereafter.

## Risk / effort

- **Medium-high risk, medium effort.** The dep-order trap (#1) and the
  config-coupling (Win 1) are the real work; the lazy-mount is mechanical once
  config is decoupled. Bundler refactors here have a history of subtle
  module-init-order crashes — needs careful build verification, not just tsc.
- Recommend: do it on a worktree branch, measure at each phase, QA the
  wallet-connect + marketplace flows on test2 before landing. Do NOT bundle with
  unrelated changes.
- **Cheaper alternative if appetite is low**: skip Win 1, do only Win 2 partially
  — but RK config coupling means the connectors still load eagerly, so the win
  shrinks to maybe ~150-250 kB. The full win needs Win 1.
