# Design note: build-time config in the frontend bundle makes hash-based verification impossible

Status: for discussion. No code change proposed in this PR.
Base measured: `master` at `97cd13f3`. First measured on 2026-11-02; the public facts were re-checked on 2026-11-10.
Prepared with the help of tentencaw, who reviewed the note against the code and re-ran the build measurements in two other environments on 2026-11-10. The figures for the MoonPay key, the Tailwind rules, `dist.prev-a1`, the worktree with a different path, the escaping cases and the build with all 15 settings come from that re-measurement.

## Summary

The frontend embeds per-operator settings (`VITE_*`, the build version) into the JS bundle and `index.html`. Changing almost any one of them changes the content hash of the entry chunk and, through the chunk names, about 44% of the files. As a result, no two nodes with different settings serve the same files, and a reference manifest (as used by the Verifier) cannot match an honest community node. This note records what was measured, lists options, and asks which direction the maintainers prefer.

Purpose, to avoid over-promising: this would not certify that the code is safe. It would let a user check that the frontend they are using matches a published source at a given commit, and decide for themselves whether to trust that source. What it covers and what it does not is stated in the sections below.

## Background

- `build-manifest.json` is emitted on every production build (`vite.config.ts`, `caw-build-manifest`): a SHA-256 for every shipped file, excluding `sw.js`, `workbox-*` and the manifest itself.
- `client/scripts/publish-build-manifest.ts` copies it to `docs/manifests/<clientVersion>.json` and `latest.json`.
- `client/src/services/Verifier/` (added in `0402d503`) fetches the mirror's files, hashes them in the browser and compares them with `latest.json` read from the upstream repository.

## Observations

