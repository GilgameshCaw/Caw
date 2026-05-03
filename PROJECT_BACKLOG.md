# CAW Protocol — Project Backlog

Outstanding TODOs, security considerations, and planned features. Each entry has enough context for an agent (or human) to pick it up cold.

---

## DVN config strategy (mainnet — owner-less / permanently locked)

The protocol's mainnet posture is "fully ownerless": after deploy we call `setDelegate(0x0)` and `renounceOwnership()` so no admin can ever rotate DVNs, change LZ libraries, or reconfigure the messaging layer. That means the DVN config we pick at deploy is the one we live with forever.

**Decision: 0 required + 3-of-8 optional.**

Verification rule: a message is valid iff at least 3 of the 8 optional DVNs verify it. Any 5 DVNs can go offline / sunset / get compromised and the bridge still works. Fraud requires 3 DVNs to collude.

Why this shape:
- ANY required DVNs would be a permanent single point of failure — if even one required DVN is sunsetted and we have no admin, we're bricked. So `requiredDVNs: []` is the only owner-less-safe choice.
- 3-of-8 sits in the LZ team's recommended range for this pattern. Higher threshold (e.g. 4-of-8) is more secure against collusion but less resilient to multiple simultaneous outages. Lower (e.g. 2-of-8) flips the tradeoff.
- 8 is large enough to absorb sunsets and to mix client-diverse DVN implementations (LZ Labs, Google Cloud, Nethermind, Polyhedra, Animoca, etc.).

**Wait for client-diverse DVNs before locking** — per LZ team conversation 2026-04-29, new DVNs written on entirely different codebases than the existing ones are coming online in the next few months. Client diversity is what keeps a fixed config robust against a bug in any single DVN implementation. Target deploy timeline is 3-6 weeks, so it's worth checking back with LZ before mainnet to see which new DVNs are live and bake at least 1-2 of them into the optional pool.

LZ's general recommendation against permanently locking the config: any future DVN contract upgrades won't be adoptable. We accept that tradeoff in exchange for trustlessness — but the threshold and pool size give us headroom for individual DVNs to be deprecated by their operators without breaking the bridge.

**Implementation when ready** (`solidity/scripts/lz-dvn-config.js`):
- `DVNS_BY_CHAIN_MAINNET` — list 8 DVN addresses per chain (sorted ascending, deduped, no overlap with required since required is empty)
- `buildUlnSetConfigParams` — change `requiredDVNCount: 3 → 0`, `optionalDVNCount: 0 → 8`, `optionalDVNThreshold: 0 → 3`, `requiredDVNs: dvns → []`, `optionalDVNs: [] → dvns`
- After `configureLzDvns` runs in deploy.js, add a final step that calls `setDelegate(0x0)` then `renounceOwnership()` on `CawProfile`, each `CawProfileL2_*`, each `CawActionsArchive_*`, each `CawChallengeRelay_*` (`CawActions` has no privileged functions reachable so renouncing is cosmetic but fine).

Reference conversation with LZ team (Dane, 2026-04-29): confirmed 0 required + large optional pool with low threshold is the right shape for an owner-less protocol; recommended waiting for client-diverse DVNs.

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

