# derived key acceptance

from this directory, run `node check-vkey.mjs` with the intended Rust/SP1 build environment installed. it runs `cargo run --locked --release --bin vkey` and requires the successful command's complete stdout to equal the checked-in fixture's bytes32 key. missing tools, failed builds, malformed output and mismatches fail. the command compiles code and may acquire dependencies; it is an explicit local build step, not an automatic installer.

the checker does not select or recover the original guest compiler. it does not alter the expected key. a match with the fixture does not prove the fixture matches a selected deployed contract, generate a proof, establish public-input semantics or demonstrate independent reproducibility. record those checks separately, including source, compiler identities, ELF hash, derived key and chain/contract identity.

the vendored `.github/workflows/prove.yml` is nested inside this prover project. at base `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`, it is not a repository-root GitHub Actions workflow. its presence does not establish a CI run. moving it alone leaves project-root assumptions, runner availability and mutable installer inputs unresolved. this patch does not activate that workflow or prescribe an unverified compiler version.

run the dependency-free wrapper regressions with `node --test check-vkey.test.mjs`. these mock the build command; they test rejection and invocation behavior, not Rust compilation or cryptographic acceptance. build stderr is not included in wrapper errors; run the displayed cargo command directly for compiler diagnostics.

## known reproduction mismatch

The upstream [VKEY_REPRODUCIBILITY.md](VKEY_REPRODUCIBILITY.md) records a fixture key beginning `0x00197b56`, while the tried SP1 6.0.1, 6.1.0 and 6.2.0 builds produced `0x0023a66e`; 6.3.1 produced `0x00ef1dd0`. These are reported upstream results, not new independent builds performed for this patch. Consult that report for the full context.

A mismatch from `node check-vkey.mjs` under those recorded build conditions is an expected rejection, not a reason to replace the fixture or bypass the checker. The original toolchain/ELF provenance and deployed-key relationship still need verification. The passing wrapper tests do not resolve this mismatch.
