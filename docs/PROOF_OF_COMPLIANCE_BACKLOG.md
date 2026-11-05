# Proof-of-Compliance Backlog

Artifacts to publish alongside V2 mainnet deploy + renounce, so the
manifesto compliance claims are independently verifiable rather than
asserted. Maps to a public peer-review checklist circulating in 2026-06.

Status: pre-mainnet. Establish candidate behavior and independent testnet recovery before release; add final mainnet receipts afterward. Missing release evidence is not merely a documentation task.

---

## 0. Source review is not deployment certification

The earlier blanket assertion that all hard claims were already verified is not a release certificate. See the [consolidated manifesto/R2 review](community/MANIFESTO_R2_RELEASE_REVIEW.md) for exact baseline, open decisions and existing patches.

- PathwayExpander retains owner-mediated expansion on the reviewed master. Bounded additions are still special authority; #221 proposes closing it and #276 addresses endpoint-library defaults.
- NetworkManager has **per-network owner authority**, even though it is not a globally Ownable contract. `addAuthorizedSponsor`, `removeAuthorizedSponsor` and `setGasOverride` remain owner-only after fee and ownership locks. #334 documents the boundary; #342 proposes terminal finalization with unresolved sponsor/gas tradeoffs.
- CawProfile also permits the network owner to trigger fee swaps paying the recorded recipient. Recipient direct withdrawal remains separate. A full authority review must include this path and the agreed beneficiaries.
- NFT ownership does not alone settle sponsored-profile withdrawal conditions, asynchronous transfer semantics or historical DM key access. Those require explicit source review, decisions and tests.
- Economic caps, allocation interpretation and burn semantics require agreement where they differ from literal source wording. Calling a change an enhancement is not evidence of that agreement.
- Proxy/multisig absence, immutable wiring, library/delegate settings and key renunciation must be verified against the complete deployed graph. Source patterns and bounded local tests cannot certify it.

These corrections do not allege malicious intent or invalidate every implementation feature. They remove unsupported completion language. Preserve the earlier text through Git history; the remaining backlog describes evidence to produce, not evidence already supplied.

---

## 1. Deployed-state proof table

For every production contract, publish a row with:
- contract name
- chain + address
- deployed-bytecode hash
- Etherscan verified-source link
- `owner()` (zero / EOA / contract)
- EIP-1967 admin slot (must read 0x0…0)
- EIP-1967 implementation slot (must read 0x0…0 for non-proxies)
- multisig? (yes / no, with control surface if yes)
- renounce tx hash (if applicable)
- last config-write tx hash + whether further writes are possible

Format: markdown table in `docs/DEPLOYED_STATE.md`, plus a JSON / TSV
twin in `docs/deployed-state.tsv` so it's machine-readable.

Source of truth for population: `solidity/scripts/verify-etherscan.js`
already collects most of these; extend to emit the table.

## 2. LayerZero / OApp config-finality table

For every OApp contract, publish:
- contract name + address per chain
- `endpoint`
- `delegate` (after Phase-7 transfer-to-PathwayExpander)
- `peers` map (eid → trusted address)
- send-library + receive-library
- ULN config
- whether the OApp's `setPeer` / `setDelegate` / library setters are
  still callable by anyone (must be no)

Format: markdown table in `docs/LZ_CONFIG.md`.

Source: read live from chain via a script; commit the script + the
generated snapshot.

## 3. Historical-sync deterministic reproducer  ⚠️ NOT BUILT

> **Status: public reproduction remains an acceptance gate.** Do not cite the proposed artifact as available until the implementation and independent acceptance result are linked. Testnet can establish the procedure before mainnet; final addresses and receipts then bind the result to the released generation. Other authority, specification and deployment-evidence gaps remain in the consolidated register.

The big one. Single command path:

```
clean-DB → public repo @ <commit> → public contract addrs →
  chain-IDs → start-blocks → sync → export → SHA256 hash
```

**What it proves:** the indexer adds ZERO hidden state. Every byte of CAW's
social graph (profiles, posts, balances, follows) is derivable from public chain
data + the open-source code alone. If an independent reviewer reproduces the
exact export hash, "the chain is the only source of truth" stops being a claim
and becomes a runnable fact. Closes C08, C27, C39 in one shot.

Publish:
- `reproducibility/historical-sync.sh` — single shell script: clones the repo at
  the pinned commit, reads `reproducibility/manifest.json` (addresses, chain
  IDs, start blocks, RPC env var names), spins up a clean Postgres, runs the
  RawEventsGatherer + ActionProcessor from each start block to a pinned END
  block, runs the canonical export, prints the SHA256.
- `reproducibility/Dockerfile` — pinned env (exact Node, Postgres, package-lock)
  so the toolchain is identical for every reviewer and the hash is
  deterministic. PIN to a digest, not a floating tag.
- `reproducibility/manifest.json` — the pinned inputs: per-chain
  `{chainId, contractAddresses, startBlock, endBlock}` + the repo commit SHA +
  the RPC endpoints (or the env var names a reviewer supplies their own keys
  for). This is the single file that gets re-pointed testnet→mainnet.