- [ ] **Image handling — full pipeline overhaul** (steps 1, 2, 3-lite shipped — see commits `fdc6902`, `f608c7b`, `e597d9f`, `92d5713`, `4f01a22`, `e41b349`, `89e24a9`, `3648f57`. Remaining: GC + S3 backend + CDN.)
  - **(4) Lifecycle / GC — orphan cleanup**
    - When a post is deleted (`hide:caw:<cawonce>` action), the image file stays on disk forever. Same for profile picture changes — old avatars accumulate.
    - Track image references via a `MediaAsset` table (or just a column on Caw / User pointing at the asset hash). On post hide / avatar replace, mark the asset as unreferenced. A daily DataCleaner sweep deletes assets unreferenced for >7 days (the buffer covers the indexer-lag window for hide actions).
    - The DataCleaner service already exists (`client/src/services/DataCleaner/`) — slot a new sweep into it.
    - **Open question**: do we *delete* on hide, or keep the image and serve a "removed" placeholder? If a user can resurrect a hidden post via re-cawing the same content, deleting the asset would break that. Probably keep for the soft-window, then GC.
  - **(5) Storage backend — pluggable, with S3 as the obvious second option**
    - Hardcoded to local disk today. Operators with low-disk VPSes can't run for long.
    - Abstract the upload write path behind a `MediaStorage` interface — `local` (default, current behavior) and `s3` (writes to any S3-compatible bucket — DigitalOcean Spaces, Backblaze B2, AWS S3, MinIO). For a crypto-paid option, look at S3-compatible web3 gateways like **Filebase** (S3 in front of IPFS/Sia/Storj) or **4EVERLAND** (S3 in front of IPFS/Arweave); verify the crypto-billing flow is actually live in the signup UI before committing — these vendors quietly retire crypto rails periodically (Storj DCS itself was a candidate but no longer surfaces a crypto-payment option in the self-serve add-funds flow as of 2026-05).
    - `caw install` prompts for storage backend choice. Local stays the path of least resistance; S3 is opt-in for operators who want it.
    - URL generation logic stays the same (still public URLs); only the *write* side changes.
    - Prerequisite for horizontal scaling — see "Horizontal scaling — multi-server / loadbalancer readiness" under Infrastructure. Local-disk uploads can't be shared across nodes; an external bucket is the only sane shared media store once there's more than one app server.
  - **(3) full — CDN integration**: optional Cloudflare/Bunny/S3 proxy. CLI prompt at install time — "host images locally / push to S3-compatible bucket / front with Cloudflare." Operator picks. Local default stays. Ties into (5).

- [ ] **Move blockchain RPC out of API request handlers (architectural)**
  - **Problem**: API request handlers call `findOrCreateUser`, `verifyOwnershipOnChain`, `readOnChainStake`, `syncTokensOwnedByWallet` — each of which falls back to L1/L2 RPC reads when the DB doesn't have what it needs. This couples API latency to Infura uptime. Today's incident: a fresh-mint user's `/api/users/ensure` call blocked for ~30s on an Infura WebSocket handshake then 500'd. Past incidents: validator wedge mode, tx_already_closed Prisma timeouts caused by RPC inside a 5s tx, ActionProcessor hung on receiver-tokenId resolution.
  - **Architectural target**: API reads only from DB. Background services (RawEventsGatherer, NftTransferWatcher, DataCleaner, UserService) are the only code that holds blockchain providers. When the API needs chain-derived data the indexer hasn't yet observed, it returns HTTP 202 ("still indexing — try again") and the frontend retries with backoff. Operators get a knob: how stale is "fresh enough" per endpoint.
  - **Scope inventory** (every API call site that touches RPC):
    - **Flavor 1 — token ownership / username** (the `findOrCreateUser` path):
      - `POST /api/users/ensure` — fresh mint onboarding (highest user-visible pain)
      - `GET /api/users/by-token/:tokenId` — falls back to RPC on DB miss
      - `POST /api/auth/verify` — calls `findOrCreateUser` for sender resolution
      - `POST /api/auth/verify-dm` — same
      - `POST /api/sessions` — same on signing
      - `POST /api/actions` and `/api/actions/batch` — pre-resolves sender (already mostly fine after the 5s-tx fix; `findOrCreateUser` is now outside the tx but still in-request)
    - **Flavor 2 — stake / balance reads**:
      - `GET /api/users/by-token/:tokenId` calls `readOnChainStake()` to verify pending L1→L2 deposit landed; throttled per-token to once every 15s but still ~per-request on hot tokens (profile chooser polls)
    - **Flavor 3 — live ownership verify (post-transfer)**:
      - `POST /api/auth/verify` and `/api/auth/verify-dm` use `verifyOwnershipOnChain` and `syncTokensOwnedByWallet` to handle "user transferred their token, DB is stale" — rare-path, but blocking
    - **Provider construction duplication**: `client/src/api/routes/users.ts:14`, `actions.ts:60-69`, `sessions.ts:55-64` each build their own L2 read provider, duplicating the singleton in UserService. Easy consolidation candidate even outside the bigger refactor.

  - **Three implementation tiers** (each independently shippable):

    **Tier 1 — minimum viable (~1 day)**:
    - Strip `findOrCreateUser`'s RPC fallback out of every API endpoint listed under Flavor 1. If the user isn't in the DB, return 202 with `{ retryAfterSeconds: N }` instead of blocking on RPC.
    - Frontend `useUserByToken` hook (and equivalents) handles 202 with exponential backoff; existing "user not found" UX already exists for the briefest window after mint.
    - Move the actual L1/L2 read into a one-shot helper called by `RawEventsGatherer` when it sees a Mint event — populates the DB immediately on the indexer's schedule.
    - For pre-existing tokens already on-chain but never indexed (theoretical, shouldn't happen with current indexer): a periodic `DataCleaner` sweep that scans recent L1 Transfer events and backfills any missing User rows.
    - Eliminates the worst class of bug (the 30s blocking handshake that bit `/ensure` today). ~150 lines + frontend retry hook.

    **Tier 2 — clean stake reads (~1 more day)**:
    - Add `User.onChainStakeWei String?` (wei as string) and `User.onChainStakeUpdatedAt DateTime?`.
    - Background poller (in `DataCleaner` or new tiny service) updates these periodically — every 30s for users with pending deposits, every 5min otherwise.
    - `GET /api/users/by-token` reads only from DB, surfaces `onChainStakeUpdatedAt` so the FE can show staleness.
    - Eliminates `readOnChainStake` from the request path entirely.

    **Tier 3 — full cleanup (~1 more day)**:
    - Move `verifyOwnershipOnChain` and `syncTokensOwnedByWallet` to async-first patterns. Auth flow returns 202 when it can't verify from DB; FE retries.
    - Consolidate the three duplicate L2-read singletons in `users.ts`, `actions.ts`, `sessions.ts` into one shared helper from `UserService`.
    - Document a "freshness contract" per endpoint: max staleness in seconds.
    - Removes RPC providers from the API server's import graph entirely (defense in depth — even import-time side effects can't block on Infura).

  - **Don't break**: action submission. The current `/api/actions` flow already pre-resolves the sender outside the tx, so removing the inside-handler RPC is a no-op for the happy path. Just make sure 202-on-miss happens BEFORE writes (don't insert TxQueue rows for senderIds we haven't validated).

  - **Watch out for**: the recent cawonce-allocation endpoint depends on `senderId` being a known user. If we 202 before allocation, the frontend's signAndSubmit loop needs to handle that path — i.e., wait for the user to be indexed, THEN call allocate-cawonce. Order matters.

