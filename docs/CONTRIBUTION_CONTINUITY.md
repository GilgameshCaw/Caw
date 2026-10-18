# Contribution continuity (opt-in proposal)

> A center may emerge, but it must never become a prerequisite.

A decentralized project can have people who take the lead. The risk is not
that someone becomes influential; it is that everyone else becomes unable to
continue when that person is unavailable.

This is a small, **optional** experiment in making work portable. It is not a
proposal to remove a maintainer, transfer GitHub permissions, impose rotation,
or declare the current development process decentralized.

## Two equally legitimate choices

- **Step forward:** contribute, make a decision within an agreed scope, and
  leave the reasoning and reproduction path visible to others.
- **Step back:** stop working, temporarily or indefinitely, without having
  to select or authorize a successor.

The continuation path should remain understandable to an independent person.
They are free to verify, disagree, amend, or start a different implementation.
No permanent owner or predetermined successor is required.

## A machine-checkable handoff, not machine-defined trust

A handoff JSON file has these fields:

| Field | What it preserves |
| --- | --- |
| **version** | The format version (currently 1). |
| **goal** | What the work was intended to achieve. |
| **status** | in-progress, paused, or complete. |
| **scope** | What is and is not being attempted. |
| **evidence** | References and what each reference helps establish. |
| **decisions** | Choices *and their reasons*; may be empty. |
| **checks** | Commands to reproduce checks and their expected results. |
| **unknowns** | Questions and uncertainties; may be empty but must be stated. |
| **nextSteps** | A possible continuation path; may be empty for completed work. |

See [the example](./contribution-handoff.example.json).

The checker verifies **structure only**: required fields, types, and non-empty
references. It does *not* execute the listed commands, retrieve evidence,
authenticate contributors, prove that tests passed, validate a technical
decision, or confer authority. Reviewers must examine and run commands
themselves, in a safe environment, before trusting them.

## Try it

No installation, database, secrets, node, or external service is needed;
Node.js 22+ is sufficient.

From the repository root:

    node scripts/check-contribution-handoff.mjs docs/contribution-handoff.example.json
    node --test scripts/check-contribution-handoff.test.mjs

To try this on your own work, copy the example to a JSON file and replace the
content with accurate references, checks, decisions, and remaining questions.
Then run the first command against the new file. The file can live in your
own fork, an issue, a PR, or elsewhere; it does not have to be merged here.

## Intentionally outside this proposal

- No GitHub branch protection, CI gate, code-owner rules, or mandatory handoff
  for every PR.
- No automated appointment or removal of maintainers, no term limit, and no
  hardcoded person, wallet, or role.
- No protocol, smart-contract, validator, deployment, or runtime changes.
- No claim that written evidence replaces independent review or that one
  person's unavailability is enough to prove decentralized governance.

CAW already has an
[agent handoff protocol](./AGENT_HANDOFF_PROTOCOL.md). This experiment is
different: it captures **human-readable, portable evidence about a piece of
work**, without adding a new deciding authority. If it proves unhelpful,
it should be revised or discarded rather than made into a rule.

## Question for reviewers

Does this preserve enough context to let a new contributor continue without
requiring permission or explanation from the previous contributor? What is
missing, and what would make it too restrictive?

A center may emerge, and a person may remain central for as long as they wish.
The system should still leave room for someone else to step forward—and
just as much room for them to step back.
