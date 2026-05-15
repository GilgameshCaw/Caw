# Signer service — design sketch

**Status:** design sketch for review. No code yet.

**Goal:** reduce the blast radius of a `VALIDATOR_PRIVATE_KEY` compromise from "attacker can do anything the validator can do" to "attacker can ask a policy-constrained signer to sign things the policy allows." If the validator process is compromised, the attacker shouldn't be able to drain the hot wallet to a destination of their choice, or get the validator slashed by submitting fraudulent archive replications.

Current state: the key lives in `VALIDATOR_PRIVATE_KEY` env var, loaded by dotenv, instantiated as `new Wallet(VALIDATOR_PRIVATE_KEY, provider)` inside the validator process. Any code path in that process — including arbitrary code from a compromised dependency or a deserialization bug — can call `wallet.sendTransaction({...whatever...})` and the key signs it.

## Threat model

What the validator key can do today (post-compromise of the validator process):

- Submit `processActions` calldata to L2 — bounded because the inner action sigs are user-signed; attacker can't forge action contents
- Submit `submitReplication` to the archive chain — **slashing risk** if the submission is fraudulent
- Send arbitrary ETH from the hot wallet — drains the validator's gas budget
- Send arbitrary LZ token (if held) — drains LZ balance
- Call any other on-chain function (transfer NFTs the validator owns, etc.)
- Sign arbitrary messages (e.g., signed off-chain attestations) that downstream consumers might trust

What the validator key **cannot** do (already protected):

- Forge a user's action — inner EIP-712 sig stops them
- Spend a user's CAW — sessions are per-(owner, signer), validator isn't a signer for any user
- Mint a username they don't own — `mintFor` pulls CAW from `msg.sender` and the validator isn't the buyer

So the blast radius today is: hot wallet ETH + LZ balance + slashing exposure + ability to sign arbitrary contract calls as the validator address.

## Design: signer as a separate process

Two processes on the same VPS, running as different OS users with strict file permissions:

```
┌─────────────────────────────────────────────────┐
│  Validator service                              │
│  - Runs as user `caw` (existing)                │
│  - Has NO private key                           │
│  - Reads TxQueue, builds calldata, requests sig │
│  - Submits the signed tx to chain               │
└──────────────────┬──────────────────────────────┘
                   │ Unix domain socket
                   │ (or localhost HTTP, see below)
                   ▼
┌─────────────────────────────────────────────────┐
│  Signer service                                 │
│  - Runs as user `caw-signer` (new, restricted)  │
│  - Owns VALIDATOR_PRIVATE_KEY                   │
│  - Enforces signing policy                      │
│  - Refuses calldata that doesn't match the      │
│    allowlist                                    │
└─────────────────────────────────────────────────┘
```

The signer is small (a few hundred lines), single-purpose, and audit-friendly. The validator is large and complex but **no longer holds the key.**

## The signing policy is the heart of the design

The signer accepts a sign request and either signs it or rejects it. The decision is based on a strict allowlist of (chain, target contract, function selector, parameter constraints). Anything outside the allowlist is rejected.

Concretely:

| Chain | Target | Selector | Constraints | Why |
|---|---|---|---|---|
| L2 (Base Sepolia) | `CAW_ACTIONS_ADDRESS` | `processActions` (4-byte) | `value <= maxPerTxLzFee`; `gasLimit <= 30M` | Normal validator submission |
| L2 | `CAW_ACTIONS_ADDRESS` | `safeProcessActions` | same | Defensive submission variant |
| L2 | `CAW_ACTIONS_ADDRESS` | `processActionsWithZkSigs` | same | ZK path |
| Archive (Arbitrum Sepolia) | `OPTIMISTIC_ARCHIVE_ADDRESS` | `submitReplication` | merkle root non-zero; entryHash non-zero | Replication |
| Archive | `OPTIMISTIC_ARCHIVE_ADDRESS` | `deposit` | `value == MIN_STAKE` (0.01 ETH) | One-time stake on first run |
| Archive | `OPTIMISTIC_ARCHIVE_ADDRESS` | `finalizeSubmission` | finalizable submissionId only | Auto-finalize loop |
| Archive | `OPTIMISTIC_ARCHIVE_ADDRESS` | `withdrawExcessStake` | recipient == self only | Auto-withdraw loop |
| L2 (source) | `CAW_CHALLENGE_RELAY_ADDRESS` | `relayChallenge`, `relayChallengeBatch` | `value` capped at 1.5× of canonical LZ quote | Fraud-relay challenge |