- `reproducibility/export.ts` — the canonical, DETERMINISTIC export. Critical:
  it must serialize in a fixed order (sort every table by primary key), exclude
  non-deterministic columns (auto-timestamps, server-local IDs, indexer
  bookkeeping), and emit a stable canonical form (sorted-key JSON or a fixed TSV)
  so the same chain data always yields the same bytes regardless of insert order
  or wall-clock. This determinism work is the hard part — the sync already
  exists, the *reproducibility* of its output does not.
- `reproducibility/README.md` — chain IDs, contract addresses, start blocks, RPC
  requirements, how to run, expected export hash.
- `reproducibility/expected-export.sha256` — the canonical hash a reviewer
  reproduces.

**Build sequence (when V2 mainnet is live):**
1. Make the export deterministic FIRST (sort order + excluded columns + canonical
   form), tested locally against testnet so two runs of the same range hash
   identically. This is gateable before mainnet — build + prove determinism on
   testnet now, re-point `manifest.json` at mainnet later.
2. Pin the Docker env to a digest; verify a clean `docker run` reproduces the
   testnet hash on a second machine.
3. Fill `manifest.json` with the mainnet addresses + the deploy start blocks +
   a chosen finalized end block; run once; commit the resulting
   `expected-export.sha256`.
4. Acceptance: an independent operator runs the script from a clean clone
   against public RPCs and produces the SAME hash.

Acceptance criterion: an independent operator runs the script from a
clean clone and produces the same export hash.

This is the single most powerful artifact for "chain is the only source
of truth."

## 4. Calldata-as-truth example script

Concrete, runnable example proving the `ActionsProcessed` event is just
a commitment to calldata:

```
node scripts/calldata-as-truth.js <txHash> →
  fetches tx → decodes packedActions →
  rederives batchHash → asserts match against on-chain event
```

Format: `reproducibility/calldata-as-truth.{js,sh}` plus a short README
explaining what it proves.

Closes C32, C35 by demonstration.

## 5. Independent validator + mirror operator proofs

Sanitized real-world evidence that the validator + mirror roles are
permissionless and have been exercised by people other than us. Anchor
on the operators who actually did this in 2026-05 / 06: Zin, tenten,
nyarome.

Publish (with PII / keys redacted):
- on-chain `RegisterInstance` tx hashes for each independent operator
- `submitReplication` tx hashes from independent validator addresses
- challenge / fraud-proof tx hashes if any exist
- a brief narrative of what each operator did (with their consent)

Format: `docs/INDEPENDENT_OPERATORS.md`.

Closes C24, C25.

## 6. Frontend independence demo

A second FE pointed at the same chain + indexer, running on a different
host with no shared infra. Either:
- ask one of the existing operators to spin up their FE publicly
- or build a minimal `examples/minimal-fe/` that connects directly to
  the public contracts and reads / writes without our API at all

Format: live URL + repo link + screenshot.

Closes C25.

## 7. Slashing demo

Live or test evidence that a fraudulent archive submission can be
slashed for the validator's full stake. Already have
`client/scripts/slash-incoherent.ts` per `reference_slash_incoherent_cli`
memory; need to:
- run it against a deliberately-fraudulent submission on testnet
- capture the slash tx + the resulting stake-zero state
- publish the recipe so a reviewer can repeat

Format: `docs/SLASHING_DEMO.md` + included tx hashes.

Closes C38.

## 8. Session-key bounds proof

Test + script demonstrating session keys cannot delegate `withdraw`,
spend over `spendLimit`, survive expiry, survive transfer, or replay.
We already have foundry / hardhat tests for most of these — collect
them into a single citable bundle.

Format: `docs/SESSION_KEY_GUARANTEES.md` linking to specific test files
+ specific assertion lines.

Closes C41.

## 9. Claims-matrix TSV (in our repo)

The peer-review repo uses a `claims_matrix.tsv` as a single source-of-
truth artifact tracking every testable claim with status + evidence +
verification command. Adopt the same shape for our own docs:

```
ClaimID  Claim  Status  Evidence  VerificationCommand
```

Format: `docs/CLAIMS.tsv` + a human-readable `docs/CLAIMS.md`.

Useful regardless of external reviewers — it's a citable artifact for
operators, integrators, and security researchers.

## Ordering

Items 1, 2, and 3 are the highest-impact. Items 1 + 2 require a complete authority/configuration graph and independently checked receipts. Item 3 requires a real recovery exercise. None is closed by a promised post-launch publication.

Items 5, 6 are mostly coordination with existing operators — could ship
before mainnet if Zin / tenten consent.

Items 4, 7, 8 are small follow-ups, each closing one or two specific
claims via demonstration.

Item 9 is the framing layer — wraps everything else into a single
citable index.

## Maps to public peer-review claim IDs

C06, C26, C36, C37 → item 2
C08, C27, C39 → item 3
C20, C22, C33, C34 → item 1
C24 → items 5, 6
C25 → items 5, 6
C32, C35 → item 4
C38 → item 7
C41 → item 8
C42 → item 1 (general "is final deployed bytecode reviewed" gate)

Authority claims (C02, C11, C16, C18) are intentionally not on this
backlog. The manifesto premise is leaderless; "official authority" is
not a claim we make or need to defend.