- [ ] **Put SigNoz behind admin auth (subdomain + nginx auth_request)**
  - Today SigNoz is reachable only via SSH tunnel (`ssh -L 8080:127.0.0.1:8080`). Workable for solo operators but friction-heavy and confusing. Goal: gate it behind the same admin cookie used everywhere else (`requireAdmin` middleware) so admins can just visit a URL.
  - **Why subdomain not subpath**: SigNoz's frontend bundles asset URLs hardcoded to `/assets/...` with no `BASE_PATH` support. Mounting at `/admin/signoz/` would require nginx `sub_filter` URL rewriting on every response, which breaks the moment SigNoz changes their bundle hashes. Verified on v0.120.0 — no env var or config flag for base path. Subdomain (`signoz.<domain>`) sidesteps the whole problem.
  - **Cert**: `*.caw.social` wildcard already on the box covers `signoz.caw.social`. For installs on a non-wildcard cert, the CLI step should warn + offer to skip the SigNoz exposure.
  - **Cookie domain**: today the admin cookie has no `Domain` attribute (exact-host only), so `test.caw.social`'s cookie won't be sent to `signoz.caw.social`. Two changes:
    - `cli/src/api/middleware/auth.ts` — `adminCookieOptions()` adds `domain: '.caw.social'` (or derived from `SHORTURL_DOMAIN`/registrable suffix). Trade-off: any subdomain on the same registrable domain will receive the cookie; HttpOnly means JS can't read it, but a malicious subdomain backend could capture it. Acceptable in operator-controlled deployments.
  - **API**: new `GET /api/admin/check` endpoint that runs `requireAdmin` and returns 200/401. nginx's `auth_request` calls it; on 401 it returns 401 to the browser (not redirect — SigNoz makes XHR/WebSocket requests, redirects break them). Frontend admin login flow already exists — operator logs in there first, then visits `signoz.<domain>`.
  - **nginx**: new server block on `signoz.<domain>` with:
    - `auth_request /__auth_check;` at the top
    - `location = /__auth_check { internal; proxy_pass http://127.0.0.1:4000/api/admin/check; }` (passes the cookie through)
    - `location / { proxy_pass http://127.0.0.1:8080; }` (the SigNoz UI)
    - WebSocket upgrade headers (SigNoz uses WS for live trace tail) — same pattern as the existing `/socket.io/` block
  - **CLI**: extend `cli/src/steps/nginx.js`'s template with a "expose SigNoz at signoz.<domain> behind admin auth?" question — only offered when SigNoz endpoint is `http://localhost:4318` (i.e., SigNoz is on this box) AND the cert covers wildcard / explicit subdomain.
  - **SigNoz's own login**: still gates first-visit with its own admin-account-creation flow. Operator creates one shared account; subsequent visits hit our nginx gate first, then SigNoz's session cookie keeps them logged in inside SigNoz. Two-factor by accident, accepted.
  - **Docs**: README section on admin dashboards (Bug Reports, DB browser, Reports) should mention SigNoz once shipped.
  - Estimated effort: ~30 min API + ~15 min cookie domain + ~20 min nginx template + ~10 min CLI prompt + testing. Half-day at most.