1. **No reference manifest is published.** `docs/manifests/` contains only `README.md`. `latest.json` and `<clientVersion>.json` do not exist on any ref of the upstream repository. `verify.caw.social` did not resolve (DNS) on 2026-11-10; `docs/manifests/latest.json` returned 404 on `master`. The reference URL in `Verifier/src/App.tsx` points at `gilgamesh-caw/caw-nfts`; an unauthenticated request to it returned 404 on 2026-11-10, so it is either private or absent.
2. **Mirrors do not send CORS headers on the paths the Verifier reads.** `docs/VERIFIER_DEPLOY.md` requires `Access-Control-Allow-Origin` on `/assets/*` and `/build-manifest.json`. On one node, a request with an `Origin` header to a JS asset got no `Access-Control-Allow-Origin`; 7 nodes returned `/build-manifest.json` (200) without it. `/api/instances` on the same node does return `*`, so the check itself works. Re-checked on 2026-11-10 on 4 nodes with `Origin: https://verify.caw.social`: all 4 returned both `/build-manifest.json` and a JS asset with 200 and no `Access-Control-Allow-Origin`.
3. **Nodes do not serve the same bundle.** Comparing the public `build-manifest.json` of 7 nodes (measured earlier; not re-run for this version of the note): every node reports a different `clientVersion` except two that share a short SHA; `index.html` differs on every pair; for files whose names appear on both sides the content is identical except `index.html`; about 160 chunk names exist on only one side. Most versions carry `+dirty`; the 4 nodes re-checked on 2026-11-10 all did.
4. **The build is reproducible; the inputs are not constant.** On a clean checkout of `97cd13f3` (same `node_modules`, two different directories), two builds with the same inputs produced 358 identical files. A build in a worktree with a different path name and depth also gave the same 358 files. Changing one input at a time:

   | Input changed | Chunk names that change | Other files with different content |
   |---|---|---|
   | `CAW_CLIENT_VERSION` (`97cd13f3` → `97cd13f3+dirty`) | 158 | `index.html` |
   | `VITE_NETWORK_ID` (1 → 2) | 158 | `index.html` |
   | a copy of an earlier build output left inside the `FrontEnd` directory (no other change) | 159 | `index.html` |
   | each of `VITE_PROJECT_ID`, `VITE_API_HOST`, `VITE_VALIDATOR_TIP`, `VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_MOONPAY_BASE_URL`, `VITE_SENTRY_DSN`, `VITE_SPONSOR_API_URL`, `VITE_SMART_EOA_ADDRESS`, `VITE_SPONSOR_UNGATED_ENABLED`, `VITE_L1_RPC_URL`, `VITE_L2_RPC_URL`, `VITE_L1_RPC_URL_FRONTEND`, `VITE_L2_RPC_URL_FRONTEND` (dummy values) | 158 | `index.html` |
   | `VITE_MOONPAY_API_KEY` (set alone) | 0 | none |

   Unset variables take their defaults. The dummy values were found in one or two chunks; `index.html` changes because it names the entry chunk, and contains a value only for the build version (the short values `1234` and `true` also match unrelated files, so that column is not reliable for them). With `VITE_MOONPAY_BASE_URL` also set, the MoonPay API key appears in the `OnrampOnboarding` chunk. Setting `VITE_MOONPAY_BASE_URL` also adds one chunk (`keyManager`), so that build has 359 files.

   **Files inside the source tree are an input too.** With a copy of an earlier `dist` left in the `FrontEnd` directory, an otherwise identical build renamed 159 chunks (one more than a setting change: the generated CSS file changed; the difference we saw was 12 Tailwind rules (for example `.sepia` and `.flex-auto`) that appear only in that build). A copy holding only the earlier build's `.js` and `.html` files renamed 159 chunks; a copy holding only its `.css` files renamed none. This fits Tailwind's automatic source detection: `src/index.css` imports `tailwindcss` without `@config`, and `@tailwindcss/vite` 4.1.10 scans `**/*` under its base directory when no source is given. Old outputs kept next to the sources (for example a `dist.prev-*` backup) may therefore change the next build: a copy named `dist.prev-a1` gave the same 159 (other names were not tested). The measurements above were taken with outputs kept outside the source tree, and two builds of the same inputs were identical.

   **Reproducibility on other machines (2026-11-02).** The same commit (`97cd13f3`) with the same fixed inputs (`CAW_CLIENT_VERSION=repro`, `VITE_NETWORK_ID=1`, `VITE_PROJECT_ID` a dummy value) was built three times on separate GitHub Actions runners (Ubuntu 24.04; Node 22.23.4 twice and 22.12.0 once; `npm install --legacy-peer-deps` in `client/` and `yarn install --ignore-platform` in the frontend directory, as the installer does, without `--frozen-lockfile`), and once on a server with Node 22.23.4 using a `node_modules` installed weeks earlier. All four produced the same 358 files with the same hashes. The installed package sets were not identical (the CI install had 157 more frontend packages, almost all optional per-platform binaries, plus different versions of a few packages such as `ws` and `tslib`), and the output was still the same. This is a result for this commit and these inputs, not a guarantee: a dependency update that changes what is bundled would change the hashes.

   **`.nvmrc` and the dependencies disagree.** `.nvmrc` at `97cd13f3` says `22.0.0`; `yarn install` in the frontend directory fails on Node 22.0.0 (`yargs@18.1.0` requires `^20.19.0 || ^22.12.0 || >=23`). Seen once, on a GitHub Actions runner. Installs that use the system Node are not affected.

5. **Why one value moves so many names (hypothesis, not inspected).** Chunk file names contain a content hash, and the entry chunk lists lazy chunk names for preloading, so a change in any chunk should propagate to the entry and to everything that imports it. The count is the same (158) whatever the variable, including values that end up in a lazy chunk, which fits this.
6. **Where the values are read.** 17 `VITE_*` names, about 24 read sites in 14 files. Several are read at module top level: `CLIENT_ID` and `BASE_VALIDATOR_TIP` (`api/actions.ts`), `API_HOST` (`api/client.ts`, `config.ts`), `_projectId` (`config/RainbowKitLayer.tsx`, `config/wagmiConfig.ts`), RPC overrides (`config/wagmiConfig.ts`, `hooks/useEthBalancePoll.ts`), Sentry (`instrument.ts`). The build version is also baked in through `define: { __CLIENT_VERSION__ }` and `%VITE_CLIENT_VERSION%` in `index.html` (used by the freshness probe and the `X-Caw-Client-Version` header). `src/abi/addresses.ts` is generated per deployment and is a source-level input as well.

