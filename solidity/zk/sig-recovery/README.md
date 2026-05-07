# sig-recovery — SP1 zkVM circuit for CAW

A zero-knowledge circuit that verifies ECDSA signatures over CAW action data
off-chain, producing a Groth16 proof the on-chain `CawActions` contract can
check in a single ~250K-gas verifier call (vs. one ECDSA recovery per action).

## What it proves

Given a packed-actions blob and a packed-sigs blob plus the EIP-712 domain
separator, the circuit attests:

> "I correctly recovered the signer of every action in this batch. The
> recovered signer addresses, in order, are committed by `signersHash`."

It does **not** prove anything about chain state (cawonces, balances, hash
chain). The on-chain code does that work using the verified `signers[]` array
the prover supplies.

This is **stateless** and therefore **race-safe**: a competing transaction
cannot invalidate an in-flight proof. If a cawonce is consumed elsewhere
between proving and submission, the on-chain `processActionsWithZkSigs`
entry point skips that action and processes the rest. The whole batch is
not lost.

## Public inputs (committed by the proof)

1. `keccak256(packedActions)` — binds proof to a specific actions blob
2. `keccak256(packedSigs)` — binds proof to specific signatures
3. `keccak256(abi.encodePacked(signers))` — commits to the recovered addresses
4. `domainSeparator` — binds proof to this contract on this chain

## Layout

- `program/src/main.rs` — the circuit. Walks sig groups, recomputes
  EIP-712 digests, ECDSA-recovers signers via SP1's audited `k256` precompile,
  enforces the within-group invariants (mixed senders, contiguous cawonces),
  and commits the four public values via `sp1_zkvm::io::commit`.
- `lib/src/lib.rs` — shared types (CircuitInputs, PublicValuesStruct,
  UnpackedAction) and the EIP-712 digest math. Used by both program and
  script. The `Keccak` trait abstraction lets the program use SP1's
  precompile and the script use `tiny-keccak`.
- `script/src/bin/main.rs` — `--execute` smoke test (run the program inside
  SP1's zkVM emulator and assert the host's expected public values match
  what the program committed). 1 action, ~3M cycles.
- `script/src/bin/evm.rs` — generate the canonical Groth16 fixture used by
  the on-chain tests. Writes `solidity/test/zk-fixtures/groth16-fixture.json`.
- `script/src/bin/prove-batch.rs` — read inputs from a JSON file, write the
  proof + committed values to another JSON file. Driven by the validator
  shim (`client/src/services/ValidatorService/zkProver.ts`).
- `script/src/bin/digest-fixtures.rs` — emit (ActionData, structHash, digest)
  fixtures for the Solidity equivalence test.
- `script/src/bin/vkey.rs` — print the program's verifying key (the value
  pinned into CawActions at deploy time).

## Build (macOS arm64)

Prereqs:
- Rust + Cargo
- SP1 toolchain (`curl -L https://sp1up.succinct.xyz | bash` then `sp1up`)
- Go (gnark FFI for the Groth16 wrap stage — `arch -arm64 brew install go`)
- `LIBCLANG_PATH` set so bindgen finds Apple's libclang, not an x86_64
  Homebrew copy

```bash
export PATH="$HOME/.sp1/bin:/opt/homebrew/bin:$PATH"
export LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib

# Smoke test (no proof — runs inside the zkVM emulator). ~10s.
cargo run --release --bin sig-recovery -- --execute

# Real Groth16 proof (regenerates the fixture used by on-chain tests).
# First time: 90 minutes including a one-time 5.79 GB SRS download.
# Subsequent: ~34s. Requires ~16 GB peak RAM during the wrap stage.
RUST_LOG=info cargo run --release --bin evm

# Prove an arbitrary batch the validator captured (used by zkProver.ts).
cargo run --release --bin prove-batch -- \
    --input  /tmp/zk-inputs.json \
    --output /tmp/zk-proof.json
```

`--execute` runs the program inside SP1's zkVM emulator without proving —
fast, catches logic bugs, exercises the same circuit code real proving
runs. Real proving generates a Groth16 proof you can submit on-chain.

## Hosted vs local proving

| Path | Latency | RAM | Cost | Setup |
|------|---------|-----|------|-------|
| Local (Mac, warm cache) | ~34s | ~16 GB peak | electricity | one-time SRS download |
| Local (low-RAM VPS) | not viable | OOMs at 16 GB wrap | — | — |
| SP1 hosted network | ~10s | ~0 (delegates) | $0.10–0.50/proof | `SP1_PROVER=network` + `NETWORK_PRIVATE_KEY` |

For any host with less than ~12 GB free RAM, hosted is the only option.
Both paths produce a byte-identical proof; the on-chain verifier doesn't
care which one ran.

## Status

Production-ready ✅ — the circuit, Solidity wiring, validator shim, and
on-chain integration are all green:

- ✅ Hello-world skeleton + real circuit
- ✅ Equivalence-tested vs Solidity (`test/zk-digest-equivalence-test.js`)
- ✅ MockSP1Verifier unit tests (`test/zk-actions-test.js`)
- ✅ Real verifier on-fork tests (`test/zk-real-verifier-test.js`)
- ✅ Canonical Base Sepolia bytecode fork test (`test-fork/zk-fork-test.js`)
- ✅ Validator integration with skip-don't-revert handling
- ⏸ Background prover worker (deferred — see `docs/ZK_SIG_PATH.md` for the
  shape of the queueing decision)