Anything the validator wants to sign that doesn't match this table is rejected with `POLICY_REJECT`. Notably **excluded**:

- Raw ETH transfers (`to` != known contract, empty calldata)
- ERC-20 `transfer` / `approve` calls
- NFT transfers
- Arbitrary `delegatecall` shapes
- Anything to addresses not on the allowlist
- Anything signed via `signMessage` (off-chain attestation) — refused outright, the validator has no legitimate need to sign off-chain messages

Result: a fully-compromised validator process can only do what an honest validator would do — submit batches, replicate, challenge. They can still drain the hot wallet by burning gas on legitimate-looking submissions, but they cannot transfer ETH out, transfer NFTs, or pretend to be the validator off-chain.

## IPC: Unix domain socket vs. localhost HTTP

**Unix domain socket** (preferred):

- File at `/var/run/caw-signer/signer.sock`, owned by `caw-signer:caw-signer`, mode `0660`. The `caw` user is added to the `caw-signer` group so it can connect, but cannot read anything else from that user's homedir or env.
- No network attack surface — can't be hit from outside the box even if firewall is misconfigured.
- Protocol: length-prefixed JSON messages (request + response). One request, one response, close, or persistent connection with per-request IDs.

**Localhost HTTP** (alternate):

- Simpler to implement, easier to debug (curl works).
- Risk: another process on the box that can bind to 127.0.0.1 can hit the signer. Mitigated by checking peer credentials but not as clean as a Unix socket.

Recommendation: **Unix domain socket** for prod; localhost HTTP for dev where socket permissions get fiddly.

## Request / response shape

```
// Request from validator → signer
{
  id: "req_abc123",                    // for response correlation
  chainId: 84532,                       // Base Sepolia
  to: "0x...",                          // CAW_ACTIONS_ADDRESS
  data: "0x9bdc...",                    // ABI-encoded calldata
  value: "1000000000000000",            // wei, as string for BigInt
  gasLimit: "1500000",
  maxFeePerGas: "30000000000",
  maxPriorityFeePerGas: "2000000000",
  nonce: 1234                           // pre-fetched by validator
}

// Response from signer
{
  id: "req_abc123",
  ok: true,
  signedRawTx: "0x02f8..."              // ready for eth_sendRawTransaction
}

// Or rejection
{
  id: "req_abc123",
  ok: false,
  error: "POLICY_REJECT",
  reason: "to=0x... not on allowlist for chainId=84532"
}
```

Validator-side: replace `wallet.sendTransaction(...)` with `signer.sign(...)` → returns raw signed tx → `provider.broadcastTransaction(raw)`.

## Where the policy comes from

A YAML or JSON file at `/etc/caw-signer/policy.json` (owned by `caw-signer:caw-signer`, mode `0640`, root can edit). Contains the allowlist table above. **Loaded once at signer startup.** Reloading requires SIGHUP or restart — no runtime mutation, so a compromised validator can't push a new policy in to expand its own permissions.

```json
{
  "version": 1,
  "chains": {
    "84532": {
      "name": "base-sepolia",
      "targets": {
        "0xcaw_actions_addr_here": {
          "selectors": {
            "0x9bdc...": { "name": "processActions", "maxValue": "100000000000000000", "maxGasLimit": "30000000" }
          }
        }
      }
    },
    "421614": {
      "name": "arbitrum-sepolia",
      "targets": {
        "0xoptimistic_archive_here": {
          "selectors": {
            "0xabcd...": { "name": "submitReplication" }
          }
        }
      }
    }
  }
}
```

## Failure modes

| Scenario | Behavior |
|---|---|
| Signer down / unreachable | Validator's `signer.sign()` returns an error; submission loop logs + retries with backoff. Validator does NOT fall back to in-process signing — there is no in-process key. |
| Signer compromised | Catastrophic. Same blast radius as today. The signer is small + audited + can have additional hardening (network-firewall, no internet egress, no shell). |
| Validator compromised | Limited to what policy allows. Attacker can submit honest batches (no harm), can submit fraudulent replications (gets slashed — but the policy could add a per-day cap on submitReplication count to make this slow), can burn gas. They cannot drain ETH directly or sign off-chain. |
| Policy file tampering | Detected on signer restart if the file has been modified. Could optionally sign the policy file at install time with a key only the operator has, and have the signer verify on load. |
| Network partition mid-signing | Validator times out, retries. Signer is idempotent — same request twice produces the same signed tx (deterministic with the same nonce). |
| Nonce desync | Validator pre-fetches nonce and includes it in the request. Signer just signs what it's told. Validator's existing `_submitChain` nonce serializer (see `project_validator_nonce_serializer`) keeps working. |
| Signer can't connect to RPC | Doesn't need to. Signer is offline-style: it signs calldata it's given. Validator does all RPC. |

