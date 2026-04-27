# CAW Protocol — Project Backlog

Outstanding TODOs, security considerations, and planned features. Each entry has enough context for an agent (or human) to pick it up cold.

---

## Smart Contracts

### Remove `clientReplications` / `clientReplicationEnabled` from CawClientManager

The `clientReplications[]` mapping, `clientReplicationEnabled` mapping, `addReplication` / `removeReplication` setters, `getClientChainEids`, `setClientReplicationEnabled`, and the L1→L2 sync logic that pushes them via `setClientChains` are all dead code from the old LZ-batch replication path.

**Why nothing depends on this on-chain:**
- `CawActionsArchive.submitReplication` (line 178) only checks `stakes[msg.sender] >= MIN_STAKE`. It does NOT consult `clientReplications[clientId]`.
- The slashing path (`resolveChallenge`, `slashIncoherentRoot`) also doesn't consult it.
- `CawProfileL2.setClientChains` is comment-flagged "this function only emits an event so indexers can observe config changes" — purely advisory.

**With optimistic-archive, replication is per-operator and permissionless.** Anyone with stake on any peered archive chain can replicate any client's batches. The `clientReplications` mapping doesn't gate, doesn't constrain, doesn't earn.

**Cleanup checklist** (do at next CawClientManager redeploy — it's an immutable contract, so this only happens when something else forces a redeploy anyway):

Contracts:
- [ ] Delete `ReplicationDestination` struct from `CawClientManager.sol`
- [ ] Delete `clientReplications`, `clientReplicationEnabled` mappings
- [ ] Delete `addReplication`, `removeReplication`, `setClientReplicationEnabled` functions
- [ ] Delete `getClientChainEids`, `getClientReplicationCount`, `getClientReplications` view helpers
- [ ] Delete `ClientReplicationAdded`, `ClientReplicationRemoved`, `ClientReplicationEnabledChanged` events
- [ ] Drop the LZ-fee plumbing in `CawClientManager`'s `addReplication` / `removeReplication` (the `cawProfile.syncReplicationInternal{value: msg.value}` calls)
- [ ] Drop the `receive() external payable` on `CawClientManager` (only existed for those LZ refunds)
- [ ] In `CawProfile.sol`: delete `syncReplication`, `_syncClientChains`, `setClientChainsSelector`. The `setClientChainsSelector` is in the L2 selector whitelist too — remove it from `isAuthorizedFunction` on `CawProfileL2`.
- [ ] In `CawProfileL2.sol`: delete `setClientChains` (the public function called via `_lzReceive`) and the `ClientChainsSet` event.

Deployment:
- [ ] `solidity/scripts/deploy.js` references — check whether the deploy still wires up the LZ peers / fees for replication-related routes. The challenge-relay path stays; only the `setClientChains` path goes away.

Off-chain (touch lightly — these are read paths):
- [ ] `MarketplaceIndexerService` / `ChainSyncService` / `InstanceRegistryService` — search for `getClientChainEids`, `clientReplications`, `ClientChainsSet`. Probably nothing reads these today, but verify.
- [ ] Any frontend code displaying "this client replicates to chain X" (probably none — search for `getClientChainEids` or the event).
- [ ] `client/src/abi/generated.ts` — regenerate from the new contracts.

Test:
- [ ] `solidity/test/multi-layer-test.js` and any client-creation tests that pass replication chain args — update signatures.

This work is a clean half-day. Rationale for deferring until the next contract change: deploying contracts purely to remove dead code costs LZ peer-config gas and risks address churn for off-chain configs. Bundle it with whatever other contract change goes out next (e.g. multi-storage-chain support — see `docs/MULTI_CHAIN_STORAGE.md`).

### Mint flow — three modes (frontend work)

The `mintSelector` / `mintAndUpdateOwners` plumbing is intentionally kept as latent capacity (see comments in `CawProfile.sol:44-50` and `CawProfileL2.sol:280-289`). Once mainnet contracts ship they're immutable, so removing the wiring would lock us out of a flow we might want.

**Current state worth knowing:**
- `mintAndDeposit` (cross-chain) sends `depositAndUpdateOwners`, which sets `ownerOf[tokenId]` on L2 but **does NOT set `usernames[tokenId]`** on L2. L2's `usernames[]` mapping is currently dead in cross-chain mode — the only writer (`mintAndUpdateOwners`) is never reached. `getTokens()` returns an empty string for `username`, but the backend doesn't read it (FE/backend pull username from L1's `usernames[]`). So no live bug, but the field is misleading.
- Pure `mint()` doesn't lzSend at all → L2 doesn't even know the token exists.

- [ ] **Mint UI: three explicit modes** (frontend)
  - **Mint + deposit** (current default, uses `mintAndDeposit`) — pays mint + deposit + auth fees, CAW usable immediately.
  - **Mint + authenticate (no deposit)** — pays mint + auth fees, registers the token with the chosen client without depositing CAW yet. Closes the awkward gap where a freshly-minted token can't receive internal CAW transfers from another token until *something* tells L2 it exists. Needs a new L1 path (`mintAndAuthenticate`?) that mints and lzSends in one call. Either selector works:
    - Reuse `authSelector` (`authenticateAndUpdateOwners`): minimal change, but L2 still doesn't learn the username at this step (matches current `mintAndDeposit` behavior).
    - Use the parked `mintSelector` (`mintAndUpdateOwners`): also pushes the username to L2 so `getTokens().username` finally returns something useful in cross-chain mode.
  - **Mint only** — pays mint fee only. Token exists on L1 (marketplace/identity); L2 has no record. User authenticates later when they're ready to use the platform.
  - Tooltip explains the fee for each mode.
  - **Side question**: do we want L2 usernames populated for non-co-deployed setups? If yes, `mintSelector` is the right path forward; if not, the L2 `usernames[]` mapping should probably be removed in a future deploy to avoid the misleading empty-string field in `getTokens()`.

---

## Security & Pre-Launch

### Host hardening — operator runbook + install.sh defaults

**Status:** Filed 2026-04-28 after a security review of a live testnet
install. Several host-level issues are easy wins that the CLI / install.sh
can either set automatically or document as a post-install checklist.

**Items (ordered by impact):**

#### SSH hardening (highest impact)

A fresh Ubuntu / Debian VPS ships with `PermitRootLogin yes` +
`PasswordAuthentication yes` — bots brute-force these constantly. Operators
running CAW have a high-value target (validator key on disk) so the
default config is genuinely dangerous.

- [ ] **Document an SSH hardening checklist in README** for operators to
      run BEFORE the first install:
        ```
        # 1. Set up SSH key auth (from local machine)
        ssh-copy-id user@server
        # 2. Disable password auth + root login on the server
        sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin no/; \
                     s/^PasswordAuthentication yes/PasswordAuthentication no/' \
                     /etc/ssh/sshd_config
        sudo systemctl reload ssh
        ```
- [ ] **Optionally: install.sh detects + warns** when the running config
      has either set to `yes`. Don't *change* without explicit operator
      consent (lockout risk if no key auth is configured), but flag it
      loudly with a tipBlock + the exact sed commands above.

#### fail2ban as a default install package

[fail2ban](https://github.com/fail2ban/fail2ban) watches auth logs and
temporarily bans IPs that fail too many SSH login attempts. With it
running, brute-force attempts get blocked after 5 failures for ~10
minutes — bots move on. Default config covers SSH out of the box;
nginx + postfix jails available with one-line additions.

- [ ] **Add `fail2ban` to install.sh's `ALWAYS_PKGS` apt list** so every
      CAW host gets it preinstalled. Default config (the systemd-journal
      backend on Ubuntu 22.04+) just works for SSH; we don't need to
      configure anything beyond `apt-get install -y fail2ban`.
- [ ] Verify the systemd unit autostarts:
      `sudo systemctl status fail2ban`. Should be `active (running)` after
      install.

#### .env file permissions on disk

**Status:** Partially fixed in generate.js (writes new .env files at mode
0600 / 0640). Existing installs from before this change still have the
group/world-readable mode 0664 — operators should chmod manually.

- [ ] **Document a one-time fix for existing installs:**
        ```
        sudo chmod 600 /var/www/<domain>/client/.env
        sudo chmod 640 /var/www/<domain>/client/src/services/FrontEnd/.env
        ```
- [ ] Already wired: generate.js writes new files at the right mode +
      explicitly chmods after write to handle the "file already exists"
      case (Node's writeFileSync mode option is ignored when the target
      already exists).

#### Validator key off the API host (mainnet)

For testnet, having `VALIDATOR_PRIVATE_KEY` in `client/.env` on the same
host as the public-facing API is fine. For **mainnet**, an RCE in the
API immediately exfiltrates the validator key.

- [ ] Document a "two-host topology" in README:
        - Host A: validator-only node (no public ingress, validator key
          here, talks to L2 to submit batches)
        - Host B: api-only / frontend-api node (public ingress, no
          validator key, talks to host A's API for tx submission)
- [ ] Or: move the key into a sealed-secrets store (HashiCorp Vault, AWS
      Secrets Manager, or systemd's `LoadCredential=`) — backend reads
      from FD instead of env. Bigger lift; document for mainnet only.

#### npm install-script hardening

**Status:** Discussed earlier and decided against for testnet because
`prisma`, `@swc/core`, and `@tailwindcss/oxide` legitimately need
postinstalls — the allowlist gets brittle. For mainnet this is the
single highest-impact mitigation against the supply-chain attack class.

- [ ] Configure `npm config set ignore-scripts true` in `client/.npmrc`.
- [ ] Maintain an explicit allowlist of packages whose install scripts
      we DO run, via `npm rebuild <pkg>` after install.
- [ ] CI test that exercises a fresh install + first prisma migration to
      catch any silently-broken postinstall before release.

#### Process inspection / .env exposure via /proc

Anyone with shell access as `caw` can `ps eauxwww` or `cat
/proc/<pid>/environ` and see every env var the running node has,
including `VALIDATOR_PRIVATE_KEY`. The fix is reading the key from a
file pm2 doesn't put in env — but that's a real refactor.

- [ ] Backlog: validator/replicator services read keys from
      `/etc/caw/keys/validator.key` (mode 0400, owned by caw) instead of
      `process.env.VALIDATOR_PRIVATE_KEY`. ecosystem.config.cjs drops
      the env-var line.

#### Outbound firewall for the validator host

The validator only needs outbound to: L1 RPC, L2 RPC, replication-archive
RPC, mainnet RPC (for prices), Reown WebSocket, Sentry (if enabled),
Giphy (if enabled), npm registry (during install), apt mirror (during
bootstrap). A `ufw default deny outgoing` policy with allowlists
constrains an RCE's exfiltration paths.

- [ ] Backlog (mainnet): add `ufw default deny outgoing` to install.sh's
      firewall step, with allow-rules for the destinations above.
      Operators with custom RPC hosts will need a hook to add their own
      allows.

### Withdrawals silently dropped when `withdrawFee == 0`

**Severity:** Low (no asset loss; user re-submits a withdraw and gets credited next time). **Discovered:** 2026-04-27. **Affected:** `processActions` and `safeProcessActions` in `solidity/contracts/CawActions.sol`.

When a batch contains WITHDRAW actions but the validator passes `withdrawFee == 0`, `_handleWithdrawals` runs (populating the in-storage `_pendingWithdrawIds` / `_pendingWithdrawAmounts`) but `_executeWithdrawals` is skipped — the LZ message to L1 is never sent. The user's `usedCawonce` bit is set, so the action *did* land, but the withdrawable balance never reaches L1. The pending storage arrays sit until the next batch with withdraws clobbers them.

**Why it exists today:**

Both call sites are gated:
```solidity
if (sc.withdrawCount > 0) {
  _handleWithdrawals(...);
}
if (sc.withdrawCount > 0 && withdrawFee > 0) {
  _executeWithdrawals(...);
}
```

The split was original code (since `822a35d`, the packed-binary refactor) — it was never the case that `_handleWithdrawals` ran inside the same `if` as `_executeWithdrawals` in `processActions`. The asymmetry between `processActions` (split) and `safeProcessActions` (combined) was fixed in `55bcb17` by mirroring the split in `safeProcessActions`. **No on-chain behavior changed there** — `processActions` was already this shape.

**The two real failure modes:**

1. **bypassLZ mode (storage on Ethereum):** `withdrawFee` is *legitimately zero* — `CawProfileL2.setWithdrawable` short-circuits to call `cawProfile.setWithdrawable(...)` directly with no LZ involvement. Today, `_executeWithdrawals` is gated off and the user's withdraw is silently dropped despite zero fee being correct.
2. **LZ mode (storage on Base/Arbitrum) with an under-funded validator:** validator forgets to compute `withdrawFee` via `withdrawQuote`, passes 0. Today: silent drop. With the gate removed: `lzSend` reverts the whole batch (LayerZero rejects underpriced messages). Failing loud is arguably better.

**Proposed fix (one-liner):**

Drop the `&& withdrawFee > 0` gate. `CawProfileL2.setWithdrawable` already handles bypassLZ correctly (no LZ fee needed). For LZ mode, an underpriced send will revert with a clear LayerZero error instead of silently dropping. Operators are forced to compute the quote correctly.

**What we don't know yet (must verify before fixing):**
- That LayerZero's `_lzSend` actually reverts with `msg.value == 0` rather than silently dropping. Documented behavior says it reverts; not yet confirmed against the LZ OApp source.
- That no operator tooling intentionally calls `processActions` with `withdrawFee == 0` while expecting silent skipping. (Audit `client/src/services/ValidatorService/index.ts`'s tx-build path.)
- That the stale `_pendingWithdrawIds` / `_pendingWithdrawAmounts` arrays don't leak into a later call's accounting. (Confirmed harmless on read because the next `_handleWithdrawals` overwrites with `=`-assignment, and `_executeWithdrawals` self-deletes after use — but worth re-checking with a unit test before the fix lands.)

**Pre-fix checklist:**

- [ ] Test: bypassLZ mode + WITHDRAW + `withdrawFee == 0`. Today: withdrawable balance NOT updated on L1. After fix: balance IS updated.
- [ ] Test: LZ mode + WITHDRAW + `withdrawFee == 0`. Today: silent drop. After fix: tx reverts with LZ underpayment error.
- [ ] Test: two consecutive batches, first with WITHDRAW + zero fee, second with no withdraws. Verify `_pendingWithdrawIds` / `_pendingWithdrawAmounts` aren't incorrectly applied to the second batch.
- [ ] Audit `ValidatorService` to confirm `withdrawFee` is always quoted via `withdrawQuote` (or `0` only when bypassLZ). Today's silent-drop covers up any missing quote logic; the fix will surface it.

**Why it's not blocking testnet launch:** the failure mode is at most "user re-submits a withdraw" — no funds are stuck and no signatures are wasted (the `usedCawonce` bit prevents replay, but the user can submit a fresh withdraw with a new cawonce). The risk of touching this without proper tests is higher than the risk of leaving it.

### LZ DVN 3-of-3 config — verify before mainnet

**Status:** Implemented in `solidity/scripts/deploy.js` phase 6 (and `solidity/scripts/lz-dvn-config.js`). Runs automatically on mainnet deploys; testnet intentionally uses LZ defaults.

**Config:** 3-of-3 required DVNs across every cross-chain pathway (CawProfile ↔ CawProfileL2_L2, CawProfile ↔ CawProfileL2_L2b, CawChallengeRelay_L2 → CawActionsArchive_L2b):

- LayerZero Labs
- Nethermind
- Google Cloud

DVN addresses are per-chain, pulled from LayerZero's metadata API on 2026-04-24. Send and receive sides of each pathway use the same provider identity set, protecting against the "DVN mismatch" pitfall LZ's docs warn about.

**Pre-mainnet checklist:**

- [ ] Re-pull DVN addresses from `metadata.layerzero-api.com/v1/metadata/dvns` right before mainnet deploy and diff against `scripts/lz-dvn-config.js::DVNS_BY_CHAIN_MAINNET`. If LZ moves an address, our hardcoded value is stale.
- [ ] Verify send/receive library addresses (`LZ_LIBRARIES_MAINNET`) haven't been rotated — run `endpoint.defaultSendLibrary(destEid)` / `defaultReceiveLibrary(destEid)` for each pathway and confirm they match what the script uses.
- [ ] After mainnet deploy, for each of the 6 pathways, call `endpoint.getConfig(oapp, library, destEid, 2)` and assert the on-chain `requiredDVNs` array is sorted ascending and contains exactly the 3 expected addresses.
- [ ] Send one test cross-chain message and observe all 3 DVNs sign before delivery.
- [ ] Renounce the ability to alter `setConfig` for each OApp (or move to multisig) once verified — otherwise a compromised deployer key can downgrade the DVN set.

### Install CLI privilege split — drop frontend build to caw user

**Status:** Filed 2026-04-27 to unblock testnet launch. install.sh currently
runs the entire Node CLI as root because two of its responsibilities require
root (writing /etc/nginx/sites-available + reloading nginx, and starting pm2
with `user:` directives in the ecosystem). Side effect: the frontend `yarn
build` step runs as root.

**Why it matters:** signatures verify upstream package integrity, but a
build-time side effect in a vite plugin or rollup transform that slipped
through (zero-day, sigstore compromise, transient typosquat before audit
catches it) executes with full filesystem write access. Running as the
`caw` user contains the blast radius — same package compromise becomes
EACCES instead of `unlink('/etc/something_important')`.

**Proposed split:**

  • Phase A (caw user) — clone, npm install, yarn install, yarn build,
    prisma db push, file writes under $CAW_DIR. The bulk of install.
  • Phase B (root) — only the two privileged actions:
      1. Write /etc/nginx/sites-available/<domain> + nginx -t + systemctl reload
      2. pm2 start (so the ecosystem's user: caw directive can drop
         privileges to caw at app launch)

**Implementation outline:**

  1. Refactor `cli/bin/caw.js` so the install action ends after writing
     ecosystem.config.cjs + the env files. Move `configureNginx` and
     `startServices` to standalone subcommands: `caw nginx` and `caw start`.
  2. install.sh runs the main CLI as caw (back to current pre-1ae6871
     behavior, minus the chown step), then `sudo node cli/bin/caw.js nginx
     --dir $CAW_DIR` and `sudo node cli/bin/caw.js start --dir $CAW_DIR`
     as root.
  3. The standalone subcommands no-op when run twice (nginx config write
     is idempotent; pm2 start handles already-running apps).

**Why option 1 (this) over option 2 (vendor a prebuilt dist):**

  • dist/ embeds per-install env vars (VITE_CLIENT_ID, VITE_PROJECT_ID,
    L1/L2 RPC URLs) at build time — can't ship a generic dist
  • Frontend changes from any contributor would need a dist rebuild +
    commit; people will forget; stale builds will ship
  • +5-10 MB per build in the repo, churning often

The privilege-split is mechanical (a few hours of careful work) and
matches every other principle-of-least-privilege production setup.

**Tests after refactor:**

  • Fresh install via curl one-liner ends with services running, nginx
    serving the site, cert valid
  • Re-run on the same host doesn't break anything (idempotency)
  • A node not running install.sh's bootstrap (e.g. dev box) can still
    `node cli/bin/caw.js install --dir .` — the new subcommand split
    shouldn't require sudo for the dev path

### Admin/owner abilities — verify before mainnet

**Core lockdown is DONE** via the `OnlyOnce` pattern (`solidity/contracts/OnlyOnce.sol`). All protocol-critical setters are gated by `onlyOnce(key)` and permanently disabled after their first successful call:

- `CawProfile.setMinter`, `setUriGenerator`, `setL2Peer` (per-eid), and now also raw `setPeer` (per-eid)
- `CawProfileL2.setL1Peer`, `setCawActions`, raw `setPeer` (per-eid)
- `CawActionsArchive.setPeer` (per-eid) — newly added
- `CawChallengeRelay.setPeer` (per-eid) — newly added
- `CawClientManager.setCawProfile`

Strictly stronger than `renounceOwnership()` because it's per-setter and doesn't need a separate "remember to renounce" step.

The inherited `OAppCore.setPeer(uint32, bytes32)` was the dangerous one — `public virtual onlyOwner`, would have let a compromised owner swap an existing peer at any time and forge LZ messages. Now overridden in every OApp-extending contract with a per-eid `onlyOnce` so existing peers are immutable forever; new chains can still be added by setting peers for fresh eids. (Commit `3c445c0`.)

Intentionally unlocked (operational, not protocol-critical):

- `CawClientManager` per-client fee setters — controlled by each client's owner, not the protocol owner. By design.
- `OAppCore.setDelegate` — not virtual (can't override). Handled by the multisig/renounce step in the deploy checklist instead.

Removed entirely:

- `CawProfileMarketplace` ownership + `setAllowedPaymentToken` — the marketplace no longer inherits `Ownable`. The allowed-payment-token set is now fixed at construction (per-env list passed by deploy.js: WETH/USDC/USDT on mainnet plus per-env CAW). ETH is always allowed. To change the set, deploy a sibling marketplace.

**Pre-mainnet checklist:**

- [ ] Deploy runs all `onlyOnce`-gated setters once in `deploy.js` (verify none are missed).
- [ ] Spot-check each locked setter post-deploy by calling it again and confirming `"OnlyOnce: already called"` revert.
- [x] **Marketplace has no admin (done 2026-04-25)** — `CawProfileMarketplace` no longer inherits `Ownable`; payment-token list fixed at construction.
- [x] **Delegatecall audit (done 2026-04-25)**: only two delegatecall sites in the codebase (`CawProfile._lzReceive`, `CawProfileL2._lzReceive`); both call `address(this).delegatecall(...)` (target is self, not user-controlled), behind a whitelisted-selector check, behind OApp's endpoint+peer auth, with `fromLZ` flag flipped on success only. Selector collisions against all inherited functions (Ownable / ERC721 / ERC721Enumerable / OApp / OAppCore) checked and ruled out. No further action needed.

### DDoS protection — multiple surfaces, partial coverage today

The CAW node has several distinct DDoS surfaces; rate-limit coverage is uneven. Audit each before mainnet and close the gaps.

**Existing coverage (to verify, not just trust):**
- `express-rate-limit` on `/api/upload` (image + video routes), `/api/marketplace/listings/:id/sold`, and `/api/shorturl` (two limiters: anonymous + authenticated).
- Redis-backed rate limit on session creation (`session_ratelimit:<address>` keys, 20/day per address).
- On-chain rate limit on free actions (unlike, unfollow) — 30/min per `senderId` in `client/src/api/routes/actions.ts:38` to prevent validator-griefing on zero-cost actions.

**Surfaces currently unprotected (or under-protected) — fix before mainnet:**

- [ ] **Action submission (`/api/actions`)** — the hot path. Each accepted action consumes validator gas. Today's free-action limit only covers unlike/unfollow; paid actions (`caw`, `like`, `recaw`, `follow`) rely on the on-chain spend cap, which works but doesn't prevent rapid-fire signature-flooding from a single client. Add per-IP and per-`senderId` rate limits at the route level. Tier the per-`senderId` limit by stake (more stake = higher rate ceiling) since high-stake users are the ones whose actions actually settle.

- [ ] **Read endpoints (`/api/caws`, `/api/users/:username`, `/api/users/by-token/:id`, `/api/marketplace/*`, search)** — Postgres + ES queries on every request, no rate limit. A scraper can hammer these and slow down legitimate users. Add a global per-IP limit (e.g. 200 req/min) plus a tighter per-IP limit on the search endpoint specifically (search is the most expensive). express-rate-limit with the existing Redis-backed store is the right shape.

- [ ] **WebSocket/Socket.IO** — `socket.io-client` connections aren't currently rate-limited at handshake. A connection-flood attack opens many sockets, exhausts file descriptors, no req/min limiter applies. Cap concurrent connections per IP at the socket.io middleware level (~10).

- [ ] **DM endpoints (`/api/dm/*`)** — DMs are E2E encrypted so no content-scanning, but they're still inserts into Postgres. A peer hammering relayDmToPeers with spoofed identities can fill the DB. The existing `requireAuth` gate covers identity spoofing; add a per-recipient inbound rate limit to bound DB growth.

- [ ] **L1 minter / deposit endpoints** — these proxy to expensive on-chain ops. A client repeating a failed mint transaction can pile up `txQueue` rows. Per-`senderId` cap on simultaneous in-flight `txQueue` entries.

- [ ] **L7 / nginx layer** — install.sh's nginx server block doesn't set `limit_req_zone` or `limit_conn_zone`. Add reasonable defaults at the nginx layer (e.g. 50 req/s burst with a 100-conn cap per IP). nginx limits run before the Node app even sees the request, which protects from a stampede the Node event loop can't handle.

- [ ] **CDN-friendly cache headers on read paths** — most public reads (`/api/users/:username`, `/api/caws/:id`) could be cached for 5–30 seconds at the edge with a `Cache-Control: s-maxage=...` header. Doesn't help if the operator isn't behind Cloudflare/Fastly, but it's free defense for those who are.

- [ ] **Cloudflare in front of the node (operator option)** — document this in the README. Cloudflare's free tier handles L3/L4 floods we can't, and the operator just needs to flip an "orange cloud" on. Caveat: a transparent proxy means the Node app sees Cloudflare IPs, not real clients — `app.set('trust proxy', ...)` and `req.ip` need to resolve to the X-Forwarded-For correctly for our rate limits to bucket per real client.

Estimate: ~1 day to cover the route-level pieces (express-rate-limit on each path) and another half day for the nginx + websocket pieces. The Cloudflare/CDN parts are documentation only.

---

## Replication & Testing

### End-to-end replication tests — mostly covered

The replication path was rewritten as the optimistic archive + trustless `CawChallengeRelay` (commit `b536eae`); the old LZ-based `CawActionsReplicator` is gone.

**Already tested:**

- **Real archive submissions.** `solidity/test/archive-test.js` covers `submitReplication`, finalization after challenge period, deposits / withdraws, pending-submission gating, multi-submission invalidation on slash.
- **Mode B (mismatched root) slashing on chain.** `archive-test.js` covers full-stake slashing on fraud, all-pending-submissions invalidated when one is slashed, false-challenge rejection.
- **Mode A and Mode B in production.** `ValidatorService` has built-in `CORRUPT_REPLICATION=true` + `CORRUPT_MODE=A|B` test selectors (`index.ts:2097-2143`). Mode A corrupts the merkle root → monitor catches it via `slashIncoherentRoot`; Mode B corrupts the rebuild path → `slashFraud` via merkle proof. Both have been exercised end-to-end on testnet.
- **`slashIncoherentRoot` path** (added 2026-04 / `a9b51e5`) — exercised live by the corrupt-validator test rig.
- **Live testnet challenge flow.** `solidity/scripts/test-slash.js` runs the full path: deposit stake on L2b → submit bad data → relay correct hash via `CawChallengeRelay` on L2 → wait for LZ delivery → `resolveChallenge` on L2b → verify slashed.

**Still missing:**

- [ ] **Mode A unit test** in `archive-test.js`. Mode A is exercised live but not in solidity unit tests; adding a `slashIncoherentRoot` test alongside the existing `slashFraud` ones would let CI catch regressions without needing testnet.

### Stale test cleanup

- [ ] `solidity/test/multi-layer-test.js` references `migratePartialCheckpoint` (and possibly other removed functions). Either rewrite against the current architecture or delete in favour of new tests written for the optimistic archive flow.

---

## Frontend

### Re-enable tsc in the production build

**Status:** Disabled 2026-04-27 to unblock testnet launch. The build script
went from `tsc -b && vite build` → `vite build`; type errors no longer fail
the build. A `yarn typecheck` script still exists for CI / dev use.

**Why disabled:** 17 latent type errors that ran fine in dev (vite ignores
tsc errors when bundling) but blocked production install. Hitting them
under time pressure during the testnet launch wasn't worth the risk of a
half-applied fix.

**The 17 errors when this was filed:**

- `Feed.tsx(256,19)` — `string[]` passed where `number[]` expected
- `Notifications.tsx(443,45)` — `string | undefined` passed where `string` expected
- `Notifications.tsx(565,37)` — `undefined` used as index type
- `ProfileChooser.tsx(325–356)` — 8× `selectedToken` possibly undefined (needs an early-return guard or `?` chains)
- `ShareModal.tsx(130,14)` — function name truthiness check (`if (closeModal)`) — should be calling it
- `ShareModal.tsx(191,14)` — `<style jsx>` not in `StyleHTMLAttributes` (drop `jsx` prop or switch to `<style dangerouslySetInnerHTML>`)
- `tokens.ts(7,3)` and `(13,3)` — `Token` type requires `price` field; objects defined without it
- `useCawonce.ts(46,58)` — `.toBigInt()` on `never`-typed value (likely a type narrowing issue around viem return types)
- `AccountSettings.tsx(32,7)` — `string` indexing into `Record<\`0x${string}\`, …>`; needs a type assertion or branded address
- `AccountSettings.tsx(221,30)` — `token` parameter implicitly `any`
- `MutedContent.tsx(87,39)` — `createdAt` not on `CawItem` (renamed somewhere?)
- `optimisticPostsStore.ts(2,10)` — imports `FeedItem` from `~/types` but the type isn't exported there

**Re-enable steps:**

1. `cd client/src/services/FrontEnd && yarn typecheck` to see the live list (errors may have changed since this was filed).
2. Fix each. Most are 1-3 line edits. The `Notifications.tsx` ones share root causes and likely fix together.
3. Restore the build script in `package.json` to `tsc -b && vite build`.
4. Add a CI check that runs `yarn typecheck` so this doesn't regress silently again.

---

### Spurious "access other apps and services" prompt during DM enable

**Reported:** 2026-04-28. Operator hit Chrome's *"test.caw.social wants to:
Access other apps and services on this device"* permission dialog while
enabling DMs (which triggers a `wallet_signTypedData_v4`). It's the
WebUSB / WebHID permission, fired by RainbowKit / WalletConnect's
hardware-wallet connectors (Ledger, Trezor) initializing on first wallet
interaction — even when the operator is using MetaMask / Rainbow.

**Why it's bad UX:** the dialog mentions "other apps and services" without
context, no Web3 user expects a hardware-wallet permission prompt unless
they're plugging one in, and the alarming wording can spook operators
into blocking → which then degrades the actual flow if they ever DO
want to use a hardware wallet.

**Fix options:**

1. **Filter the wallet list** in `client/src/services/FrontEnd/src/config/Web3Provider.tsx`'s
   `getDefaultConfig()` to exclude Ledger / Trezor / hardware-wallet
   connectors by default. Add a "More wallets…" affordance that
   re-enables them when the user explicitly asks. Cleanest UX.
2. **Defer connector init** — RainbowKit lazy-loads connectors on
   wallet click, not on app boot. Verify we're not eagerly importing
   Ledger / Trezor SDKs somewhere that's forcing them to register.

Option 1 is the fix; option 2 is the diagnostic that confirms the
right scope before we ship.

**Steps:**

- [ ] Audit `Web3Provider.tsx` to see which wallet connectors RainbowKit
      registers by default.
- [ ] Override `wallets` to exclude `ledgerWallet` / `trezorWallet`.
- [ ] Add "Connect a hardware wallet" link/button on the connect modal
      that re-adds them on demand.
- [ ] Verify the WebUSB permission no longer fires on first signMessage.

### UX — features not started

- [ ] **Image modal** (`client/src/services/FrontEnd/src/components/FeedItem.tsx:966, 994, 1022`)
  - Comment: `// TODO: Open image in modal`
  - Clicking on post images should open a full-size modal.

- [ ] **Real gas price** (`client/src/services/FrontEnd/src/components/GasPriceLine.tsx:12-15`)
  - Currently hardcoded `const ethPrice = 1`.
  - ETH price IS already tracked by `ChainSyncService` (`usdPerEth` cached, `chainData` updated every 5 min). Frontend just needs to consume it via the `chainData` API.

- [ ] **Reported content moderation (EXPLICIT / REMOVED)** — IN PROGRESS
  - **Done**: report modal sub-options (Explicit vs Illegal/Harmful), reason filtering on admin dashboard, success confirmation screen, duplicate reports update instead of 409.
  - **Still needed**:
    - Add `moderation` enum field (`NONE | EXPLICIT | REMOVED`) to `Caw` model and migration.
    - `PATCH /api/caws/:id/moderation` endpoint, `requireAdmin`.
    - `shapeCaw` / `getCawIncludeConfig`: pass moderation through, blank content for `REMOVED` server-side.
    - `FeedItem`: `EXPLICIT` shows blurred overlay with click-to-reveal; `REMOVED` shows stub ("This caw was removed from this domain. It still exists on chain through the CAW protocol.") with no action buttons.
    - Propagation: explicit/removed status applies to quoted/recawed parents automatically via nested includes.
    - Admin row buttons: "Mark Explicit", "Remove Post", "Clear Moderation".

- [ ] **Operator-level user removal (transparent extension of REMOVED moderation)**
  - When a client operator decides a user is bad-faith (illegal content, sustained spam, repeated hate speech), they can remove that user **from this client only**. The user is told. Their on-chain content is unaffected and remains visible from any other client.
  - This explicitly *replaces* the originally-considered "shadow banning" feature. Shadow banning hides content silently from the banned user, which is deceptive and operator-asymmetric — it's the kind of moderator power the protocol's transparency ethos is designed to make hard. Hard, transparent removal is the same enforcement capability without the deception.
  - DB: `User.removedFromClient: Boolean` (per-instance, not synced across clients).
  - API: when querying feed/search/trending/suggested-users, filter out users with `removedFromClient = true`. The user themselves still sees their own posts (so they can move to another client without surprise) and gets a banner: *"You've been removed from this client. Your content is still on-chain — try connecting through a different domain."*
  - Reuses the existing `REMOVED` moderation render-stub pattern for the user's posts when seen from this client by other users.
  - Admin UI to manage removed users (extend ReportsAdmin page).
  - Block + mute already cover the per-user "I don't want to see X" case; this is purely about operator-level enforcement.

- [ ] **Tip ceiling exceeded warning**
  - Quick Sign sessions store a `tipCeiling`. The autonomous signing path uses `min(currentMarketTip, ceiling)`, so the user is never charged more than agreed. If validator network's market tip rises above the ceiling, actions still get signed (with the ceiling) but may be rejected.
  - **What's needed**:
    1. Hook that periodically compares `getCurrentMarketTip()` to active session's `tipCeiling`.
    2. Non-blocking banner near the top of MainLayout when underpriced: *"Quick Sign tip ceiling ($X) is below the current network rate (~$Y). Posts may be slow or rejected. [Renew Quick Sign]"*
    3. On all-validator rejection: explicit modal: *"All validators rejected your action because your tip is too low. Renew Quick Sign with a higher ceiling?"*
    4. `QuickSignRenewModal` opens with ceiling preset to `currentMarket × 3`.
  - **Why deferred**: the cap protection itself ships; this UX polish is only needed once validators actually raise tips significantly. Wait for real-use signal.

- [ ] **English auction "stuck" recovery UX (frontend)**
  - **Status**: contract-side mostly resolved. As of `db84bf7`, `cancelListing` works on English auctions even with active bids — the seller can back out cleanly and the bidder is refunded automatically. `reclaimBid` remains as a public safety valve for the rare case where the seller transferred the NFT away and won't act.
  - **Frontend work still needed**:
    - "Cancel auction" button on the seller's own active English auctions, even when there's a highest bidder. Confirmation dialog explains the bidder will be refunded.
    - Detect "seller no longer owns NFT" stuck state by checking `cawProfile.ownerOf(tokenId) === listing.seller`. If false, surface the banner to the highest bidder: *"This auction can no longer be settled — the seller transferred the NFT away. [Reclaim your bid]"* (calls `reclaimBid`).
    - Make the pull-pattern `withdrawBid` flow discoverable for previously outbid bidders.
    - Optional: public "stuck listings" view across the marketplace with a public Reclaim button (self-healing).
  - **Backend**: optional — `MarketplaceIndexerService` could set a `stuck` flag on the listing record so the FE doesn't hit the chain on every page load. Lower priority now that the seller has a proactive cancel path.

---

## Backend Services

### Validator Mesh Network — partly done

**Already in place:**

- **On-chain instance registry**: `CawClientManager` emits `InstanceRegistered` / `InstanceUpdated` events carrying each instance's `apiUrl` and `validatorAddress`. `InstanceRegistryService` auto-registers the local instance on startup, so any node coming online broadcasts itself.
- **Frontend host failover with reputation**: `useInstanceStore` reads the registry and exposes `getApiHosts()`; `apiFetch` walks that list in response-time-priority order; `useHostVerification` records failures and blacklists hosts that serve unverified posts. 5xx errors trigger automatic failover; 4xx don't (correct semantics).
- **DM relay across instances**: `DmRelayService` reads the same registry, fans out incoming DMs to peer instances via `POST /api/dm/relay` (fire-and-forget), so a conversation can happen across domains regardless of which instance each side connects to.

**Still missing:**

- [ ] **Validator-to-validator action gossip**. `relayDmToPeers` covers DMs but there's no equivalent for actions — the FE can fail over to a peer instance for *reading*, but action submission doesn't get gossiped between validators. Consequence: if a user submits to validator A and A goes down before broadcasting on chain, the action is lost; another validator can't pick it up. Add an `action-relay` route + service mirroring `DmRelayService`. Reuse the same on-chain registry + signed-payload pattern (`/api/dm/relay` already validates that the payload is signed by the sender's wallet, so no extra peer auth is needed). Dedup by `(senderId, cawonce)`.
- [ ] **Action submission resilience inside the FE**. When the user posts and validator A 5xx's, we currently fail the post — we don't retry on the next host. Mirror the read-side failover for action submission too (`api/actions.ts`).
- [ ] **Stale registry handling**. `useInstanceStore` and `DmRelayService` both query `InstanceRegistered` events from `fromBlock: 0` every refresh. Cache the last-scanned block per service so this scales as the registry grows.

### Validator Profitability Modeling

- [ ] **Optimal fee modeling and game theory analysis**
  - The data side is **done**: `ValidatorAnalytics.tsx` (admin route `/admin/validator-analytics`) tracks revenue, gas cost, profit, action breakdown, time-series — pulls from `ValidatorTx` rows written by `ValidatorService`.
  - **What's still needed**:
    - Document expected revenue vs costs across realistic activity levels (low / medium / high posting volume).
    - Recommend default fee/tip presets that keep validators net-profitable across typical usage.
    - Game-theory write-up: when does it pay to undercut? At what point does the network's tip-priority queue fail to clear?

### Daily CAW Distribution Display

- [ ] **"X CAW distributed to stakers today" widget**
  - Query `ActionsProcessed` events from last 24h, multiply by per-action issuance:
    - CAW post: 5,000
    - Like: 400
    - Recaw: 2,000
    - Follow: 6,000
  - Display:
    - "X CAW distributed to stakers today"
    - "Your earnings today: Y CAW" (user share of pool)
    - Historical chart of daily distributions
    - "Based on recent activity, stakers earning ~Z CAW/day"
  - **Note**: activity-based yield, not time-based APR — more like equity dividends. The HelpPage already explains the model in plain English; just need the live calculation surfaced.

### Price History Tracking

- [ ] **`PriceHistory` table for charts**
  - Currently `ChainSyncService` overwrites the latest price in `chainData`.
  - New table: `{ id, token (caw|eth), usdPrice, ethPrice, timestamp }`.
  - Insert a new row every sync interval (5 min) instead of just overwriting.
  - `GET /api/prices/history?token=caw&period=24h` for charting.
  - Frontend: price chart on staking page or sidebar.
  - Retention: 5-min granularity for 7 days, hourly for 90 days, daily forever.

### API & Worker Efficiency

- [ ] **Audit redundant RPC and DB calls across services**
  - Profile: ActionProcessor, RawEventsGatherer, ValidatorService, ChainSyncService, DataCleaner.
  - Look for:
    - Redundant chain reads, duplicate DB queries, over-polling
    - Missed batching (multicall, batch `getLogs`)
    - Cache opportunities (Redis) for stable chain data: token metadata, client configs, gas prices
    - Overlapping work between services reading the same contract state
    - N+1 queries, missing indexes, over-fetching in Prisma includes
    - Reorg-induced reprocessing — debounce/throttle?
  - **Note**: `findOrCreateUser` in-memory cache landed 2026-04-24 (`UserService.ts:198`). Same "burst of N parallel lookups for the same key" pattern likely exists elsewhere and is worth hunting.

### Infrastructure

- [ ] **Document all deployed contract addresses**
  - Many addresses marked TBD in docs.
  - Update after each deployment so client config and indexers stay in sync.

- [ ] **Multi-chain storage support** — see `docs/MULTI_CHAIN_STORAGE.md` for the full plan.
  - Contracts already accept any `storageChainEid` per client (`CawClientManager.createClient`); the off-chain runtime hardcodes Base.
  - Work splits into: deploy `CawActions` + `CawProfileL2` to a new chain, restructure `addresses.ts` as `addresses.<chain>.<symbol>`, parameterize chain-specific addresses in service configs, have the CLI read `storageChainEid` from `CawClientManager.getClient(clientId)` at install time and configure RPC + addresses per-client.
  - Don't touch this until there's a real driver (a client wanting to deploy to a non-Base storage chain). Indirection costs zero today; the abstraction is purely future-tense.
  - Same restructure unblocks the parallel "replication chain → archive contract address" map in `ValidatorService` (today there's one hardcoded `CAW_ACTIONS_ARCHIVE_ADDRESS`).

- [ ] **Scope Elasticsearch indexes per install** — multi-install on shared ES cluster currently collides.
  - Today `ElasticsearchService.ts` creates flat indexes: `caws`, `users`, `notifications`. Two CAW installs pointing at the same ES cluster (the common case for testnet + mainnet on one VPS) write to the same indexes — search results mix content from both.
  - The CLI already writes `ES_INDEX_PREFIX` to `client/.env` (derived from the domain). Just nothing reads it yet.
  - **Sketch:** add a `prefixedIndex(name: string)` helper inside `ElasticsearchService` that returns `${process.env.ES_INDEX_PREFIX || ''}${name}` (with a separator if prefix is set). Replace every literal `'caws'` / `'users'` / `'notifications'` with the helper. Same for the search-time queries elsewhere (`search.ts`, `notifications.ts`, etc).
  - Backwards-compatible: empty prefix → flat names like today. Existing installs see no change until they set the env var.
  - Estimate: ~1 hour. Mostly mechanical, but search the whole `client/src` for any place that hits ES by name to make sure nothing's missed.

- [ ] **RPC fallback support (primary + secondary)** — graceful degradation when the paid RPC is throttled or down.
  - Today every backend service reads one URL from env (`L2_RPC_URL_HTTP`, `L1_RPC_URL`, etc.) with no failover. If the primary chokes, the indexer stalls and the validator stops submitting until someone restarts.
  - The CLI already detects-and-warns when the operator types a known public RPC, but we don't currently let them set a fallback to use as a safety net.
  - **Sketch of the work:**
    - Service side: switch `makeJsonRpcProvider` to return a `FallbackProvider` (ethers v6 has this built in — quorum 1, two children, with the public one as the "fallback only" tier). Same change for the viem transport on the frontend (`fallback([http(primary), http(public)])`).
    - Env side: add `L2_RPC_URL_HTTP_FALLBACK`, `L1_RPC_URL_HTTP_FALLBACK`, etc. Generate them in `cli/src/steps/generate.js` when the operator provides them.
    - CLI prompt: after the primary HTTP URL, ask for an optional fallback. Default to a known-good public RPC for the chosen network/chain, with a warning that the fallback is only used when the primary fails. Skip the prompt entirely if the primary itself is already public.
    - **Don't** wire fallback for the validator's signing path — a tx going to two RPCs increases the chance of a nonce conflict and double-broadcast. Fallback is for reads + event subscription only.
  - File `client/src/utils/rpcProvider.ts` is where most of the service-side logic lives today. It already throttles + circuit-breaks; adding a `FallbackProvider` wrapper there propagates to every caller.
  - Estimate: half-day for the service refactor + ~30 min in the CLI. Worth doing once you have a few real installs and someone has actually tripped over throttling.

---

## Client Deployment CLI (`cli/`)

One-liner install: `curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash`

### Phase 1 — Interactive installer & process management — MOSTLY DONE

**Already implemented:**

- Node type selection step (`cli/src/steps/nodeType.js`)
- RPC URL collection (`rpcUrls.js`)
- Validator config (`validator.js`)
- Infrastructure config (`infrastructure.js`)
- Config generation (`generate.js`)
- Dependency install (`install.js`)
- Nginx setup (`nginx.js`)
- Process management commands wired up: `caw status`, `caw logs`, `caw restart`, `caw stop`

**Still missing in Phase 1:**

- [ ] Docker support — `docker-compose.yml` generation for PostgreSQL + Redis + app (optional)
- [ ] pm2 startup-on-boot integration (`pm2 startup`)
- [ ] Pros/cons guidance at each prompt — explain economics, replication tradeoffs, tip-amount tradeoffs

### Phase 2 — On-chain operations — NOT STARTED

- [ ] **Mint username** — walk through if user doesn't have a CawName (needs ETH + CAW on L1).
- [ ] **Register client** — submit `registerClient` transaction using validator PEM.
- [ ] **Check balances** — verify validator wallet has enough ETH for gas.
- [ ] **Buy CAW** — Uniswap integration for ETH→CAW swap if needed for staking/minting.
- [ ] **Authenticate** — submit L1→L2 authentication via LayerZero.
- [ ] **Register session key** — create and register a session key for the validator.

### Phase 3 — Management & operations — PARTIALLY DONE

**Already implemented:** `caw status`, `caw logs`, `caw restart`, `caw stop`.

**Still missing:**

- [ ] **`caw update`** — pull latest from GitHub, rebuild, restart
- [ ] **`caw config`** — edit configuration interactively
- [ ] **`caw domain`** — change domain, regenerate SSL
- [ ] **`caw api-priority`** — manage API endpoint discovery priority
- [ ] **`caw api-blacklist`** — block specific API endpoints
- [ ] **`caw uninstall`** — clean removal
- [ ] **`caw analytics`** — validator profitability, action throughput, gas costs (CLI surface for the data already in `ValidatorAnalytics.tsx`)

---

## Documentation

- [ ] **API documentation** — document all REST endpoints. Currently no `API.md`.
- [ ] **Deployment guide** — step-by-step deployment instructions. Currently no `DEPLOYMENT.md`.
- [x] **Client replication guide** — `solidity/docs/CLIENT_REPLICATION_GUIDE.md`
- [x] **Services documentation** — `client/src/services/SERVICES.md`
- [x] **Architecture docs** — `docs/ARCHITECTURE.md`, `docs/DATA_FLOW.md`, `docs/REPLICATION_AND_SLASHING.md`, `docs/VALIDATOR_MESH_NETWORK.md`, `docs/SESSION_KEYS.md`, `docs/MARKETPLACE.md`, `docs/DIRECT_MESSAGING.md`, etc. — extensive

---

## Resolved (since previous backlog snapshots)

- [x] **`OnlyOnce` lockdown of all protocol-critical setters** (2026-04-24)
- [x] **Old LZ replication path removed** (`CawActionsReplicator.sol` deleted, runtime callers gone, address removed from `client/src/abi/addresses.ts`; one stale test reference remains — see "Stale test cleanup")
- [x] **`gasLimitFor()` measured values** in `CawProfile.sol` and `CawProfileL2.sol` (from `solidity/scripts/measure-gas.js`); `CawActionsReplicator.RECEIVE_GAS_LIMIT` is moot — contract removed
- [x] **Permissionless `depositFor`** on `CawProfile.sol`
- [x] **Combined mint + stake transaction** — `mintAndDeposit` on `CawProfile.sol:157` and `CawProfileMinter.sol:45`, with quoter at `CawProfileQuoter.sol:75`
- [x] **Buy-offer system (OTC)** — `createOfferETH` / `createOfferERC20` / `acceptOffer` / `cancelOffer` on `CawProfileMarketplace.sol`; FE `MakeOfferModal` and `ViewOffersModal` wired up
- [x] **Withdraw fee floor locked at first authentication** (per `(clientId, tokenId)`) — clients can't retroactively raise fees on existing users; old "fee blocking attack" is no longer reachable
- [x] **LayerZero refund address resolved** — `CawProfile.lzSend()` refunds to `tx.origin` with comment explaining why (works through marketplace intermediaries)
- [x] **`reclaimBid` for transferred NFTs** — contract done; frontend UX still in the open list above
- [x] **XMTP integration removed entirely** — no DM service, no auth TODOs
- [x] **Short URLs after DB rebuild** — resolved by toggle in UI to choose current domain or not
- [x] **`useTokenDataUpdate` ETH-read TODO** — code cleaned up
- [x] **Delete posts** — implemented via on-chain `hide:caw:{cawonce}` action (`FeedItem.tsx:1660-1676`); the `hide` action handler in `actionHandlers.ts` flips the caw to `HIDDEN` status
- [x] **DM editing and deletion** — full backend (`Message.editHistory`, `MessageDeletion` model, edit/hide/delete endpoints in `dm.ts`) and frontend (`useDm.ts` decrypts edit history, etc.)
- [x] **Validator profitability data** — `ValidatorAnalytics.tsx` admin page tracks revenue, gas cost, profit, breakdown, time-series. Optimal-fee *modeling* still open (see Backend Services).
- [x] **`findOrCreateUser` in-memory cache + pulled out of interactive tx** (2026-04-24) — fixes `P2028` "transaction already closed" cascades when a batch of N actions from the same sender arrives in parallel
- [x] **GasPriceLine wired to real ETH price** (2026-04-25, `db84bf7`) — was hardcoded to `1` with three TODO comments; now reads from `usePriceStore` (already populated by `useFetchPrices` from `/api/prices`)
- [x] **Marketplace ownership removed** (2026-04-25) — see Security & Pre-Launch above for details
- [x] **`setPeer` once-per-eid lock + delegatecall audit** (2026-04-25, `3c445c0`)
- [x] **English auction `cancelListing` works with active bids** (2026-04-25, `db84bf7`) — refunds highest bidder automatically; seller no longer needs the transfer-NFT-away workaround
- [x] **`mintSelector` kept as latent capacity** (2026-04-25) — comments now explain it's reserved for a future "mint + authenticate (no deposit)" flow rather than the misleading `// TODO: this one not used`
- [x] **Stale `multi-layer-test.js` references** cleaned up (2026-04-25, by user)
