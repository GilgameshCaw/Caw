# Proof-of-Compliance Backlog

Artifacts to publish alongside V2 mainnet deploy + renounce, so the
manifesto compliance claims are independently verifiable rather than
asserted. Maps to a public peer-review checklist circulating in 2026-06.

Status: pre-mainnet. Most items ship in one pass post-deploy.

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

## 3. Historical-sync deterministic reproducer

The big one. Single command path:

```
clean-DB → public repo @ <commit> → public contract addrs →
  chain-IDs → start-blocks → sync → export → SHA256 hash
```

Publish:
- `reproducibility/historical-sync.sh` — single shell script
- `reproducibility/Dockerfile` — pinned env so RPC + Node + Postgres are
  identical for every reviewer
- `reproducibility/README.md` — chain IDs, contract addresses, start
  blocks, RPC requirements, expected export hash
- `reproducibility/expected-export.sha256` — the canonical hash a
  reviewer should reproduce

Acceptance criterion: an independent operator runs the script from a
clean clone and produces the same export hash.

This is the single most powerful artifact for "chain is the only source
of truth" — landing it would close C08, C27, C39 in one shot and
demonstrate every "censorship-resistance reduces to an on-chain fact"
whitepaper claim viscerally.

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

Items 1, 2, and 3 are the highest-impact. Items 1 + 2 are mechanical
once V2 mainnet is up. Item 3 is the genuine engineering work and the
piece that makes everything else credible.

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