## Deploy story

`cli/src/steps/install.js` and `cli/src/steps/update.js` already orchestrate the validator's pm2 entry. Add a sibling:

- `pm2 start ecosystem.signer.config.cjs --only caw-signer` — runs the signer process.
- The signer's pm2 entry runs as user `caw-signer` (created at install time if missing).
- The signer reads `VALIDATOR_PRIVATE_KEY` from `/etc/caw-signer/signer.env` (owned by `caw-signer:caw-signer`, mode `0600`, root-installed).
- The validator's `.env` no longer contains `VALIDATOR_PRIVATE_KEY`.
- Validator gets a new env: `SIGNER_SOCKET_PATH=/var/run/caw-signer/signer.sock`.

`caw update` orchestrates both: pull, install validator deps, install signer deps (if separate package), restart signer (rare — only on signer code changes), restart validator (normal).

`caw secrets rotate-validator-key` (new CLI command): generates a new key, writes it to `/etc/caw-signer/signer.env`, restarts the signer. The validator never sees the key.

## What this doesn't fix

- **Hot wallet drain via legitimate-looking submissions.** Attacker can keep submitting valid `processActions` until the gas runs out. Solved separately by keeping the hot wallet balance low and topping up from a cold wallet (off-VPS, hardware-wallet-controlled) only when needed.
- **Slashing.** Attacker can submit fraudulent replications. Policy can rate-limit `submitReplication` to N/day to slow the bleed. Real fix is hardware-backed signing (option 5 in the earlier discussion) where the attacker can't get the signer to sign at all without physical access.
- **Replay of legitimate sign requests.** The signer doesn't track which requests it has already signed. If an attacker captures a signed tx and re-broadcasts it, the chain rejects via nonce. Not a signer problem.

## Open questions for design review

1. **Should the signer also rate-limit by request type per time window?** E.g., max 1 `submitReplication` per minute, max 10 `processActions` per minute. Catches "compromised validator spamming submissions" earlier than waiting for the ETH balance to hit zero.
2. **Should signing requests be logged?** A signed-request log on the signer's disk would let an operator audit what was signed. Cheap to add but adds a small attack surface (logs grow, need rotation).
3. **Should the signer enforce per-chain nonce monotonicity?** Currently the validator pre-fetches; the signer doesn't know if the validator sent the same nonce twice (with different content). For honest workflows this can't happen; for compromised workflows it's a low-risk vector. Probably skip.
4. **What about the `REPLICATOR_PRIVATE_KEY`** (the optional separate key used in slash-test mode)? Either give it the same treatment, or accept that test-mode runs with the lower security posture. Probably the latter — test mode is dev-only.
5. **Single signer process for all chains, or one per chain?** Single is simpler. One per chain limits blast radius if a per-chain config bug breaks one of them. Lean single for v1.

## Implementation effort estimate

- Signer service: ~500-800 lines (JSON IPC, policy enforcement, ethers wallet, pm2 entry). 1-2 days of focused work.
- Validator-side adapter (replace `wallet.sendTransaction` calls with `signer.sign` + `provider.broadcastTransaction`): a few dozen call sites. 1 day.
- CLI install/update scripts to manage the second process: 1 day.
- Policy file design + initial allowlist gathering (reading every `wallet.send*` callsite in the validator): 1 day.
- Testing (unit on policy, end-to-end on test.caw.social): 1-2 days.

**Total: roughly 1 week for one focused engineer.**

## Recommendation on timing

Not blocking testnet. Worth doing before any meaningful value sits in the hot wallet (i.e., before mainnet, or before the validator starts handling user-funded paths). The branch split (`contract-support-v2`) is the natural time to land it — fits the "infrastructure changes that accompany the next deploy" shape.

The cheap interim mitigation that costs ~0 effort: **keep the hot wallet ETH balance low** (24-48h of gas, not weeks), with a top-up alarm. That alone caps the loss from a key compromise without any code changes.
