# Reproduce the delayed NFT round trip

Runtime candidate **`4bbe9597c99b445b2aaa63b8f3c2da8615de269e`** in [Gilgamesh PR #504](https://github.com/GilgameshCaw/Caw/pull/504). This packet fetches that exact revision even if the PR advances. It runs one Foundry test with the real profile and ledger contracts and a mocked LayerZero transport. No wallet, RPC endpoint, database or funded account is required.

## Run on Linux x86-64

Use Bash, Python 3.10 or newer, curl, tar and sha256sum. The setup fetches public files over HTTPS. Compilation and test execution run offline. From the directory containing this README and `reproduce.py`, run:

```bash
set -euo pipefail
work=$(mktemp -d)
curl --fail --location --retry 2 https://github.com/foundry-rs/foundry/releases/download/v1.5.1/foundry_v1.5.1_linux_amd64.tar.gz |
  tar -xz -C "$work" forge
printf '%s  %s\n' a39fc1913b53dde6a35b603756f65d799e13817ef694107ec0d3704c20435cce "$work/forge" | sha256sum -c -
python3 reproduce.py --forge "$work/forge" "$work/replay"
```

With the matching Forge binary already on PATH, only the last step is needed: `python3 reproduce.py ./replay`. Choose a new output directory on each run. The runner checks the binary, the candidate's Solidity sources and build configuration, the forge-std sources, the npm package integrity values and the Linux solc 0.8.30 binary before starting Forge. It installs no npm packages or lifecycle scripts. The output directory retains the compiler, sources, dependencies, raw Forge JSON and standard error.

To inspect the underlying run again after setup:

```bash
cd "$work/replay"
FOUNDRY_FFI=false RAYON_NUM_THREADS=1 "$work/forge" test --root "$PWD" --use "$PWD/solc-0.8.30" \
  --offline -j 1 --match-path test-foundry/RemoteOwnerRoundTrip.t.sol -vvvv
```

## What counts as a pass

The single suite must report success for `testCoalescedRoundTripInvalidatesBothKindsOfSessionOnce()`. The runner checks the suite name, test name, test count, status and Forge exit code. A zero exit with no matching tests is insufficient.

1. The destination recognizes the original owner and both registered keys.
2. The NFT leaves that owner and returns before the source queue is flushed. Both queued entries name the original owner and carry generation 3 (mint plus two changes).
3. The test delivers the bytes captured from the actual source send. The destination still names the original owner, both prior session expiries read zero, and the wallet session epoch advances exactly once.
4. Fresh keys stay valid across a self-transfer and delayed duplicate deliveries. The wallet epoch stays at one.

The destination can still accept the old sessions before delivery. Public bridging, relayer liveness, gas pricing and migration of immutable contracts need separate evidence.

## Pins for checking the inputs independently

| Input | Revision or SHA-256 |
|---|---|
| [Round-trip test](https://github.com/Xubu-Trad/CawUsernames/blob/4bbe9597c99b445b2aaa63b8f3c2da8615de269e/solidity/test-foundry/RemoteOwnerRoundTrip.t.sol) | `f74f0001948560ddb7dd0481d353a8431d70b1769e3240b9fdab202d02b60ac3` |
| CawProfile.sol | `4ec964adf18e4b9fc65c630aa70ced47c3bd27efb0a0d1330cf7adc2e9a0db17` |
| CawProfileLedger.sol | `0c0c698fc8e62f96da216633e2cfffa4d64f578ef9664061be066d873731c831` |
| solidity/package-lock.json | `2ed4876f494ed4e02703b825fdd84475781fdd974c4374f71cb53d32fd3f1601` |
| forge-std v1.9.7 | `77041d2ce690e692d6e03cc812b57d1ddaa4d505` |
| solc 0.8.30 Linux x86-64 | `f3e987dc6ecebd4bd350c48edcbc320b46cf9e3109bd3fc3d88f1acaf4c428f7` |

For an independent result, report the runtime commit, Forge version, test name, exit status and outcome. If setup or an assertion fails, retain the error and identify the last completed step. The included publisher result is a comparison point. Independent reproduction remains pending until a second operator reports their own run.

## Publisher replay

On November 26, 2026, the public Linux Forge v1.5.1 release binary (commit `b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2`) ran the packet in a new directory with fresh pinned inputs. Forge and the runner both exited 0. The one expected test passed. [Raw Forge result](publisher-forge.json) · [Packet checksums](SHA256SUMS). Timings vary independently of the assertions. This run did not repeat the entire Foundry suite.