- [ ] **Move L2 tx submission out of `/api/sessions` request handler**
  - `POST /api/sessions` is the last API request handler that holds an L2 wallet+contract and submits an on-chain tx (`registerSessionPersonal`). Tier 3 of the RPC-out-of-API refactor honored the principle for *blocking* RPC reads but didn't touch this endpoint because it's already async (returns 202 with a `requestId`, processes in a fire-and-forget background promise, client polls for status).
  - **Why it's still worth fixing**: the L1/L2 provider plumbing still lives inside `client/src/api/routes/sessions.ts`. Defense-in-depth — even import-time side effects can't reach Infura when the API/`api/` folder doesn't import from `utils/rpcProvider`. Also: putting the registration in a real worker service makes it testable and observable (existing pm2 lifecycle, logs, restart on stuck-job). Today the fire-and-forget Promise has none of that.
  - **Shape**: extract the contract-submission code into a tiny new `SessionRegistrationService` (or fold into `ValidatorService`, which already has a wallet+nonce-manager and submits L2 txs). The API endpoint inserts a row into a new `SessionRegistrationRequest` table; the service polls for `pending` rows and processes them. Status endpoint reads from the same table.
  - **Effort**: ~half-day. Requires schema work (queue table) and worker glue, plus migrating the in-memory `requests` Map to DB-backed state. Worth doing once the rest of the RPC-out-of-API work has settled in production.

- [ ] **Delete dead helpers `verifyOwnershipOnChain` + `syncTokensOwnedByWallet`**
  - Tier 3 of the RPC-out-of-API refactor stopped calling these from API request handlers but left the helpers in place per spec — to avoid breaking other in-flight branches. Once master settles (no fresh PRs reference them), grep-and-delete:
    - `client/src/services/UserService.ts` — both functions
    - Their imports from any callers (none should remain in `client/src/api/routes/`)
  - Keep `findOrCreateUser` — it's still legitimately called from background services (`NftTransferWatcher`, `RawEventsGatherer`, `ActionProcessor`).
  - Five-minute follow-up. Just needs a `git grep` confirm no remaining callers before the delete.

- [ ] **NftTransferWatcher: don't advance lastBlock on partial event-handler failures**
  - Pre-existing bug, surfaced by the indexer-gap fix in commit `1ec33b3`. The watcher's inner per-event try/catch logs failures and continues, then the outer poll loop unconditionally advances `lastBlock` past the processed range. So if a single Mint event throws (e.g. L1 RPC down for `findOrCreateUser`'s metadata read), that event is permanently skipped — a User row never gets created for that tokenId.
  - **Symptom**: a fresh-mint user whose Mint happened during an L1 outage stays stuck in 202-loop forever, even after L1 recovers. The `/api/users/by-token` retry helper times out and the user sees "we couldn't index your account" with no recovery path.
  - **Fix**: track which events in the batch succeeded; if any failed, don't advance `lastBlock` past the failed one. Re-poll from there next pass. Or: maintain a per-token "stuck" set and have a slow background sweeper retry them.
  - The bug existed before the refactor but the new architecture makes it user-visible because the API no longer compensates with its own RPC fallback. Higher priority than it would have been a week ago.

