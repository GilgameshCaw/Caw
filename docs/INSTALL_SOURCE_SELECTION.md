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

Seven local fixture scenarios cover accepted fresh selection, moved-branch refusal before overwriting local edits, fresh mismatch without checkout, accepted existing update, invalid digest, missing branch and unchanged unpinned fresh installation. The test extracts the actual selection block from install.sh, replaces only sudo/log/error wrappers, and uses disposable local Git repositories. It does not run system bootstrap, install services or build the app. User/system Git configuration is excluded for fixture reproducibility.

Negative control:

```sh
python3 -B scripts/test-install-source-pin.py --negative-control
```

This disables the equality check only in the extracted test copy. It must exit nonzero when the moved branch is wrongly accepted. Do not use Python -O: assertions are the regression oracle.

## Boundaries

The check runs at repository acquisition, after the installer's earlier host setup. It does not authenticate the installer, prevent those earlier side effects, verify dependency downloads, lock compiler/runtime versions, cover later CLI updates, protect against a concurrently malicious local user, establish reproducible builds or change deployed contract authority. Unset CAW_EXPECT_COMMIT retains legacy behavior. This is one opt-in operator control within the larger independent-release/recovery problem, not proof that the installation is decentralized or safe.

R2's requirement that the deployer not remain indispensable motivates independently reviewable source selection; the exact mechanism here is an engineering proposal, not a literal instruction in the recovered text. The official manifesto and reproduced R2 remain separate from implementation acceptance.
