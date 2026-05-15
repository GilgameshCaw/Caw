# Security Audit — Options and Current Posture

## Why this doc

CAW deploys contracts once, immutably. Pre-launch security is the only
window we get. After deploy there is no upgrade path — anything we missed
lives on the chain forever.

This doc lays out the options we've considered, what's already been done,
and what remains as open decisions. The cost numbers are approximate;
real quotes will move them.

## What's already done

- **Foundry property tests** (`solidity/test-foundry/`). Per-function
  invariants. Came back clean.
- **Echidna stateful invariant fuzzing** (`solidity/echidna/`). 4 harnesses,
  19 invariants, all passing at testLimit=50000. No real bugs surfaced.
  Different bug class than foundry — finds multi-tx state-sequence
  issues. Commit `e1f0284c`.
- **Documented audit pass 2026-05-13** (`docs/SECURITY_AUDIT_2026-05-13.md`,
  with index in memory). All findings either fixed or formally deferred.
- **Ongoing AI-agent adversarial design reviews**. Multiple sessions of
  trying to break the protocol on paper — validator grief modes, mirror
  divergence, cross-chain trust assumptions, coalition attacks. Findings
  documented in memory (e.g. cawonce silent-loss window, session-spend
  drift on peer-validated, both fixed).
- **AUDIT_2026_05_08 findings list** (`docs/`). Historical.

## What's open — the ladder

Each option below is independent. They're additive, not alternatives.
You can do any combination based on what funds + time allow.

### 1. CawProfile / CawProfileL2 Echidna harness — INTERNAL, NO BUDGET

The highest-value remaining test we haven't written. Stake / withdraw /
session-spend invariants. The Echidna pass skipped these because the
contracts inherit OApp (LZ glue at construction), so we'd need to write
a ~200-line mirror harness.

Cost: 4-8 hours of agent time. Catches a class of bugs nothing else has
hit yet. **Recommend doing this regardless.**

### 2. Code4rena competitive audit — PAID, $15-25K

C4 contests run with prize pools as low as $15K for small protocols.
Multiple auditors race; we pay the pool, distributed by severity.

Pros:
- Cheaper than a firm engagement.
- Multiple eyes, parallel coverage.
- Time-boxed (typically 3-7 days of contest + ~2 weeks of judging).

Cons:
- Smaller pools attract less experienced auditors.
- Coverage of a novel architecture (optimistic-archive + multi-mirror)
  may not be as deep as a dedicated firm.
- Real money out the door.

### 3. Testnet bug bounty — PAID-ON-RESULTS, no minimum

Run a bug bounty against the deployed testnet contracts before mainnet.
Hunters look at the deployed code, find issues, claim payouts. Pay only
on finding.

Pros:
- Same incentive structure as a post-launch bounty, but findings happen
  pre-launch when we can still fix.
- For an immutable-contracts protocol this is much higher-value than the
  more common post-launch bounty.
- No upfront commitment — payouts only for actual issues.
- Could potentially be community-crowdfunded (the community has a
  direct interest in CAW launching safe).

Cons:
- Hunters self-select on payout size. A small bounty pool may not draw
  serious researchers.
- Requires Immunefi or similar listing infrastructure.

**Probably the highest-leverage paid option.**

### 4. Firm engagement — PAID, ~$50K

Spearbit, Trail of Bits, OpenZeppelin all do consultative engagements
where auditors challenge the protocol design, not just hunt for
`transfer()` reentrancies. Usually 4-6 weeks.

Pros:
- Deepest coverage. Design-level findings, not just code-level.
- Reputable name for community confidence.

Cons:
- $50K is real money the project doesn't currently have allocated.
- Long lead time (booking + the engagement itself).

Currently a stretch. If we crowdfund this, the budget asks the community
to pay for a marquee security signal — worth considering, but only if
options 1-3 don't get us to a place we're comfortable with.

## Decision points the community can weigh in on

1. **Should we crowdfund a testnet bug bounty pool?** Probably the
   single highest-leverage paid option. Amount TBD; even $5K seeds a
   meaningful early program.
2. **Should we crowdfund a Code4rena contest?** $15-25K. Different
   coverage shape than #1.
3. **Should we crowdfund a firm engagement?** $50K. Highest signal,
   highest cost, longest lead time.
4. **None of the above — accept Echidna+foundry+adversarial-design
   coverage as sufficient.** This is the current default if nothing
   gets funded. We continue running internal reviews; ship at the
   comfort threshold.

The current internal coverage is good. Each of the paid options adds
real signal. None of them produce certainty. The right answer probably
depends on what the community is willing to fund and how soon mainnet
needs to happen.
