# CLI command smoke checks

## output alias preflight

following ahdmesh's review of15008f45, the production non-Windows publisher checks the complete output plan before writing. canonical parent paths detect duplicate destinations even when the target is absent. existing targets must be regular files with one hardlink; repeated file identities, symlink targets, inaccessible metadata and missing/inaccessible parents reject. unsupported targets produce a sanitized preflight error before any configuration write.

109 regression checks pass. the previous publisher passes104 and fails the five new rejection cases. coverage includes a real hardlink pair and real temporary files on Windows, with the non-Windows production branch selected in a VM; symlink and parent-alias cases use IO doubles. this is not native Linux integration. distinct ordinary files still succeed. nine synthetic actual-provider RPC/generation cases also pass; Windows valid-history generation still checks refusal, not successful publication.

observed aliases are unsupported. a path or parent may still change after preflight; this does not prevent concurrent replacement, establish a writer lock, preserve all ACL semantics or recover interrupted writes. in-place publication remains sequential.

## current publication boundary — staged replacement withdrawn

production configuration output no longer imports the experimental staged publisher. on non-Windows platforms, it writes outputs sequentially in place after the existing plan/preflight checks. Windows still refuses before filesystem access. the staged core remains isolated for regression research; earlier staging results below are historical, not the current production path.

103 regression checks and nine loopback RPC cases pass on Windows with Node 24.20.0 under the existing resource limits. three new source/IO-double checks exercise the non-Windows wrapper: in-place output without rename, stop after a write failure, and stop after failed readback. these are not native Linux Node integration. the valid-history Windows generator case verifies refusal with no outputs, not a successful installation.

this withdraws the replacement mechanism demonstrated to lose extended access rules. it does not prove universal permission preservation: chmod can affect a POSIX ACL mask; interrupted writes can leave partial files, and races remain. errors report completed writes and possible partial output without exposing the underlying filesystem error. crash recovery, native Linux integration and complete installation remain open gates.

source: receipt-provenance branch at `a467dfe28e43e8896af329381f128b5e950164db`; Node 24.20.0 on Windows. the CLI files from baseline `97cd13f3` were overlaid with this branch's changed CLI files and receipt-verification modules.

76 dependencies were acquired at the CLI lockfile's exact registry URLs and verified against its integrity fields. no npm lifecycle scripts ran. archives were extracted into their lockfile paths in an isolated directory; this was not an npm-ci installation or bin-link validation. CLI lock SHA-256: `b6788fc18b501245d872fd9165e8103baac299fec9c9ec69ad625a417a00e2a9`.

| command / condition | observed result |
|---|---|
| `node cli/bin/caw.js --help` | exit 0; command list loads |
| `node cli/bin/caw.js --version` | exit 0; 0.1.0 |
| `regen-config --dir <synthetic-missing-scanner> --dry-run` | exit 0; lists missing scanner and DepositWatcher |
| same command without dry-run | exit 1 with verified-history requirement; config unchanged, no backup file created |
| `regen-config --dir <synthetic-existing-scanner>` | exit 0; adds DepositWatcher, creates original-config backup, preserves all original entries and scanner chainId 421614/startBlock 123 |

fixtures use the actual buildServiceList export with either RawEventsGatherer and DepositWatcher omitted, or only DepositWatcher omitted. `.env` contains NETWORK=testnet and NETWORK_ID=1. no wallet keys, RPC endpoints, database or service processes are used. the preserved chain/floor are synthetic operator settings, not validated deployment evidence. compared final JSON and original backup after execution; command exit codes alone were not the acceptance check.

resource guards retained: minimum available memory 768 MiB, disk 2 GiB; each Node process limited to 512 MiB and one process, Node heap capped at 256 MiB. command timeout 30 seconds. no production contract or CLI behavior changed in this evidence update.

this covers module loading and actual regen-config execution with locked dependencies. it does not cover an interactive complete installation, npm lifecycle/bin behavior, doctor database checks, Linux deployment, live RPC receipt acquisition, or frontend/prover builds. those remain separate gates.

## read-only doctor follow-up

with the diagnostic-guidance patch in this revision, `doctor --dir <synthetic-missing-scanner>` exits 1 and requires receipt-verified installation. it no longer recommends `doctor --fix` or prints an unverified scanner configuration template. all fixture file hashes remain identical; no files were added. 76 receipt/installer regression checks and serviceDrift syntax checking pass.

this executes the actual command with the locked dependencies described above. deployment-state and database checks are skipped because their inputs are absent; the CSP status line is not evidence of a complete frontend check. no live node health or complete recovery claim follows from this fixture.

## receipt RPC transport check

