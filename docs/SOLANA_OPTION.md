# Solana as a possible future archive / parallel chain

**Status:** Speculative. Documented for future-us so we don't re-derive the analysis. Not on the roadmap, not promised, not staffed.

**Last evaluated:** 2026-05-11

## Why this is even on the table

Not for gas savings. The original framing of this conversation was "Solana is 5x cheaper" — that turned out to be wrong (see "The gas math, honestly" below). The actual reason Solana is interesting as a long-term archive / parallel-chain candidate is **survival probability**: Solana is one of a small number of L1s with a credible case for existing in 20+ years, regardless of what happens to any specific L2 ecosystem, foundation, or rollup operator.

For a protocol whose pitch is "speech anchored to chains that outlive the team," chain longevity is a real axis to evaluate on — and it's one Solana arguably wins. The cost-savings axis doesn't justify the engineering, but the longevity axis might, eventually.

## The gas math, honestly

The initial intuition was that Solana's lower per-tx fees would translate to ~5x cheaper actions. **At CAW's actual batch sizes, this turns out to be wrong** — the 1232-byte Solana transaction size limit collapses the batching advantage that makes EVM cheap at scale.

| Chain | Per-tx fee | Realistic batch size | Per-action cost | 10M actions/day |
|---|---|---|---|---|
| Base (current) | ~$0.005 | ~30-100 actions/tx | ~$0.0001/action | ~$1,000/day |
| Solana (steady state) | ~$0.0008 base | ~5-10 actions/tx (packet limit) | ~$0.00015/action | ~$1,500/day |
| Solana (under congestion) | base + priority fees, 10-50x higher transiently | same | up to ~$0.005/action | up to ~$50,000/day |

**At our batch sizes, Solana is roughly the same cost or marginally more expensive than Base.** The packet limit means we can fit ~6x fewer actions per tx than on EVM, which more than cancels Solana's ~6x cheaper per-tx fee.

Priority fees during Solana congestion can push per-action cost 10-50x higher transiently, which makes Solana *worse* for workloads with viral / bursty patterns (a social protocol absolutely has these). Base's L2 fee model is more predictable under congestion.

### Where Solana *would* be a gas win

For completeness — the scenarios where the math flips:

- **Small / unbatched workloads.** If CAW ever had a flow where actions are submitted one-at-a-time (single signed action per tx, no validator batching), Solana would beat Base on per-tx fees. Our design specifically optimizes for big batches, so this doesn't apply — but if a future feature added single-tx user-direct submission (e.g., a "fast path" without validator batching), Solana would be cheaper for that path.
- **Solana ships a packet size increase.** Currently 1232 bytes. If Solana raised this to, say, 4-8KB, batch density would improve dramatically and the per-action math could swing in Solana's favor. Not on any roadmap I know of, but technically possible.
- **Ethereum DA costs spike sustainedly.** Base's per-action cost is dominated by L1 blob/DA costs. If Ethereum DA gets meaningfully more expensive long-term (heavy blob demand from many rollups), Solana's relative cost advantage grows even at our batch sizes.
- **Compute-heavy actions.** If we ever added action types that need expensive computation (e.g., on-chain ZK proof verification per action), Solana's compute pricing is structurally different and might be more favorable. None of our current actions are compute-heavy, so this is hypothetical.

### Conclusion on gas

**Don't migrate the action-processing chain to Solana for gas savings.** The numbers don't work at our batch sizes.

The gas analysis doesn't kill Solana as an *archive-chain* option, though — archive cost is dominated by infrequent `submitReplication` calls, not per-action volume. The archive use case stands or falls on the longevity argument below, not on gas.

## Where Solana might actually win (the longevity story)

Things that are genuinely true and matter on a multi-decade horizon:

- **Solana is an L1, not an L2.** It doesn't depend on Ethereum settlement, doesn't depend on a rollup operator, doesn't depend on a multisig-controlled bridge. Its survival is a function of its own validator economics, not anyone else's.
- **Validator set is several thousand, geographically distributed**, with a Nakamoto coefficient meaningfully higher than most L2s' "single sequencer."
- **Two independent client implementations.** Firedancer (Jump) and Agave (Solana Foundation) — client diversity matters for chain survival in a way that no L2 has.
- **It has a real economy.** SOL has value, validator rewards exist, there's an actual reason for the chain to keep running even if any specific project on it dies.
- **Outage track record has improved.** 2021-2023 had multiple multi-hour outages; 2024-2026 has been much more stable. Trajectory is favorable.

What this would buy CAW if Solana hosted an archive deployment: **a chain-survival hedge.** If every EVM L2 we've deployed to gets sunsetted, deprecated, or governance-captured over 10 years, having an archive on Solana means the protocol's historical record survives independently of the EVM ecosystem's specific trajectory.

That's a real property. It's also not urgent. The protocol's historical record on Ethereum L1 (where the canonical CawProfile / token / name registry live) is the *primary* survival guarantee. Solana would be a secondary one.

## The engineering reality

Honest scope to put a Solana archive chain in production, evaluated mid-2026:

- **CawActions port to Anchor/Rust:** 3-4 months for an experienced lead. EIP-712 verification via `secp256k1_recover` syscall works (~25K CU per signature recovery). Packed-calldata batching needs to be redesigned around the 1232-byte limit and PDA account model.
- **CawProfile + CawProfileL2 equivalents:** 2-3 months. Solana NFTs via Metaplex Token Metadata or Token-2022 — pick one and commit, both have sharp edges.
- **CawActionsArchive + CawChallengeRelay receiver port:** 3-4 months. This is the riskiest piece because cross-VM LayerZero message handling has fewer reference implementations.
- **Integration, devnet shakeout, audit prep:** 2 months.
- **Audit:** 6-10 weeks calendar, $150-300K cost. 1.5-2x EVM audit cost because the auditor pool is smaller and the auditor pool that understands *both* LayerZero V2 Solana semantics *and* Solana's account-model security is very small.

**Total realistic calendar: 10-14 months to mainnet parity**, parallel to maintaining the EVM contracts (which we'd keep doing because EVM remains the primary venue). Team composition assumption: 2-3 engineers with one Solana-experienced lead. If we don't have that person, add 6-10 weeks of ramp for EVM-native engineers learning Solana's account model.

This is a year-plus parallel implementation, not a port. There is no "compile this Solidity to Rust." Every contract gets rewritten.

## Architectural notes for future-us

If/when this becomes a real project, the cheapest version is **Solana as one of N archive chains in `MULTI_CHAIN_STORAGE.md`'s validator-choice menu**, not as a replacement for any existing chain. The model:

1. EVM archive (Arbitrum / Base / Optimism — whatever we end up with) stays the default.
2. Solana archive becomes an *additional* option a validator can pick if they specifically want to.
3. The L1 trust anchor (CawProfile on Ethereum mainnet, CAW token) doesn't change.
4. The L2 action-processing chain doesn't change (Solana is not viable for action processing — see "The gas math" above).

This is the lowest-commitment version because we don't deprecate anything. EVM keeps working. A validator who specifically wants Solana-archive picks it. If no validator picks it, the code is dormant but not blocking.

The hard parts that need a real design pass before any engineering starts:

- **LayerZero V2 cross-VM message handling.** `CawChallengeRelay` on an EVM source chain → Solana archive program. LZ V2 supports this in theory; we'd need to verify the actual production deployment count and DVN coverage on Solana at the time we'd start.
- **EIP-712 signature verification inside a Solana program.** Doable via `secp256k1_recover` + custom keccak chaining, but no clean public reference implementation exists for full EIP-712 typed-data verification on Solana. We'd be writing it from scratch and getting it audited.
- **Account pre-allocation costs.** Every per-client state account on Solana has rent-exempt minimums. At 1M users, the rent-exempt SOL locked up could be ~$300K of working capital. This is a treasury model question, not just an engineering one. EVM has no analog (storage is paid per-write via gas, not pre-funded).
- **The 1232-byte transaction limit.** Forces a redesign of the packed-batch model. Likely means smaller per-tx batches and more sequential txs to process the same volume.

## When to revisit

Specific signals that should reopen this for serious consideration:

- **An EVM archive chain we depend on shows hostile or unstable behavior** (governance abuse, prolonged outages, sequencer capture) — in which case "we want a non-EVM hedge" becomes urgent.
- **A community contributor with Solana production experience volunteers** to do the port. This is the cheap path; the core team learning Solana from scratch is the expensive path.
- **Solana ecosystem maturity for LayerZero V2 OApps reaches "many production complex deployments"** (currently it's single-digit complex deployments). Building a complex OApp on Solana right now means being one of the first to hit the corners.
- **CAW reaches enough scale that "the protocol's data survives on more than one chain family" becomes a marketing / credibility issue** worth spending the engineering year on.
- **Solana ships a meaningful packet-size increase** or otherwise removes the constraint that collapses batch density. This is unlikely but would change the cost calculus.

## Alternatives that were considered and rejected

For completeness so we don't re-derive these:

- **Sui / Aptos (Move).** Equal pain of migration, worse ecosystem, smaller auditor pool, weaker LayerZero V2 support. No advantage over Solana on the longevity axis. Not pursuing.
- **Stellar Soroban.** Throughput ceiling too low for 10M actions/day target. Not pursuing.
- **Monad / MegaETH / Sei v2 / Berachain (EVM-equivalent high-throughput L1s).** These would be near-zero migration cost if we just wanted better throughput — same Solidity, same tooling, same LZ V2 EVM stack. But none has Solana's longevity track record yet (they're all new), so they don't satisfy the "live forever" criterion that's the actual reason we'd consider non-EVM. Worth monitoring as cheap-throughput options independent of the Solana question.
- **Just better EVM batch density.** Higher-leverage gas optimization than a Solana port if cost-per-action is the goal. Not pursued yet but logged as a future option if 10M actions/day pushes Base costs uncomfortably.

## References

- `docs/MULTI_CHAIN_STORAGE.md` — where Solana would plug in as an archive-chain option
- `docs/REPLICATION_AND_SLASHING.md` — what the archive contract actually does
- `PROJECT_BACKLOG.md` — backlog placeholder
