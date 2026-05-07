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

- `program/` — the circuit (compiles to RISC-V, runs inside SP1's zkVM)
- `script/` — host program that drives proving, exports the Solidity verifier
- `lib/` — shared types between program and script

## Build (macOS)

Requires SP1 toolchain (install via `curl -L https://sp1up.succinct.xyz | bash`)
and the `succinct` Rust toolchain (auto-installed by `sp1up`). Also requires
Go (for SP1's gnark FFI in the SDK).

On macOS arm64, set `LIBCLANG_PATH` so bindgen finds Apple's libclang
instead of an x86_64 Homebrew install:

```bash
export PATH="$HOME/.sp1/bin:/opt/homebrew/bin:$PATH"
export LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib

cargo build --release --bin sig-recovery
RUST_LOG=info cargo run --release --bin sig-recovery -- --execute --n 10
```

`--execute` runs the program inside SP1's zkVM emulator without proving (fast,
catches logic bugs). `--prove` generates a real proof (slow; requires either
local proving with 16+ GB RAM, or SP1's hosted network — see SP1 docs for
the `SP1_PROVER` env var).

## Status

Hello-world skeleton ✅. Real sig-recovery logic incoming in the next commit.