run `node solidity/test-deploy/history-rpc-smoke.mjs` after installing the locked CLI dependencies. the fixture uses the actual ethers JsonRpcProvider and history-floor/creation-receipt modules against a loopback HTTP server. six cases pass: matching metadata returns block 12; wrong chain, absent receipt, failed receipt, changed canonical block hash and missing ERC1271 sibling record each reject with the expected error. providers and server are closed afterward.

verified with Node 24.20.0 and the 76 integrity-checked CLI dependencies, under the resource guards above. no function substitution or provider doubles are used; the HTTP responses themselves are synthetic. transaction signatures/hashes are fixture placeholders, not independently authenticated blockchain evidence. this checks RPC serialization/parsing and rejection behavior, not finality, deployed bytecode, full config generation or a complete install. those remain open.

## full generator through loopback RPC — initial observation

the same smoke command now also calls the actual `generateConfig` export with real temporary files and the actual RPC provider. nine total cases pass, including these three additions:

- validator configuration succeeds with synthetic matching history; scanner chain 84532/start block 12, environment chain, generated action address and process configuration agree. both network-selection reads occur.
- absent receipt rejects before configuration, environment, addresses or process files are written.
- changed storage selection on the final read rejects, but configuration, environment and process files have already been written; addresses.ts is absent. this is an observed partial-output gap, not an atomic recovery guarantee. do not start services after the failed install.

fixture directories are newly created and removed by the test; no existing installation is modified. generated random environment values and local paths are not published. real filesystem writes and real provider parsing are covered, but the chain responses remain synthetic. the interactive installer, service startup, Linux permissions, live deployment receipts and runtime recovery remain outside this check. next recovery gate: prevent or safely stage partial outputs, including failure during final file publication.

## selection checks before output writes

the generator now prepares the address output and completes the second storage-selection read before writing configuration, environment or process files. it applies that prepared address output after the environment is generated. this removes the partial-output case caused by a failed/changed network-selection recheck.

76 regression checks and all nine transport/generation cases pass. the transport case starts with existing operator config, environment and process files and confirms all three remain byte-identical when selection changes. running this same assertion against the prior generator at dc27ba2007140349ecefc33288007d3d67925fba fails because it overwrites the operator config. missing-manager, failed-read and unknown-chain regression cases also require zero writes.

this is preflight validation, not a filesystem transaction. disk errors, permission errors, process interruption or later validation failures may still leave partial output. changes on-chain after the last observation remain possible. no atomic recovery or finality claim is made.

## sponsor environment failure propagation

address publication now throws if reading or appending the sponsor environment fails. the same helper serves verified installation and standalone address regeneration, so neither path silently treats this error as success. the message states that installation is incomplete and services must not start; raw filesystem error details are not echoed.

79 regression checks pass, including full-generator append failure and direct address-publication read/append failure. all three new assertions fail against the preceding generator at 94006f1f1566936352f0d432fa47b9bde9f60854. the nine real-provider transport/generation cases still pass. injected filesystem errors exercise propagation; no physical disk failure was induced. earlier files may already have been written. this is not rollback, durable recovery or a barrier against direct external process-manager commands.

## render and validate before publication

full generation now builds every output in memory before writing targets. backend/frontend network identifiers are validated before publication; env files retain readback validation after writes. sponsor settings join the first backend env write, removing the second append step from installation. standalone address regeneration retains its explicit append-failure rejection. process paths remain rooted in the requested installation directory.

81 regression checks pass, including invalid frontend-only network selection and a later compose-rendering failure with zero output writes. the full-generator sponsor test now confirms successful output even when any append would throw, and verifies the sponsor address in the resulting env. nine transport/generation cases pass with actual provider and filesystem; these additionally check sponsor output and process working directory.

this is in-memory preparation only. writes are still sequential: disk errors, chmod/readback errors, interruption and concurrent edits can leave partial output. no journal, rollback, secret backup or crash-recovery mechanism has been implemented.

## stage files before replacement

full generation now passes its output plan to `publishConfigOutputs`. each output is exclusively created beside its destination, written, synced, read back and validated before any target is replaced. target snapshots are checked before the first replacement and again per file. duplicate paths and non-regular target files are rejected. caught failures remove remaining stage files where possible; cleanup failures are reported explicitly.

93 regressions pass: the existing 81 plus 12 real-filesystem helper cases. these cover success; second-file open/write/sync/validation/chmod failures; observed operator edit; partial second-rename failure; duplicate target; a new target during failed staging; a directory target; and cleanup failure. nine actual-provider/generator cases also pass with the real staging helper. run `node --test solidity/test-deploy/config-output.test.mjs` for the helper checks. generator VM tests substitute a simple publisher; they are not themselves filesystem-staging evidence.

