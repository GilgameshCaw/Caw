# VKEY reproducibility gap

**Status: OPEN — the exact toolchain that produced the deployed vkey is not
recorded anywhere in this repo.** This note states what we know, what has been
tried, exactly which files control the vkey, and precisely what the deployer
must capture to close the gap.

## The deployed vkey

The on-chain `CawActions` contract pins an immutable `zkProgramVKey`:

```
0x00197b568ede30c47de32e462b8f4b99897351568da36e5aad94cfbf6da94770
```

This value is committed in three places, all in lockstep:

- `solidity/test/zk-fixtures/groth16-fixture.json` → `"vkey"`
- `solidity/scripts/deploy.js` → `ZK_PROGRAM_VKEY` (with a build-time guard
  that aborts the deploy if it disagrees with the fixture)
- `solidity/scripts/verify-etherscan.js` → `ZK_PROGRAM_VKEY`

Because `zkProgramVKey` is immutable, the deployed contract will **only** accept
Groth16 proofs from a circuit whose ELF hashes to exactly this vkey. Any prover
that builds the circuit into a different ELF produces proofs the contract
rejects, and cannot exercise `processActionsWithZkSigs`.

## The problem

`0x00197b56…` was the vkey of the ELF that built the checked-in fixture back on
**2026-05-07** (`git show 045834c1`; the commit body describes a local ~34s
Mac prove). But **no released `cargo-prove` / `sp1up` toolchain currently
reproduces that vkey** when building the circuit from this branch. Reported by
validator nyaromesama:

| Toolchain (`sp1up -v …` / `cargo-prove --version`) | Resulting vkey |
|----------------------------------------------------|----------------|
| 6.0.1 (same ELF as 6.0 / 6.1 / 6.2)                | `0x0023a66e…`  |
| 6.1.0                                              | `0x0023a66e…`  |
| 6.2.0                                              | `0x0023a66e…`  |
| 6.3.1                                              | `0x00ef1dd0…`  |
| **deployed / committed fixture**                   | **`0x00197b56…`** |

None of the tried versions land on `0x00197b56…`. An operator who builds
locally therefore gets a vkey the deployed contract will not accept, and cannot
run the real ZK path.

## Why the Cargo.lock pin does NOT settle it

`Cargo.lock` pins the SP1 **libraries** at `6.1.0` (`sp1-sdk`, `sp1-zkvm`,
`sp1-build`, `sp1-prover` all `6.1.0`). That pin is necessary but **not
sufficient** to reproduce the vkey, because the vkey is a hash of the compiled
**guest ELF**, and the ELF is produced by a *different*, unpinned toolchain:

- **What is pinned (in git):**
  - `Cargo.lock` — SP1 host libraries at `6.1.0`.
  - `rust-toolchain` — `channel = "stable"` (the *host* Rust, not the guest
    compiler; "stable" is itself a floating pointer).
  - `program/Cargo.toml` / `script/Cargo.toml` — request `sp1-zkvm = "6.0.1"`,
    `sp1-build = "6.0.1"` as semver *minimums*; Cargo.lock resolves them up to
    `6.1.0`.

- **What is NOT pinned (decides the vkey):**
  - The `cargo-prove` / `sp1up` **CLI toolchain** — the Succinct RISC-V guest
    compiler that `sp1-build` shells out to. `script/build.rs` calls
    `sp1_build::build_program_with_args("../program", …)`, which invokes this
    CLI. Its version is chosen by whatever `sp1up` installed on the build host;
    it is **not** captured by `Cargo.lock`, `rust-toolchain`, or any file in
    the repo.
  - Consequence: two machines with identical `Cargo.lock` but different
    `cargo-prove` toolchains produce different ELFs → different vkeys. That is
    exactly the drift nyaro is seeing.

## Which files control the vkey (exact chain)

1. Guest crate: `program/src/main.rs` (+ `lib/`), built into an ELF named
   `sig-recovery-program`.