- [ ] **"Switch wallet" button in ProfileChooser**
  - Operators with multiple wallet extensions installed (Rabby + MetaMask + Coinbase, etc) hit a confusing dead-end: once wagmi has connected to one, there's no obvious in-app path to switch to another. Today's escape hatch is editing localStorage by hand or disconnecting from the wallet's own UI. Both are bad UX and easy to misdiagnose as "Wrong Address" bug reports.
  - **Where**: ProfileChooser dropdown — add a "Switch wallet" item that calls wagmi's `disconnect()` and then `openConnectModal()` from RainbowKit. One click, picker appears, operator picks the wallet they actually meant.
  - **Watch out for**: clearing the right state. wagmi's `disconnect()` should handle the recentConnectorId, but a belt-and-suspenders `localStorage.removeItem('wagmi.recentConnectorId')` before calling `openConnectModal` is cheap insurance.
  - Tiny — ~15 lines.

- [ ] **Rainbow Wallet connect failure**
  - Reported on test.caw.social (HTTPS production install): Rainbow Wallet failed to connect via the RainbowKit connect modal. Other wallets work; this one specifically fails.
  - **Likely culprits to investigate first**:
    - WalletConnect / Reown project ID — Rainbow uses WC under the hood. If `VITE_PROJECT_ID` is missing or its origin allowlist on the WC dashboard doesn't include `https://test.caw.social`, Rainbow's WC handshake fails (other wallets that use injected providers — MetaMask, Coinbase desktop — would still work, masking the WC misconfig).
    - `caw install` writes `VITE_PROJECT_ID` from the operator's input but does no live validation against the WC dashboard. Easy to typo.
    - Browser console will have a clear "WalletConnect" error if this is the cause.
  - **What to capture next session**: exact failure mode (modal didn't open / opened but errored / scanned QR but never connected / etc.) and the browser console output during the attempt.
  - Reproduce on `test.caw.social` with Rainbow mobile + desktop QR flow to narrow it down.

- [ ] **Canonical URLs (SEO + dedup across instances)**
  - The same post / user / hashtag is reachable from every client domain (test.caw.social, caw.social, third-party clients) — search engines see N copies and split ranking, social embeds attribute to whichever URL was first scraped, and the protocol's "any client can render any content" property turns into an SEO liability.
  - Add `<link rel="canonical" href="...">` to every shareable page so all clients point at one canonical origin.
  - **Open question**: what *is* the canonical origin? Two reasonable answers:
    1. **Author's home client** — `cawProfile.tokenURI` already encodes the user's instance. Resolves to "the URL the author would link." Downside: requires an on-chain read at render time, and a transferred profile changes the canonical mid-flight.
    2. **A protocol-level canonical** (e.g. `caw.social`) — operationally simple, every page points to caw.social, but means caw.social earns all the search equity and other clients are second-class.
  - **Implementation sketch**: SSR `<link rel="canonical">` in the prerender path (`spaPrerender.ts`) using whichever rule we settle on. Mirror in OG tags (`og:url`) so social embeds also point canonical. The SPA shell can render a placeholder canonical that the prerender catch-all overwrites for crawlers.
  - **Where**: `/users/:username`, `/caws/:id`, `/hashtags/:tag`, profile pages, the home feed (canonical = root of canonical origin).
  - Decide before we have meaningful crawl traffic — once Google indexes the wrong URLs, undoing it is slow.

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

- [ ] **Thread break marker — author-controlled post boundary**
  - In long Twitter-style threads, readers can't tell where the author intended one "post" to end and the next to begin. The current UI hoists replies under their parent within an 8-post lookahead window, but that's a presentation heuristic — it doesn't capture *intent*.
  - Add a "break thread" marker the author can drop on any of their own posts. Posts before the break render as a continuous thread; posts after the break visually separate (divider line, "↓ next thread" affordance, or just a larger gap).
  - **Implementation sketch**:
    - On-chain: piggyback on the same `text` channel deletes use — e.g. `break:caw:<cawonce>` action, signed by the post author. Indexer stores it on the Caw row as `threadBreakAfter: bool`.
    - FE: small icon in the post action row (only visible to the author of the post, alongside the existing "Delete post" affordance). Clicking it submits the action; visual marker appears immediately optimistically (mirror the `hiddenCawsStore` pattern from the delete-post flow).
    - Render: `Feed.tsx` reply-grouping pass checks `threadBreakAfter` — once set, replies after that point don't get hoisted under the original parent.
  - **Why deferred**: not blocking anything; nice-to-have once we have heavy thread users.

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

- [ ] **Audit redundant RPC and DB calls across services** (poller-throttling pass shipped `6cc9eca` — cut Infura credit burn ~70%; remaining: caches, batching, N+1 queries, reorg dedup)
  - Profile: ActionProcessor, RawEventsGatherer, ValidatorService, ChainSyncService, DataCleaner.
  - Look for:
    - Duplicate DB queries
    - Missed batching (multicall, batch `getLogs`)
    - Cache opportunities (Redis) for stable chain data: token metadata, client configs, gas prices
    - Overlapping work between services reading the same contract state
    - N+1 queries, missing indexes, over-fetching in Prisma includes
    - Reorg-induced reprocessing — debounce/throttle?
  - **Note**: `findOrCreateUser` in-memory cache landed 2026-04-24 (`UserService.ts:198`). Same "burst of N parallel lookups for the same key" pattern likely exists elsewhere and is worth hunting.

### Infrastructure

- [ ] **CLI: fix `sudo -u caw -E` HOME bug.** `caw update` runs `sudo -u caw -E yarn install` which preserves `HOME=/root`, breaking yarn's RC lookup with EACCES on `/root/.config/yarn`. Switch `-E` to `-H` (sets HOME to target user's home dir) on every privileged drop in `cli/src/steps/update.js` and any other step that runs commands as the install user.