## Why it matters

- Verification by file hash is all or nothing: one different setting changes about half of the file names, so there is no partial match.
- `VITE_PROJECT_ID` alone differs between operators, so every node differs from any single baseline (for example one built in CI).
- The browser holds the keys that sign actions and decrypt DMs (see "Keys held in the browser" below), and the node operator serves the frontend, so today a user cannot tell whether the code they run is the published code.
- It also blocks other ways to establish that a served bundle is the one in the repository: a CI-built official bundle, content-addressed hosting, and a static frontend that works with any node.

## Options

| | Idea | For | Against |
|---|---|---|---|
| A | Read settings at startup from `/config.json` (data only), not from the bundle | Same bundle on every node; no rebuild to change a setting; fits a statically hosted frontend | Changes the boot order; about 24 read sites; version handling needs rework |
| B | Build once with placeholders, substitute the values at deploy time | No change to the boot order | Rewrites build output; SRI cannot be used on those files; the verifier must know the substitution points; cannot represent some settings (see the prototype below) |
| C | Each operator publishes a baseline for its own settings | No code change | Self-attested; little verification value |
| D | Verify only mirrors built with the canonical settings | No change | Community nodes cannot be verified |

## Sketch of A (for discussion)

- A small entry module fetches `/config.json`, validates it against a schema, then imports the application. Application code reads values through one accessor.
- Backward compatible: if `/config.json` is absent, fall back to `import.meta.env`, so existing installs keep working.
- `<link rel="preload" as="fetch">` for the config; network-first for it in the service worker. No new inline script, so the CSP hash is unchanged.
- The build version: see "Prototype of A" below. Moving it out of the JS has a cost in stale-build detection, so the prototype leaves it in.
- The installer writes `/config.json` instead of the frontend `.env` (separate change).
- Acceptance test: build with several different environments and require identical `files` in `build-manifest.json`.

## Prototype of B (file hashes and syntax only; the app was not run)

Same commit and toolchain as above. One build with a distinctive placeholder for every setting, one with a second set of placeholders (to find where the values are embedded), and normal builds with real-looking values for comparison. File names were compared after removing the content-hash part of the names (5 names that collide after that, such as `assets/index.js`, were left out of the file comparisons).

