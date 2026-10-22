# network finalization draft

proposal, not an agreed release policy. based on master
`97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`; follows #334.

the [manifesto](https://github.com/cawdevelopment/manifesto) rejects a person or
group with ultimate control capable of crippling the system. the preserved
[R2 reading](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md)
requires no privileged deployer after deployment and peer-reviewed, agreed release.
removing per-network owner powers addresses one part of those requirements.
it does not establish complete compliance.

## concrete proposal

an owner may explicitly call `finalizeNetwork(id)`. the call sets both locks,
clears ownerAddress and emits NetworkFinalized. it makes no external call and adds
no storage slot. networkFinalized returns false for nonexistent IDs. repeat calls,
former-owner changes and attempts to restore an owner reject through existing
owner checks. this remains callable after either or both existing locks: choosing
to end authority is distinct from transferring authority to another address.

policy proposed for review:

- existing sponsor exemptions remain exactly as recorded. the former owner can
  neither add nor revoke them. **a compromised retained sponsor cannot be revoked
  afterward.** review all exemptions before finalization; the mapping is not
  enumerable on-chain. this draft does not establish a safe exemption set.
- gas overrides freeze at existing values. there is no privileged gas-recovery
  mechanism afterward. outstanding messages and future gas changes need liveness
  review; this draft does not prove cross-chain delivery remains possible.
- fee amounts, ceilings, recipient and balances are unchanged. CawProfile's
  existing owner check on withdrawFeesFor sees owner zero, so the former owner's
  delegated trigger loses authorization. direct recipient withdrawal remains a
  separate entitlement. if the former owner is also feeAddress, those recipient
  rights are retained. the full CawProfile withdrawal path was not executed here.
- independent instance owners retain register/update/activate/deactivate rights.
  no protocol-wide freeze, replacement council, proxy or new privileged key.

existing deployed immutable contracts cannot gain this function in place.
no deployment, migration, installer auto-finalization or fee-policy change is
included. nonfinalized networks continue to retain owner authority. this draft
must not be described as removing all authority across the protocol.

## local evidence

solc0.8.30, optimizer200, viaIR, evmVersion prague: zero compiler warnings/errors;
runtime12604 bytes. local Anvil1.8.1, ethers6.16.0 UMD, Node24.20.0.
actual compiled CawNetworkManager tested with synthetic local accounts:

- all four preexisting fee/ownership-lock combinations finalize;
- events, owner zero, both locks and terminal readback checked;
-81 rejection assertions total, covering unauthorized/nonexistent finalization,
 repeat finalization and all19 tested owner entry points across four networks;
- existing sponsor/gas values and all nonowner network fields unchanged;
- controls show existing dual locks still permit sponsor/gas edits before sealing;
- other accounts register/update/deactivate/reactivate instances after sealing.

initial test harness assumed instant receipt availability and failed; bounded
receipt polling corrected the harness. the rerun passed and its local chain was
stopped. no real money or live deployment was used.

reproduce from solidity/ using a verified solc0.8.30 binary:

```sh
python3 test-deploy/network-finalization-input.py > /tmp/network-input.json
solc --standard-json < /tmp/network-input.json > /tmp/network-output.json
anvil --host 127.0.0.1 --port 18672 --chain-id 31337
# in another terminal, with a verified ethers6.16.0 CommonJS/UMD file:
node --max-old-space-size=256 test-deploy/network-finalization-live.cjs /path/to/ethers.umd.cjs /tmp/network-output.json
```

use a fresh local chain. keep at least768MiB available memory and2GiB free disk;
use a45second test timeout and stop Anvil afterward. the local run enforced those
startup/timeout checks plus process limits. the complete repository build and
CawProfile integration are not covered by this standalone contract trial.

before acceptance: decide sponsor and gas policies explicitly; exercise real
fee withdrawal, message delivery, client/indexer handling of the new event and
owner-zero state, and full reproducible builds with independent reviewers.
other deployer/bootstrap, external library, economic, storage and proof-system
gaps remain open. #221 and #276 are separate proposals, not included here.

## withdrawal-method and client follow-up

additional local EVM tests compile the three exact withdrawal methods extracted
from pinned master CawProfile, checked by SHA256
`895587b2b3c5e82b46da892ca1c50fdb489510e7089c5f6467246ccd4675a698`.
the surrounding storage/funding fixture and swap recorder are synthetic; the
candidate network manager is deployed as compiled. this is not the full profile,
a real swap, real fee accrual or an end-to-end withdrawal test.

observed: existing dual locks allow delegated withdrawal before finalization;
former-owner and stranger delegated calls reject afterward. the recipient can
still withdraw directly, including when recipient and former owner are the same
account. partial protocol matching and a surplus pool were checked. a real failed
local transaction to the rejecting swap fixture left fee balances unchanged;
retry succeeded after the rejection was removed.

from solidity/, supply the exact pinned CawProfile source as an input file:

```sh
python3 test-deploy/network-withdrawal-input.py /path/to/pinned/CawProfile.sol > /tmp/withdrawal-input.json
solc --standard-json < /tmp/withdrawal-input.json > /tmp/withdrawal-output.json
# fresh local Anvil on port18672, chain31337, as above
node --max-old-space-size=256 test-deploy/network-withdrawal-live.cjs /path/to/ethers.umd.cjs /tmp/withdrawal-output.json
node --max-old-space-size=256 --test test-deploy/network-sync-finalization.test.cjs
```

the client previously treated owner zero as nonexistent in syncNetwork. it now
requires a matching, nonzero network ID instead. five extracted-function checks
pass: baseline omission reproduced, finalized and ordinary networks sync,
nonexistent/mismatched IDs reject, and RPC failure writes nothing. RPC/database
boundaries are mocked; no full client typecheck, real database or event-driven
refresh is established. new finalization-event handling elsewhere still needs
review. the contract candidate itself is unchanged by this follow-up.

## finalization event refresh

ChainSyncService now queries NetworkFinalized alongside its existing L1 events.
the event triggers syncNetwork to refresh authoritative current network state,
including the zero owner. a rejected RPC query, missing/invalid network ID or
failed network read/write leaves the range checkpoint unchanged for retry. older
contracts with no such events continue through the empty-query path. the new
filter is a minimal local ABI addition; no generated artifact change is needed.

six focused tests use actual ethers6 event-topic construction and ABI decoding,
with mocked RPC/storage and extracted event-loop source. positive refresh,
refresh failure, query failure, missing args, invalid ID and no-event cases pass.
run with Node24 and ethers6.16.0 installed, or set CAW_ETHERS_PACKAGE to its verified
CommonJS/UMD path:

```sh
node --max-old-space-size=256 --test test-deploy/network-finalization-event.test.cjs
```

this uses the existing five-minute event poll when configured, not an instant
notification or historical state snapshot. the 30-minute full network sync remains
as reconciliation. full client startup, actual RPC/database integration, event
backfill beyond the existing lookback, chain-bound cursors and reorg recovery are
still outside this result. other preexisting fee handlers have different failure
semantics; this patch does not silently claim to repair all indexing behavior.