publication is still a sequence of renames. one successful replacement followed by a failure is reported as one replaced file, with no rollback claim. no durable journal, automatic restart barrier or concurrent-writer lock exists. snapshot checks do not close the check/rename race or protect changing parent directories. process death can leave stage files. POSIX mode intent is retained; Windows ACL/ownership preservation and platform-specific crash durability have not been established. stages can contain secrets and must remain private; raw test logs and generated environments are not published.

## default creation permissions

new outputs without an explicit mode now use `0666 & ~umask`, matching ordinary file-creation policy rather than forcing `0644`. explicit env modes and existing target modes remain the higher-priority choices. 94 regressions and nine transport/generation checks pass. the new test checks the mode passed to chmod on Windows; it does not establish POSIX enforcement, Windows ACL preservation or ownership preservation.

## observed target identity changes

target snapshots now compare device/inode, owner/group and hard-link count as well as bytes and permission bits. a replacement with identical bytes is therefore rejected when observed before publication.

98 regressions and nine transport/generation cases pass. the added filesystem case replaces a target with another same-byte file and confirms zero publication; three other cases inject changed uid/gid/link-count metadata and confirm rejection. removing the new identity comparisons produces four failures with the other 94 passing. these are local consistency checks, not ownership preservation. owner/group/link-count tests use injected metadata; the same-byte replacement uses actual files.

check/rename races and changing parent directories remain possible. Windows ACLs are not compared; replacement may change ACL/ownership semantics. no lock, rollback or durable recovery has been added.

## merge blocker: protected Windows ACL is not preserved

an isolated Windows fixture at source head 5f0095984785f430a7d9849d4e9c9fcc5a361d03 demonstrates permission loss through the staged replacement path. a synthetic env file was given an explicit current-user access rule with inherited rules disabled. the actual publishConfigOutputs helper then replaced it with synthetic content using mode 0600. command exit was zero and content replacement succeeded.

| observation | before | after |
|---|---|---|
| access rules protected from inheritance | true | false |
| security descriptor equal to original | reference | false |

this establishes a Windows permission-preservation defect. it does not establish which other principals gained access on every installation. local security descriptors and user identifiers are retained privately and are not included here. no real env file, credential or installation was modified.

reproduction outline: create a disposable directory and synthetic file; use Get-Acl/Set-Acl to disable inheritance and set a current-user-only allow rule; record AreAccessRulesProtected and Sddl; call publishConfigOutputs for that file with synthetic content and mode0600; inspect those two properties again. retain the existing test resource guards.

**do not merge the staged-replacement portion as permission-safe or use it on real Windows secret files.** it needs ACL-aware preservation with independent verification, or a supported-platform rejection that fails before mutation. POSIX ownership/extended ACL behavior also remains unverified. this finding narrows the earlier successful smoke results: bytes and rejection behavior passed; permission preservation did not.

## Windows staged publication disabled pending ACL support

production `publishConfigOutputs` now rejects Windows before any snapshot reads, staging or destination writes. there is no CLI override. the staging algorithm is separated into an internal module for focused tests; production generation imports the guarded wrapper. this deliberately makes full configuration generation unavailable on Windows until ACL-preserving replacement is implemented. it does not claim to fix or support Windows ACL replacement.

100 regressions pass. two added checks verify rejection before any filesystem operation and preservation of existing targets. nine transport/generation cases pass, but the valid-history Windows case now expects publication refusal with no output files; it is not successful Windows installation evidence. the internal staging tests still run against synthetic files to exercise algorithm behavior, separately from supported production behavior.

the protected-ACL fixture was rerun with the guarded production function: expected refusal, identical file hash, identical security descriptor and protected inheritance still true. only a synthetic file was used. POSIX ownership/extended ACL preservation, crash recovery, writer exclusion and rollback remain unresolved; non-Windows acceptance is not proof of those properties. standalone address regeneration is outside this staged-publication path and its behavior is unchanged.

## Linux extended-ACL primitive check — not Node integration

a disposable Linux-native synthetic file was assigned an extended access ACL with a named-user entry. a Python check then created a same-directory file exclusively, wrote/synced synthetic content, copied mode bits and replaced the destination. limits:512MiB address space, one process and30CPU seconds; startup memory threshold passed.

mode remained0640; uid and gid were unchanged. `system.posix_acl_access` was present before replacement and absent afterward. this demonstrates that copying mode bits alone does not preserve extended access ACLs for the tested filesystem operation. it is not an execution of publishConfigOutputs, proof about every Linux filesystem, or evidence of changed owner/group. no real configuration was modified.

the actual Node/systemd test could not start: the user bus was absent and the available private manager socket rejected transient service requests. resource limits were not removed to obtain a result. native Node integration remains pending. staging must not be considered permission-safe on POSIX from mode/owner equality alone; extended-ACL handling still needs preservation or a validated fail-before-write restriction.