- **Where the values go.** Five files embed them: the entry chunk, three route chunks (`RainbowKitLayer`, `Onboarding`, `OnrampOnboarding`) and `index.html`. Substituting the placeholders keeps the file names of the placeholder build, so the renaming of ~158 chunks does not happen.
- **Reversible for distinctive values.** Replacing 12 values (project id, API host, MoonPay URL, Sentry DSN, sponsor URL, smart-EOA address, four RPC URLs, version) and replacing them back restored all 359 files byte for byte. Substituted `.js` files passed `node --check`.
- **Not reversible by value alone: short values.** `VITE_NETWORK_ID=2` occurs 151,566 times in the bundle and `VITE_VALIDATOR_TIP=1234` 89 times. A verifier would need recorded positions for these. (A first attempt used `7777777` as the placeholder; it is the Zora chain id and also occurs in `viem`'s chain list, so placeholders must be checked against the bundle.)
- **Settings that cannot be represented.** `VITE_STRIPE_PUBLISHABLE_KEY` never appears in the output, only a boolean derived from it; `VITE_SPONSOR_UNGATED_ENABLED` is compared with `'true'`; `VITE_L1_RPC_URL` and `VITE_L2_RPC_URL` are dead code when the `_FRONTEND` variants are set, as they must be in the placeholder build. A real build with the optional settings unset also drops whole modules (compared with a build that sets all 15 settings: one chunk fewer (`keyManager`), 158 names differ, and the output is 118,060 bytes, 0.46%, smaller), which a placeholder build never does.
- **Escaping.** A value containing `"`, a trailing `\` or an invalid escape such as `\x` breaks the file's syntax unless it is escaped; a valid escape such as `\b` keeps the syntax but changes the value (checked with `node --check`).
- **Service worker.** The MD5 of `index.html` appears in the generated `sw.js` precache list, so substituting into `index.html` leaves a stale revision unless `sw.js` is regenerated.
- **Not byte-identical to a normal build.** One chunk differed from a normal build with the same values only in minifier-chosen local names; this does not matter if the verifier compares against the placeholder build.

## Prototype of A (built and checked on one machine; not published)

A small prototype exists on a branch of a fork, in four commits: an accessor for the settings, the ~24 read sites switched to it (no behavior change), an entry module that loads an optional `/config.json`, and an opt-in to build without a network id. What was checked, on `master` `97cd13f3`, Node 22.23.4:

- **Builds without settings are identical.** Two builds of the same commit and version, with no per-deployment variables, gave identical file lists (360 files). A build that is given the settings still embeds them, because the fallback to `import.meta.env` remains; so the files only match across nodes if the installer stops passing `VITE_*` to the build and writes `config.json` instead.
- **Network id.** `vite.config.ts` refuses to build without an integer `VITE_NETWORK_ID`. The prototype skips that check only when `CAW_RUNTIME_CONFIG=1` is set for the build; without the flag it is unchanged. The runtime check (`CLIENT_ID_VALID`) still reports a missing id at startup.
- **In headless Chrome** (a bundle built without settings, served with the same fallback to `index.html` that the nginx config has): without `config.json` the app starts with the build-time values; with it, API and RPC requests go to the configured hosts; an invalid value is ignored with a console warning; changing `config.json` took effect on the next visit with the same browser profile (the service worker files were fetched; whether the service worker was in control was inferred, not checked).
- **`/api` calls that do not use the API host.** At least fourteen call sites (outside tests) call `fetch` with a relative `/api/...` path: eleven `fetch('/api…')` literals, one template literal (`MentionAutocomplete.tsx`), and two calls that pass a variable holding a relative `/api` path (`upload.ts`, `aiImage.ts`). `apiFetch` is not among them; it prefixes the active API host, then `VITE_API_HOST`. Examples are the trending hashtags (three components), stats, mention search, uploads and the DM routes. They go to the origin that served the page, not to the configured API host, with or without this change (seen in the browser run for the hashtag request; the others from reading the code). This only matters for a setup where the API host differs from the frontend origin. Whether any of them must stay same-origin was not checked.
- **Build version and `+dirty`.** Reading the version at runtime would make a service-worker-served old bundle report the newest version, which defeats the stale-build check in `bfcacheGuard.ts` and the `x-caw-client-version` header's use for diagnosing stale frontends; so the prototype keeps the version in the bundle. The version gets a `+dirty` suffix when `git status --porcelain` is not empty. On this commit, a non-frozen `yarn install --ignore-platform` in `FrontEnd` rewrites `yarn.lock` (1,020 insertions, 308 deletions), so a fresh install would build as `97cd13f3+dirty`. `yarn install --frozen-lockfile --ignore-platform` succeeded here without changing the file. `npm ci --legacy-peer-deps` in `client/` changed `client/yarn.lock`; the cause was not investigated.
- **Telling a label-only difference from a source difference.** Two builds of the same source that differ only in the version string (`97cd13f3` vs `97cd13f3+dirty`) have about 160 of the 360 file names different (44%) and `index.html` different, so counting differing files does not say why. Rebuilding the reference with the version the node declares in its `build-manifest.json` did: same source gave identical files (two builds), one changed string literal gave different files. Tested for one change on one machine.

## The installer (read, not run)

What the installer (`cli/src/steps`, at `97cd13f3`) would need, from reading it; the full installer was not run.

- **The installer edits `index.html` after the build.** `caw install` replaces the `__CAW_PUBLIC_URL__` placeholder in `dist/index.html` with the operator's domain (the OG and Twitter default tags). `caw update` does not. The `index.html` served by cawnest.com (whose frontend is rebuilt with `yarn build` after `git pull`, not by `caw install`) still contains the placeholder and its hash equals the one in its `build-manifest.json` (checked against the public files on 2026-11-10). So a freshly installed node serves an `index.html` that matches no manifest and differs per domain, whatever is done about settings; the page works, only the default OG tags are affected. Proposal: drop the replacement from `caw install`, as `caw update` already behaves. The cost, from reading `nginx.js` and `index.html`: nginx sends crawlers whose user agent is in its list to the API, which builds the tags; only crawlers outside that list see the static default, where `og:image` would be an unresolved URL. A checker would still need to accept the replacement for nodes that were already installed, by reversing it (substituting the node's domain back to the placeholder) before hashing, which tolerates only that edit; whether the domain also appears elsewhere in the file was not checked.
- **Settings.** `generate.js` writes `FrontEnd/.env` with the `VITE_*` values; `install.js` builds with that file and checks that the build user can read it. With A, it would write `config.json` from the same values, build with `CAW_RUNTIME_CONFIG=1`, and no longer depend on `.env` being readable. Other steps read only the backend `client/.env`. (`cli/bin/caw.js`, outside the steps, also reads `FrontEnd/.env` (`preloadFromEnv`).)
- **Where `config.json` lives.** `caw update` rebuilds `dist/`, which removes anything placed there, so the file has to be put back after each build. A kept copy inside the repository would be untracked and make the build version `+dirty`; `FrontEnd/.gitignore` has no entry that would cover a kept `config.json` (it lists `node_modules/`, `.env`, `dist`, `playwright-report/` and `test-results/`). Options: one more ignore line, or a copy outside the repository.
- **Lockfiles.** A new install runs `yarn install --ignore-platform` in `FrontEnd` (and `npm install --legacy-peer-deps` in `client`) without a frozen lockfile; `caw update` already uses `--frozen-lockfile` (see question 6).
- **Existing nodes** keep working: the fallback to `.env` values remains. Their files only become identical once the settings move to `config.json`; a migration step in `caw update` is a separate decision.

## Security considerations

- Hashes would cover code, not configuration. A node could still point the wallet at a different RPC or API host through `config.json`. Suggested mitigations: per-key validation (https only, allow-lists where it makes sense) and showing the effective configuration in the UI.
- `config.json` is served publicly like the bundle and is not covered by the file hashes. A hash match therefore says nothing about the settings; a node could match and still point the wallet at a different RPC or API host or Sentry DSN. The values that reach the bundle today are already public. `VITE_STRIPE_PUBLISHABLE_KEY` does not reach it (only a boolean derived from it), and `VITE_MOONPAY_API_KEY` reaches it only when `VITE_MOONPAY_BASE_URL` is also set; putting either into `config.json` would publish it in cases where the bundle does not. Beyond that, an RPC URL that contains an API key is visible either way, and keys put there should be ones that are fine to expose (for example restricted to the site).
- The prototype's checks only catch typos and wrong types (URL shape, digits, address length). They accept `http` URLs (convenient for local tests) and any host for RPC; the CSP allows `https:` and `wss:` connections broadly. A real version would likely restrict this to `https`, with `localhost` as the exception.
- The Verifier already states that it does not vouch for the backend or the contracts; this would add configuration to that list.

## Where a hash check can run, and what a tampered frontend can reach

- **The checker must not come from the node being checked.** A node serving a modified bundle can also serve a modified checker, which would report a match. The check has to run from somewhere independent of that node (an official mirror, a separate tool, or a checker the user already trusts).
- **What a tampered frontend can reach (from reading `master` `97cd13f3`, not run).** The frontend builds EIP-712 typed data and signs it either with the wallet (`signTypedDataAsync`) or with a session key held by the browser (`sessionAccount.signTypedData`, `api/actions.ts`). The session key is generated in the browser. With "require wallet unlock" on, it is stored encrypted with a wallet-derived key and kept decrypted in memory while in use (`hooks/useSessionKey.ts`); otherwise it is stored in plaintext (next item). So a modified frontend can have the session key sign actions the user did not intend, within what the session is authorized for; wallet-signed actions are shown by the wallet, but what the wallet displays for this typed data was not checked.
- **Keys held in the browser (from reading `master` `97cd13f3`, not run).** The session key is kept in `localStorage` (`caw-session-keys`). It is stored in plaintext unless the user turns on the "require wallet unlock" option, which is off by default in the four session-creation screens I read (post-mint onboarding, Quick Sign, Quick Sign renewal, and the profile page). The DM private key is also kept in plaintext in `localStorage` (`DmCryptoService.ts`). An open pull request (#377) reports that the protected session key can still end up in storage in plaintext through one code path. A modified frontend could read and send any of these.
- **What verifying the frontend does not cover: the DM key.** The DM private key is the `SHA-256` of a wallet signature over a fixed message, and the frontend sends that signature to `POST /api/auth/verify-dm`, so the node can compute the key; `docs/DIRECT_MESSAGING.md` says the server cannot decrypt. This is already reported in an open draft pull request (#296) that waits for a protocol decision. A verified frontend does not change it, because the unmodified frontend sends the signature by design.
- **Data written to the chain is a separate matter.** Signed actions are checked by the contracts and the action data is in calldata, so a node cannot alter a signed action (from the repository's description of the contracts; their checks were not re-read for this note). What a node can still do: show data that differs from the chain, keep DMs off-chain (outside the contracts' protection), delay or drop actions it receives (partly mitigated, since actions are also sent to other hosts; how far that helps was not checked), and keep its own moderation state. Verifying the frontend does not address these either.

## Who is the reference

A match means "this frontend was built from that published source at that commit". It says nothing about whether that source is the right one; that trust question already exists today (the protocol code lives in one repository) and a check only makes it visible. The risks are a single publisher (a compromised account would publish a false reference) and "mismatch" being read as "bad", which would pressure legitimate patched nodes toward the official build.

Ways to keep it from becoming a single point of trust, none of which is proposed as a requirement here:

- Allow more than one reference source (this repository, other community repositories such as a lab mirror, an operator's own), and let the user choose. The display says "matches reference X", not "official".
- Allow a reference to carry signatures from several parties, valid only when enough of them agree.
- Keep the build reproducible, so anyone can rebuild the same commit and compare the hash themselves instead of trusting a published file.
- Show a mismatch with its likely cause (older version, local patch, unknown) and state that a mismatch is not by itself a sign of harm. One possible grading: match; behind by N commits (a notice); version label differs only (for example `+dirty` from a rewritten lockfile; a caution); anything else (differs from every reference). "Differs from every reference" would be worded as "does not match the published source", not as "bad".

Putting the reference on-chain (for example registered by validators) would also be possible but needs a contract change; it is not suggested here.

## What this does not solve

Who publishes and signs the reference manifest; CORS on mirrors; hosting of the Verifier; nodes running patched code; and everything on the node side that a user cannot see, for example the DM key issue above. Building the reference manifest in CI would remove the manual step but needs a workflow; there are no workflows in the upstream repository today.

This is trust-minimizing, not trustless: a user still relies on the reference source and on whatever runs the check. Two related questions are separate from this note: showing the user what is being signed in a way the wallet itself can display (clear signing), and limiting what a session key may sign (kinds of action, duration, limits), which would cap the damage a modified frontend can do.

## Questions

1. Is hash-based verification of mirrors still intended (the Verifier and `docs/manifests/`)?
2. Which direction is preferred: A, B, or neither?
3. Who should publish the reference manifest, and should it be built in CI?
4. Is a change to the frontend boot order acceptable?
5. Which repository should the Verifier read as the canonical source, and would you accept more than one reference source (see "Who is the reference")?
6. Would you accept `--frozen-lockfile` for the installer's new-install `yarn install` in `FrontEnd`? The installer comment says the lockfile was generated on a Mac; on Linux with Node 22.23.4 the frozen install succeeded for this commit.
7. Is serving the API from a different origin than the frontend a supported setup? If yes, the (at least) fourteen relative `/api` calls would need to use the API host.
8. `caw install` replaces `__CAW_PUBLIC_URL__` in `dist/index.html` after the build; `caw update` does not. Would you accept dropping the replacement from `caw install`? The cost is that crawlers whose user agent is not in the nginx list get an unresolved `og:image` URL on the home page.

## Not verified

- The prototype of A beyond what is listed in its section: settings other than the API host, the RPC URLs, the network id and the project id were not exercised (Stripe, MoonPay, Sentry, sponsor API, smart-EOA address, the ungated flag); wallet connection and signing were not tried; only headless Chrome on one machine was used (no iOS Safari or bfcache restore); whether the service worker controlled the page on repeat visits was inferred; startup time was not measured; the extra request before the app code loads was not timed.
- The installer: no change to it exists, and it was only read, not run. Not checked: how many crawlers fall outside the nginx user-agent list, what the link previews look like without the replacement, whether the domain appears in `index.html` outside the OG tags, whether the Docker install path builds the frontend the same way.
- That a `FrontEnd` install with `--frozen-lockfile` leaves the lockfile unchanged was checked for one commit and one Node version only.
- Whether the fourteen relative `/api` calls must stay same-origin.
- Running the application built under B in a browser (B was checked on file hashes and syntax only).
- The effect of directory names other than `dist.prev-a1` left in the source tree.
- Reproducibility over time: all the builds in the 2026-11-02 reproducibility check used dependencies resolved on that day or weeks before; whether a later fresh install gives the same hashes was not checked. The measurements in the table above used one `node_modules` on one machine; only the 2026-11-02 check covers other machines.
- Reproducibility for inputs other than the fixed dummy values, and for other commits.
- Combinations of variables; the dependency-map hypothesis in item 5.
- Why the Verifier is not deployed.
- CORS on nodes other than the ones listed in item 2.
- What the wallet displays when asked to sign this typed data; how long a decrypted session key stays in memory.
- The key-handling findings come from reading `master` `97cd13f3` and the open pull requests as of 2026-11-10, not from running anything. The wallet-protection default was read in four screens only (post-mint onboarding, Quick Sign, Quick Sign renewal, the profile page); other session-creation paths were not read. Whether a proxy or CDN in front of a node sees the DM signature depends on the deployment and was not checked. The contracts' checks were not re-read for this note.
- Whether `gilgamesh-caw/caw-nfts` is private or absent: an unauthenticated request returned 404 on 2026-11-10.

## Reproduce

```sh
git worktree add --detach ../wt 97cd13f3
cd ../wt/client/src/services/FrontEnd   # node_modules resolvable from here and from client/
CAW_CLIENT_VERSION=97cd13f3 VITE_NETWORK_ID=1 npx vite build            # baseline -> dist/build-manifest.json
# move dist OUTSIDE the FrontEnd directory (not next to the sources), rebuild with one extra variable, e.g.
CAW_CLIENT_VERSION=97cd13f3 VITE_NETWORK_ID=1 VITE_PROJECT_ID=dummy npx vite build
# compare the "files" objects of the two build-manifest.json files
```

zinsanjp