2. Build driver: `script/build.rs` → `sp1_build::build_program_with_args`,
   which invokes the **`cargo-prove` CLI** to compile the guest to RISC-V.
3. ELF embed: `script/src/bin/{vkey,evm,prove-batch,main}.rs` all do
   `include_elf!("sig-recovery-program")`.
4. vkey derivation: `script/src/bin/vkey.rs` —
   `prover.setup(SIG_RECOVERY_ELF).verifying_key().bytes32()`. The vkey is a
   pure function of that embedded ELF. Change the ELF bytes → change the vkey.

So the vkey is determined by **(guest source) × (cargo-prove CLI toolchain) ×
(sp1-build/sp1-sdk lib version)**. The guest source and the lib version are in
git; the **cargo-prove CLI toolchain is the missing input.**

## What the CI captures — and why it does not close the gap

`.github/workflows/prove.yml` (vendored from the SP1 template) does pin a CLI
version:

```yaml
~/.sp1/bin/sp1up -v v6.0.1
~/.sp1/bin/cargo-prove prove --version
```

But this does **not** resolve the gap, for two reasons:

1. That job only runs `cargo-prove prove build` + `cargo run -- --execute`. It
   **never** runs `vkey`/`evm`, never prints the vkey, and never regenerates
   the fixture — so CI has never asserted that its toolchain reproduces
   `0x00197b56…`.
2. Per nyaro's table above, `v6.0.1` produces `0x0023a66e…`, **not**
   `0x00197b56…`. So the one CLI version the repo does name is demonstrably the
   wrong one. The toolchain that actually built the deployed fixture is some
   other (likely pre-6.0.1 / interim) `cargo-prove` build that was never
   written down.

## What must be captured to close the gap

The deployed fixture was built on a developer Mac on 2026-05-07 with a
`cargo-prove` toolchain whose version was never recorded. To make the deployed
ZK path reproducible, **the person who built `0x00197b56…` must record the
exact toolchain**, specifically:

1. **`cargo-prove --version` full output** of the build that produced
   `0x00197b56…` — including the succinct toolchain / commit suffix, not just
   the marketing `vX.Y.Z`. This is THE missing input.
2. The `sp1up` version / channel that installed that `cargo-prove` (e.g.
   `sp1up -v <tag>`), and the resolved toolchain hash under
   `~/.sp1/toolchains/<hash>`.
3. Host `rustc --version` (the `rust-toolchain` file only says "stable").
4. Ideally, freeze all of the above in a **Dockerfile** committed next to this
   note, so `cargo run --release --bin vkey` inside the image deterministically
   prints `0x00197b56…`. That image becomes the canonical prover for the
   deployed contract.

Once the exact `cargo-prove` version is known, verify it with:

```bash
cd solidity/zk/sig-recovery
cargo run --release --bin vkey    # must print 0x00197b56…8ede30c47…6da94770
```

If a released `cargo-prove` version can be found that reproduces
`0x00197b56…`, pin it in `prove.yml`, add a CI step that runs `--bin vkey` and
asserts the value, and record it here. If **no** released version reproduces
it (a real possibility given the table above), the correct fix is a
**redeploy**: rebuild the circuit with a known, pinned, currently-released
`cargo-prove`, regenerate the fixture + `ZK_PROGRAM_VKEY` in lockstep, and
deploy a fresh `CawActions` with the new immutable vkey. There is no in-place
upgrade path — the vkey is immutable by design.

---

## TODO for the deployer

> **Record the exact `cargo-prove` version (full `--version` output, including
> the succinct toolchain/commit suffix) that produced vkey
> `0x00197b568ede30c47de32e462b8f4b99897351568da36e5aad94cfbf6da94770`, and
> freeze it in a Dockerfile here.** Until this is captured, no operator can
> reproduce the deployed circuit binary, and the real ZK path
> (`processActionsWithZkSigs`) cannot be exercised by anyone building locally.
> If the version is unrecoverable, plan a redeploy with a pinned, released
> toolchain instead.