- [ ] **CORS audit: wildcard public-read endpoints, allowlist auth-gated ones.** `/api/shorturl/<code>` is now wildcarded (commit 138776a) but other public-read endpoints aren't. Audit every `/api/*` route and bucket as: (a) public-read (no auth, scrapable data — wildcard CORS), (b) auth-gated (requireAuth, cookies, or any state mutation — origin-allowlist from discovered-instances), or (c) admin-only (no CORS). Likely public-read candidates: `/api/users/by-token`, `/api/users/<username>`, `/api/feed`, `/api/caws/<id>`, `/api/hashtags/*`, `/api/search/*`. Auth-gated: `/api/dm/*`, `/api/auth/*`, `/api/upload/*`, `/api/users/me`, `/api/notifications/*`, `/api/bookmarks`. Never set `Access-Control-Allow-Credentials: true` with a `*` origin. Cross-node mirroring won't fully work (e.g. a feed rendering content from another node) until the public-read set has CORS.

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

- [ ] **Horizontal scaling — multi-server / loadbalancer readiness**
  - Today a CAW node runs as a single VPS with API + indexer + validator + Redis + Postgres on one host (managed by `pm2` per `ecosystem.config.cjs`). Fine for current load; one viral moment puts us over a single box. We should land the changes that *unblock* multi-server now, while the surface area is small, even if we don't actually scale out yet.
  - **Goal:** the API tier becomes stateless and replicable behind a loadbalancer (nginx upstream block, or a managed LB). Singleton services (RawEventsGatherer, NftTransferWatcher, ValidatorService, ChainSyncService, MarketplaceIndexerService, DataCleaner, ScheduledPostProcessor, DmRelayService) keep running on exactly one host — they're not safe to run more than once. Postgres + Redis stay on their own host(s) and every API replica points at them.
  - **What's already fine:** Postgres is already an external dep; Redis is too (rate limits + sessions go through it); auth is cookie-based with the session in Redis (see `project_wallet_auth.md`); image variants are served by nginx via the `/uploads/` alias, not Node, so a loadbalancer can route `/uploads/*` to any host that has the file (or to a bucket — see below). Most of the API's `new Map(...)` usage is per-request scratch, not cross-request cache.
  - **Concrete blockers to enumerate and fix:**
    - **Local disk uploads.** `/api/upload/*` writes to the local filesystem; a request that lands on node A can't be read from node B. **Hard prerequisite: ship the pluggable `MediaStorage` interface and an S3-compatible backend (see "Image handling — full pipeline overhaul, step 5" under UX).** Either every API node writes to the same bucket, or the upload route is pinned to one host via the LB. Bucket is cleaner.
    - **In-process caches.** Audit every `setInterval` + module-level `Map` / `Set` in `client/src/api/` and `client/src/services/` for state that needs to be coherent across replicas. The known callsites: `client/src/api/routes/actions.ts:75` (cawonce-something janitor), `client/src/api/routes/prices.ts` (in-memory price cache), and the count-aggregation maps in `cawUtils.ts`. Any of these that affect *correctness* (not just latency) move to Redis. Latency-only caches can stay per-process.
    - **Singleton services.** Document which services in `client/src/services/` MUST be singletons and refuse to boot a second copy. Cheap implementation: a Redis lock with a TTL heartbeat (existing pattern in `ValidatorService`). Each singleton on boot tries `SET singleton:<name> <hostname> NX EX 30`; if it loses, it logs and exits. The pm2 ecosystem config on each host lists the same services; whichever host wins the lock runs them.
    - **WebSocket / SSE endpoints.** If any realtime endpoint uses in-process pub/sub (cawonce broadcasts, DM relay, notifications stream), it needs to flip to Redis pub/sub so a publish on node A reaches subscribers on node B. Check `DmRelayService`, `NotificationService.ts`, and any `res.write`/EventSource handlers.
    - **Rate limits.** `express-rate-limit` defaults to in-memory; per-IP limits drift across replicas. Switch the limiter store to a Redis-backed one (`rate-limit-redis`). The session-creation limiter already uses Redis directly, so the pattern exists.
    - **Cookies / sessions.** Session cookie + Redis-backed session is already cross-replica safe. Sanity check: no code path stashes per-session state in process memory.
    - **Loadbalancer + `trust proxy`.** When nginx (or a managed LB) is the front-door, every Express app needs `app.set('trust proxy', ...)` set to the LB's hop count so `req.ip` is the real client and rate-limit buckets work. Already on the radar from the Cloudflare item under DDoS protection — same fix, broader scope.
    - **Static assets / build artifacts.** `client/src/services/FrontEnd/dist` is built per host today; either build once and rsync, or have the LB route static asset requests to a single "asset host" / CDN. CDN is the right answer long-term and ties into the image pipeline CDN step.
  - **Out of scope for this item** (call out so they don't sneak in): Postgres read replicas, Redis cluster, multi-region. This is "two app servers in one region behind a loadbalancer" — the cheap step that buys headroom. Anything past that is its own backlog item.
  - **Sequencing:** the bucket-storage work (UX → image handling → step 5) is the first prerequisite. After that, the audit-and-Redis-ify pass is ~1-2 days. The singleton-lock work is another half-day. Validating the whole thing means standing up a second app host in staging behind nginx with `least_conn` upstream and exercising the full app — also ~half-day of operator-side work.
  - **Why now:** the changes are individually cheap; the cost balloons if we let in-memory state metastasize across more services. Doing the audit while the surface is still small is the leverage.

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

**Already implemented:** `caw status`, `caw logs`, `caw restart`, `caw stop`, `caw update` (with `--rebuild` flag, `01bd28d`).

**Still missing:**

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
- [x] **Filebase media storage backend + per-install bucket prefix** (2026-05-03) — `MediaStorage` interface (`client/src/api/util/mediaStorage.ts`) with `local` + `filebase` backends selected by `MEDIA_STORAGE_BACKEND`. Multi-install collisions avoided by prefixing every key with the install's hostname (`test.caw.social/images/<id>.webp`, `caw.social/images/<id>.webp`); the prefix is hidden behind the per-install `s.<host>` reverse-proxy so it doesn't leak into public URLs. CLI step `cli/src/steps/mediaNginx.js` writes the `s.<host>` vhost (with TLS cert detection mirroring `nginx.js`, idempotent, marker-comment-guarded) and runs from both `caw install` and `caw update`. Migration tool `client/src/tools/migrateMediaToFilebase.ts` (idempotent uploader + DB substring rewrite, `--dry-run`/`--commit`).
- [x] **`mintSelector` kept as latent capacity** (2026-04-25) — comments now explain it's reserved for a future "mint + authenticate (no deposit)" flow rather than the misleading `// TODO: this one not used`
- [x] **Stale `multi-layer-test.js` references** cleaned up (2026-04-25, by user)
- [x] **Image pipeline — upload-side processing, variants, nginx direct-serve** (2026-04 — commits `fdc6902` shared uploadMedia helper + client-side compression, `f608c7b` server `/api/upload/variant` endpoint, `e597d9f` variant presets + URL derivation + Avatar two-stage fallback, `92d5713` thumb/large variants at avatar callsites, `4f01a22` WASM avatar thumb backfill, `e41b349` nginx alias `/uploads/` with 1y immutable cache, `89e24a9` variants always `.webp`, `3648f57` click-to-expand lightbox)
- [x] **DM reactions — full backend + UI** (2026-04 — commits `b14aea4` MessageReaction + customizable defaults backend, `c1aa04b` hand-rolled migration, `5851a3a` smiley-trigger UI + bigger picker, `5e3f2a1` portal-rendered strip clamped to viewport)
- [x] **DM video rendering** (2026-04, `df46f1a`) — videos render inline instead of as a paperclip
- [x] **RPC poller throttling** (2026-04, `6cc9eca`) — cut Infura credit burn ~70% across pollers. Broader RPC audit still open under "API & Worker Efficiency".
- [x] **RPC secrets via Authorization header** (2026-04, `fc1f69b`)
- [x] **Cross-node short URL resolution** (2026-04 — commits `87a951a` resolve against origin host, `138776a` wildcard CORS, `89e24a9` nginx `/s/` proxy in CLI template)
- [x] **`caw update --rebuild` flag + dual yarn-lockfile detection** (2026-04, `01bd28d`)
- [x] **Image modal / lightbox** (2026-04, `3648f57`) — was `// TODO: Open image in modal` at three callsites in `FeedItem.tsx`
- [x] **DM emoji button** (2026-04, `5851a3a`) — smiley-trigger reactions + bigger picker



## UX

- **Crowdfunding CAWs.** Same authoring model as inline polls (`::poll:opt1:opt2:::` marker → render UI from post text), but each tip on the post advances a progress bar toward a goal. Author specifies a target amount (and optionally a recipient/deadline) in the marker; the FeedItem renders a progress bar fed by the post's existing tip totals. Open questions: which token (CAW only, or multi-token?), whether goal/recipient lives in the marker or a sidecar field, how to handle overfunding, and whether to show contributor count or anonymized list.

- **Ensure supporting other languages.** Audit text rendering, input handling, and storage end-to-end for non-Latin scripts (CJK, Cyrillic, Arabic, accented Latin, etc.). Hashtag recognition is already Unicode-aware (`tools/hashtagRegex.ts`). Still to verify: post composer length counting (bytes vs codepoints vs grapheme clusters), search/Elasticsearch analyzers, RTL layout for Arabic/Hebrew, font fallback in feed items, mute-word matching across scripts, username display in places that still use system fonts.












-----
some notes:
- create and deposit 2 sigs sholud say "2 sigs" and don't make users click twice
- after creating account puts people on L1, but then quick sign 
- "failed to verify wallet and register DM identity"
- "API 403: SIgner does not own any CAW names"
- devault avatars should include some female forms
- roll up notifications better. 
- are notifications paginated ? I can't seem to scroll infinitely.
- "If a bid is placed in the last 10 minutes" should be "If a bid is placed in the last 10 minutes of the auction"
- emojis show up too small
- "start a conversation" showing in DMs before any messages exist
- clicking a conversation loads messages slowly (show loader)
- messages tab loads slowly
- click number next to reply on replies takes you to the caw page
- i get 500 error when i click on a single "message" in admin dashboard
- i should be able to like DMs that I received.
- need user avatars in the DM convo pages.
- caw pages are too chaoitic with lots of replies and tips. we need a way to hide/show other actions. 
- seems like we need more sizes of the favicon to render nicely on phones?
- we need a button to click on a profile that allows the current use to @mention them.
- Add polling option to posts
- Tippping < 200k shows as ($0.00).
-make previous video automatic  stop on when  browsing  another video play on post
