# Foundry fuzz / invariant tests

This directory holds **Foundry**-based property tests that complement the
existing Truffle test suite. Foundry is added alongside Truffle, not in place
of it: the JS tests still own integration scenarios (LayerZero relay, multi-
tx flows, etc.); the tests here own fast property-based exploration of pure
or near-pure logic.

## Why fuzz here?

Several CAW invariants are hard to lock in with hand-written examples:

- **CawActions** consumes user-controlled packed bytes (`packedActions`,
  `packedSigs`) — the action-shape gate at the top of `_distributeAmountsMem`
  has to reject every malformed combination of `actionType`, `numRecipients`,
  and `numAmounts`. The recent audit fix (H-2, 2026-05-08) added an extra
  rejection for `WITHDRAW + numRecipients=0 + numAmounts=1`; we want a test
  that explodes if that gate ever moves.
- **Cawonce bitmap** uses bit packing across `>> 8` and `& 0xff`. A swapped
  shift would let two different `cawonce` values land on the same slot —
  silent and catastrophic.
- **Marketplace** holds escrowed ETH from English-auction bids and from
  pending offers. Push refunds may fall through to `pendingReturns`. The
  mental model is "marketplace ETH balance = open bid + sum of
  pendingReturns"; that needs a stateful check.

## Layout

```
test-foundry/
├── README.md                           ← you are here
├── MarketplaceFuzz.t.sol               ← bid/offer escrow, anti-snipe, cancellation
├── CawonceInvariant.t.sol              ← stateful invariant: no double-mark
├── DistributeShapeFuzz.t.sol           ← shape gate at top of _distributeAmountsMem
├── SessionRegisterFuzz.t.sol           ← EIP-712 registerSession path
├── harness/
│   ├── CawonceHarness.sol              ← stand-alone copy of CawActions.useCawonce
│   └── DistributeShapeHarness.sol      ← stand-alone copy of the shape gate
└── mocks/
    └── MockCawProfile.sol              ← minimal ERC721 + transferAndSync stub
```

## Running

```bash
# from solidity/
forge build                               # compile contracts + tests
forge test --fuzz-runs 1000               # run everything (tests cap at 1000)
forge test --match-test testFuzz_OfferCancel    # one test by name
forge test --match-contract Marketplace   # one test contract
forge test -vvvv --match-test testFuzz_AntiSnipe   # verbose: show reverts
forge coverage --report summary           # coverage (slow, IR-compiled)
```

## Tests

### `MarketplaceFuzz.t.sol`
End-to-end fuzz against a real `CawProfileMarketplace` deployed against a
minimal ERC721 mock (`MockCawProfile`). Bidders are EOAs so push-refund
(`call{gas:2300}`) succeeds; a contract-bidder variant would exercise the
`pendingReturns` fallback path and is left as a follow-up. Properties:

- `testFuzz_OfferCancelRefundsFully` — `cancelOffer` returns 100% of escrowed ETH.
- `testFuzz_AntiSnipe` — bids in the last 10 minutes always extend the
  deadline by `ANTI_SNIPE_DURATION`.
- `testFuzz_CancelEnglishWithBidPreservesFunds` — cancelling an English
  auction with a live high bidder credits their bid to `pendingReturns` and
  is recoverable via `withdrawBid`.
- `testFuzz_BidSequenceEscrowConserved` — the escrow-conservation invariant
  across a 3-bid sequence: `mkt.balance == openBid + Σ pendingReturns`.
- `testFuzz_NoDoubleListing` — `listingByTokenId` is authoritative; second
  list of an active token reverts.

### `CawonceInvariant.t.sol`
Stateful invariant test using `forge-std`'s `targetContract` / `FuzzSelector`.
A `CawonceHandler` calls `useCawonce(senderId, cawonce)` with random inputs
and tracks every successful mark in a parallel bookkeeping mapping. Two
invariants close the loop:

- `invariant_AllMarkedSlotsAreUsed` — every successful mark survives.
- `invariant_NoSpuriousMarks` — no slot reads as used unless the handler
  successfully marked it.

The harness mirrors `CawActions.useCawonce` verbatim; if the production
function changes, this needs to change in lockstep.

### `DistributeShapeFuzz.t.sol`
Pure-function fuzz of the documented shape-gate at the top of
`_distributeAmountsMem`. Three properties cover the whole input space:

- `numRecipients > 10` always rejected.
- `numAmounts ∉ {numRecipients, numRecipients + 1}` always mismatched.
- `WITHDRAW + numRecipients=0 + numAmounts=1` is the *only* extra rejection
  beyond the above. Every other shape that survives the first two gates
  passes (this is the partition test that pins the audit fix in place).

### `SessionRegisterFuzz.t.sol`
EIP-712 `registerSession` path on `CawProfileL2`. Fuzzes the signed-payload
fields and verifies:

- expired sessions reject (`Already expired`)
- replay of the same signature after a successful register reverts via the
  monotonic `sessionNonce` bump
- WITHDRAW (bit 0x40) is unconditionally non-delegatable
- zero session-key is rejected
- tampering with any signed field fails to land a session on the original
  signer's slot

## Known limitations

- **No LayerZero messaging.** `CawProfileL2` is OApp-based; we deploy with
  the existing `MockLayerZeroEndpoint` (vendored from
  `@layerzerolabs/test-devtools-evm-hardhat`) but never *send* an LZ
  message. Cross-chain flows (deposits, withdraws, transferAndSync) are
  unit-tested in the Truffle suite and not duplicated here.
- **No full-stack `CawActions` fuzz.** `processActions` requires a deployed
  `CawProfileL2 + LZ endpoint + funded NFT owner` graph and signed,
  packed calldata — too heavy for a pure-property test. We instead use the
  shape harness above. A full-stack fuzz that crafts random valid
  `(packedActions, packedSigs)` pairs is a worthwhile follow-up.
- **No `pendingReturns` contract-bidder coverage.** The current tests use
  EOA bidders so push-refund always succeeds. A `RevertingBidder` variant
  (already used in the Truffle suite) wired into a Foundry handler would
  cover the fallback path.

## Adding a new fuzz test

1. Create `Foo.t.sol` in this directory.
2. `import "forge-std/Test.sol";` and inherit `Test`.
3. Prefix property tests with `testFuzz_` (statefulless) or
   `invariant_` (stateful, paired with a handler contract).
4. Use `bound()` for ranged inputs; `vm.assume()` only for cheap rejections
   (Foundry will discard the run).
5. Run `forge test --match-contract Foo` and tune until it's both fast and
   meaningful.
