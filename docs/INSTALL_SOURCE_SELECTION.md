# Reviewed source selection during installation

The installer normally follows a moving branch. Setting `CAW_EXPECT_COMMIT` to an independently reviewed full 40-character commit SHA makes source selection fail closed when the fetched branch tip differs. Uppercase hexadecimal is normalized. Abbreviations, branch names and tags are not accepted as the expected digest.

Obtain and inspect the installer itself through a separately trusted, pinned source. Pass the reviewed digest in the environment that runs that local installer, for example `sudo env CAW_EXPECT_COMMIT="$reviewed_commit" bash ./install.sh`. This is an equality check, not a claim that any particular commit is safe or community-approved. Do not automatically derive the expected value from the same mutable branch immediately before installing: that defeats independent selection.

On an existing checkout, the installer verifies the just-fetched FETCH_HEAD before a hard reset. A mismatch leaves existing tracked edits and HEAD intact; fetching still changes Git metadata. On a fresh install, a no-checkout clone is verified before files are checked out. A mismatch leaves a Git directory for inspection. An unavailable branch also aborts. A valid selection still permits the installer's existing hard reset; it is not protection for local modifications. PR #237 separately proposes preserving edits and local commits and should be reconciled before combining the two changes.

The option refuses unexpected source; it does not fetch an arbitrary historical commit when the branch has moved. Select a branch that actually points to the reviewed commit, or stop and review a new candidate. Never replace the expected digest merely to make a failed check green.

## Reproduction

Run on Linux with Bash, Git and Python 3 (standard library):

```sh
python3 -B scripts/test-install-source-pin.py
```

The original seven local fixture scenarios cover accepted fresh selection, moved-branch refusal before overwriting local edits, fresh mismatch without checkout, accepted existing update, invalid digest, missing branch and unchanged unpinned fresh installation. The test extracts the actual selection block from install.sh, replaces only sudo/log/error wrappers, and uses disposable local Git repositories. It does not run system bootstrap, install services or build the app. User/system Git configuration is excluded for fixture reproducibility.

Negative control:

```sh
python3 -B scripts/test-install-source-pin.py --negative-control
```

This disables the equality check only in the extracted test copy. It must exit nonzero when the moved branch is wrongly accepted. Do not use Python -O: assertions are the regression oracle.

## Boundaries

The check runs at repository acquisition, after the installer's earlier host setup. It does not authenticate the installer, prevent those earlier side effects, verify dependency downloads, lock compiler/runtime versions, cover later CLI updates, protect against a concurrently malicious local user, establish reproducible builds or change deployed contract authority. Unset CAW_EXPECT_COMMIT retains legacy behavior. This is one opt-in operator control within the larger independent-release/recovery problem, not proof that the installation is decentralized or safe.

R2's requirement that the deployer not remain indispensable motivates independently reviewable source selection; the exact mechanism here is an engineering proposal, not a literal instruction in the recovered text. The official manifesto and reproduced R2 remain separate from implementation acceptance.


## Replacement-object regression (R-01 follow-up)

With `CAW_EXPECT_COMMIT` set, acquisition, commit verification and reset now use Git's [`--no-replace-objects`](https://git-scm.com/docs/git#Documentation/git.txt---no-replace-objects) option. Existing replacement references are ignored for these commands, not deleted. This avoids the reported case where expected commit B passed the ID comparison but a local B-to-A replacement populated A's tree. Without a pin, legacy replacement behavior is unchanged.

Four additional cases bring the suite to eleven: commit B-to-A replacement, file-object replacement, a custom `GIT_REPLACE_REF_BASE` namespace, and unpinned legacy compatibility. Each pinned case checks materialized file content and preservation of replacement refs. The new test must fail on the previous installer at the B-to-A content assertion. A separate mutation removes the new Git option only from the extracted test copy:

```sh
python3 -B scripts/test-install-source-pin.py --replacement-negative-control
```

It must exit nonzero at the replacement-content assertion. The original `--negative-control` still checks moved-branch refusal. These are disposable Git fixtures, not tests of actual sudo, OS setup, dependency builds or running nodes.

This closes a specific replacement-object lookup boundary, not all ways local Git configuration can affect materialized files. Checkout filters, line-ending conversions, hooks, local executable/configuration trust and concurrent tampering are outside this test. Do not describe a matching commit as a byte-for-byte verified build. The full installer and combination with #237 remain untested by these cases.

### Recorded local verification, 2026-11-05 UTC

The extended assertions failed on the unchanged `aa2f7994` installer at `selected B but materialized replacement A`. The patched installer passed `bash -n` and all eleven fixture scenarios. Both controls exited nonzero as intended: disabled commit comparison failed the moved-branch assertion; disabled replacement protection failed the B-to-A content assertion. This independently reproduces the narrow R-01 finding; it does not revalidate the reviewer's entire 30-group evidence packet. Full installer, real sudo/OS provisioning, #237 integration and concurrent tampering were not run.
