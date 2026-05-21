# V1→V2 Contract Change Catalog

V1 baseline: `.deploy-state.v1-pre-uruk.json` (deployed ~2026-04-28, commit `1d54dbcd^`).
V2 baseline: `.deploy-state.json` (deployed 2026-05-22, HEAD `982cfe28`).

Pre-deploy audit passes: 7 (see `docs/AUDIT_TRAIL.md` for full timeline).

---

## NEW contracts

### SmartEOA.sol
**Status: NEW** (deployed at `0x710041dE1109Ca2077D3580b92bbD20971fc35dc` on L1)

EIP-7702 delegate implementation for Population B (phone-first) users. Deployed once;
users' EOAs point at it via a type-0x04 authorization. Storage is per-EOA.

**Public surface:**
```solidity
// Initialization (one-shot, called in same type-0x04 tx)
function initialize(
    bytes32 pubkeyX,
    bytes32 pubkeyY,
    address ecdsaFallbackAddr,
    address payable minterContract,
    bytes calldata mintCalldata
) external payable

// Passkey management
function addPasskey(bytes32 newPubkeyX, bytes32 newPubkeyY, bytes calldata callerSig) external
function removePasskey(bytes32 targetPubkeyHash, bytes calldata callerSig) external
function cancelPendingPasskey(bytes32 targetPubkeyHash, bytes calldata callerSig) external
function rotateEcdsaFallback(address newFallback, bytes calldata callerSig) external

// Nonce management (ISmartEOA)
function nonceOf(address verifyingContract, uint8 actionType) external view returns (uint256)
function managementNonceOf() external view returns (uint256)
function consumeNonce(address verifyingContract, uint8 actionType) external

// ERC-1271
function isValidSignature(bytes32 digest, bytes calldata sig) external view returns (bytes4)

// ETH receive
receive() external payable
```

**Events:**
```
Initialized(address indexed account)
PasskeyAdded(bytes32 indexed pubkeyHash, uint64 validFrom)
PasskeyActivated(bytes32 indexed pubkeyHash)
PasskeyRemoved(bytes32 indexed pubkeyHash)
PasskeyCancelled(bytes32 indexed pubkeyHash)
EcdsaFallbackRotated(address indexed newFallback)
```

**Key behaviors:**
- P-256 passkeys verified via EIP-7951 precompile at `0x0100` (live Ethereum mainnet since Fusaka, Dec 2025).
- New passkeys enter a 24-hour timelock (`PASSKEY_TIMELOCK = 86400s`) before becoming active.
- `consumeNonce` gated to `msg.sender == verifyingContract` — prevents nonce griefing.
- WebAuthn sig blob format: `abi.encode(authenticatorData, clientDataJSON, r, s)`.

---

### ISmartEOA.sol
**Status: NEW** (interface only, no deployed address)

Minimal interface for sponsor entry-point nonce management. Exposes `nonceOf` and
`consumeNonce`. Required by `CawProfileMinter._checkPermit`. Wallets that do not
implement this interface cannot use the sponsored entry points.

---

### CawNetworkManager.sol
**Status: NEW** (replaces `CawClientManager.sol`; deployed at `0x7eE68c573824597FeDd4df38FA30E2D397ec3C07` on L1)

Renamed from `CawClientManager` + extended. "Client" → "Network" everywhere in the
protocol vocabulary.

**Struct changes:**
```
// V1 CawClient (CawClientManager)
struct CawClient {
  uint32 id; uint32 storageChainEid; string name;
  address feeAddress; address ownerAddress;
  uint256 withdrawFee; uint256 depositFee;
  uint256 mintFee; uint256 authFee; uint256 creationBlock;
  // NO per-fee ceilings
}

// V2 CawNetwork (CawNetworkManager)
struct CawNetwork {
  uint32 id; uint32 storageChainEid; string name;
  address feeAddress; address ownerAddress;
  uint256 withdrawFee; uint256 depositFee;
  uint256 mintFee; uint256 authFee; uint256 creationBlock;
  uint256 withdrawFeeCeiling;   // NEW
  uint256 depositFeeCeiling;    // NEW
  uint256 authFeeCeiling;       // NEW
  uint256 mintFeeCeiling;       // NEW
}
```

**Function renames:**
```
V1                                          V2
createClient(name, feeAddr, eid, wF, dF, aF, mF)  →  createNetwork(name, feeAddr, eid, wFC, dFC, aFC, mFC)
getClient(id)                               →  getNetwork(id)
getClientOwner(id)                          →  getNetworkOwner(id)
ClientCreated event                         →  NetworkCreated event (payload includes 4 ceilings)
```

**New functions (no V1 equivalent):**
```solidity
// Per-fee ceiling management (ceiling-only, can only lower)
function lowerWithdrawFeeCeiling(uint32 networkId, uint256 newCeiling) external
function lowerDepositFeeCeiling(uint32 networkId, uint256 newCeiling) external
function lowerAuthFeeCeiling(uint32 networkId, uint256 newCeiling) external
function lowerMintFeeCeiling(uint32 networkId, uint256 newCeiling) external

// Ceiling getters
function getWithdrawFeeCeiling(uint32 networkId) external view returns (uint256)
function getDepositFeeCeiling(uint32 networkId) external view returns (uint256)
function getAuthFeeCeiling(uint32 networkId) external view returns (uint256)
function getMintFeeCeiling(uint32 networkId) external view returns (uint256)

// Lockdown
function lockNetworkFees(uint32 networkId) external
function lockNetworkOwnership(uint32 networkId) external

// Gas override for LZ messages (ratcheting, capped at MAX_GAS_OVERRIDE=100_000)
function setGasOverride(uint32 networkId, bytes4 selector, uint128 newAmount) external
function gasOverride(uint32 networkId, bytes4 selector) external view returns (uint128)

// Batch fee setter
function setFees(uint32 networkId, uint256 wF, uint256 dF, uint256 aF, uint256 mF) external
```

**Access control changes:**
- V1 fee setters had NO ceiling guards (owner could set any value).
- V2 fee setters enforce `fee <= ceiling`; `onlyNetworkOwnerNotFeeLocked` modifier.
- V1 `changeOwner` had no lock; V2 has `onlyNetworkOwnerNotOwnershipLocked`.

**New events:**
```
NetworkFeesLocked(uint32 indexed networkId)
NetworkOwnershipLocked(uint32 indexed networkId)
NetworkGasOverrideSet(uint32 indexed networkId, bytes4 indexed selector, uint128 newAmount)
NetworkFeeUpdated(uint32 indexed networkId, string feeType, uint256 newFee)
WithdrawFeeCeilingLowered(uint32 indexed networkId, uint256 oldCeiling, uint256 newCeiling)
DepositFeeCeilingLowered(...)
AuthFeeCeilingLowered(...)
MintFeeCeilingLowered(...)
```

Note: V1 had NO `NetworkFeeUpdated` event — fee changes were silent on-chain.

---

### CawCapOracle.sol
**Status: NEW** (deployed at `0x65b15DA074Bc59CF04ad344e0dCeeC047CA0200E` on L2, `0xB583b820f5b43a27FAB93e8CeC75467e161FC25a` on L2b)

7-day TWAP oracle for ETH-denominated per-action cost ceilings. Piggybacked on every
L1→L2 LZ message via `CawProfileL2._lzReceive` → `recordSample`. Pushes ratio to
`CawActions.setCapRatio` when cap state changes (zero external calls per action).

**Constructor:** `(address _l2Writer, address _cawActions)`

**Key constants:**
```
TWAP_WINDOW = 7 days
STALE_THRESHOLD = 24 hours
MIN_WINDOW = 1 day
BUFFER_SIZE = 1024

// Per-action ETH ceilings (wei):
CAP_LIKE = 2e11, CAP_RECAW = 4e11, CAP_CAW = 5e11, CAP_FOLLOW = 30e11, CAP_UNLIKE_UNFOLLOW = 1e11

// Baselines (whole CAW):
BASELINE_LIKE = 2000, BASELINE_RECAW = 4000, BASELINE_CAW = 5000, BASELINE_FOLLOW = 30000, BASELINE_UNLIKE_UNFOLLOW = 1000
```

**Public functions:**
```solidity
function recordSample(uint256 cumulative, uint32 timestamp) external   // l2Writer only
function pushRatioIfStale() external                                     // permissionless, 5-min rate limit
function twapEthPerCaw() public view returns (uint256 twap, bool fresh)
function capForAction(uint256 baseline, uint256 ethCap) public view returns (uint256)
// Convenience getters:
function capLike/capRecaw/capCaw/capFollow/capUnlikeUnfollow() external view returns (uint256)
```

**Events:** `SampleRecorded(uint64 indexed index, uint256 cumulative, uint32 timestamp)`

---

### CawL1PriceReader.sol
**Status: NEW** (deployed at `0x6ac67daa95C8eb7635a67d533601aF3B94dF0abf` on L1 — pending pool creation; currently skipped if `CAW_WETH_PAIR` env not set)

Reads Uniswap V2 `priceCumulativeLast` for CAW/WETH, advancing the cumulative to the
current block if the pair hasn't been touched this block. Immutable pair address.

**Constructor:** `(IUniswapV2Pair _pair, address _cawToken)`

**Public functions:**
```solidity
function readSample() external view returns (uint256 cumulative, uint32 timestamp)
```

`CawProfile._sendL1ToL2Message` piggybacks `readSample()` output as a 36-byte prefix on
every L1→L2 payload so no separate oracle tx is needed.

---

### CawActionsERC1271.sol
**Status: NEW** (deployed at `0xA6d7cB1001f1D303762529B4e55c279d998acEDa` on L2, `0xb3f4C111D4424cf9D0c2DC4bda44124adB59c767` on L2b, `0x6b0e5c11d8e97Af59E03b08d631c1BA7DD4fDF1e` on L1)

Handles variable-length ERC-1271 signatures (passkey / SmartEOA owners) for
`CawActions`. Verified externally, then calls `CawActions.processGroupSingle` with
`preVerifiedSigner` set, skipping on-chain ecrecover.

**Constructor:** `(address _cawActions)`

**Entry point:**
```solidity
function processActionsERC1271(
    uint32 validatorId,
    bytes calldata packedActions,
    bytes[] calldata sigs,
    bytes32[] calldata rs,
    uint256 withdrawFee,
    uint256 withdrawLzTokenAmount
) external payable
```

**Events:** `ActionsProcessed(uint32 indexed networkId, uint32 indexed validatorId, uint16 actionCount, bytes32 batchHash)`

**Key point:** Each `sigs[g]` is a raw ERC-1271 blob (65-byte secp256k1 or WebAuthn).
`rs[g] = keccak256(sigs[g])` is the hash-chain anchor committed to the source chain.

---

### SigVerification.sol
**Status: NEW** (library; no deployed address — linked into CawProfileL2)

Extracted from CawProfileL2 to stay under EIP-170. Provides `recoverOrValidate(address
signer, bytes32 digest, bytes calldata sig)` with ERC-1271 fallback (50k gas cap).

---

## MODIFIED contracts

### CawActions.sol
**Status: MODIFIED** (new address: `0xB305E9014f8058AdDE0faD8A53eb895B50564bEB` L2, `0x618B3b69aB54Ed8624A03F92C2a8c9c58421dA47` L2b, `0x0b498D4402E8F5bCDD7da7e245B537588263f5Bb` L1)

**Constructor changed:**
```solidity
// V1 constructor (4 params):
constructor(address _cawProfiles, address _zkVerifier, bytes32 _zkProgramVKey, address _erc1271Sibling)

// V2 constructor (5 params):
constructor(address _cawProfiles, address _zkVerifier, bytes32 _zkProgramVKey, address _erc1271Sibling, address _capOracle)
```

**New storage:**
```solidity
struct CapState {
    uint64  lastUpdatedAt;
    uint192 ratio;         // 0 = dormant; UQ112.112 ethPerCaw TWAP otherwise
}
CapState public capState;                                    // NEW
ICawCapOracle public immutable capOracle;                    // NEW
```

**New functions:**
```solidity
function setCapRatio(uint192 newRatio) external              // capOracle only
function capStateRatio() external view returns (uint192)     // read-only for oracle

// ERC-1271 sibling bridge (replaces old inline sibling check pattern):
function processGroupSingle(
    uint32 validatorId,
    bytes calldata groupBytes,
    uint8 v, bytes32 r, bytes32 s,
    uint16 groupSize,
    address preVerifiedSigner
) external
```

**New events:**
```
CapRatioUpdated(uint192 ratio, uint64 timestamp)
ActionsProcessedZk(uint32 indexed networkId, uint32 indexed validatorId,
    uint16 actionCount, uint256 actionsExecutedBitmap, bytes32 batchHash)
```

**New error codes:**
```
WrongProfileForSession   // token-scoped session used for wrong tokenId
NotCapOracle             // setCapRatio caller is not capOracle
```

**Behavioral changes:**
- All action costs are now subject to `_getCost(baseline, ethCap)` which applies the
  oracle-pushed cap when `capState.ratio != 0` and `lastUpdatedAt` is within 24h.
- Token-scoped sessions: `WrongProfileForSession` revert if `session.profileId != 0`
  and `session.profileId != action.senderId`.
- Session spend limit check: `sessionSpent[owner][key] + cost > spendLimit` reverts.
  V1 had no `spendLimit` enforcement in CawActions (it checked sessionSpent but did not
  enforce a configurable cap — that cap came from `MAX_SESSION_SPEND` added in Round 2).
- ZK path (`processActionsWithZkSigs`): unchanged entry point; now also calls
  `_requireValidatorExists` and `cawProfile.addTokensToBalance` for implicit tips.

---

### CawProfileMinter.sol
**Status: MODIFIED** (new address: `0xDa124Dba089839e979347117d76004Be7feBD74B`)

**New constructor param:**
```solidity
// V1: constructor(address _caw, address _cawProfiles, address _router)
// V2: same signature — unchanged
```

**New imports/state:**
```solidity
import "./interfaces/ISmartEOA.sol";                 // NEW
bytes32 public immutable DOMAIN_SEPARATOR;           // NEW — EIP-712 domain at deploy
```

**Three new sponsored entry points (entirely new in V2):**
```solidity
function mintAndDepositSponsored(
    uint32 networkId, address recipient, string memory username,
    uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount,
    uint256 permitNonce, bytes calldata sig
) external payable

function depositForSponsored(
    uint32 networkId, uint32 tokenId, uint256 amount,
    uint32 lzDestId, uint256 lzTokenAmount,
    uint256 permitNonce, bytes calldata sig
) external payable

function authenticateSponsored(
    uint32 networkId, uint32 tokenId,
    uint32 lzDestId, uint256 lzTokenAmount,
    uint256 permitNonce, bytes calldata sig
) external payable
```

**Internal helper:**
```solidity
function _checkPermit(address signer, uint8 actionType, uint256 permitNonce,
    bytes32 digest, bytes calldata sig) internal
```

**EIP-712 type hashes (new constants):**
```
MINT_DEPOSIT_TYPEHASH  = keccak256("MintAndDeposit(uint32 networkId,address recipient,string username,uint256 depositAmount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce)")
DEPOSIT_FOR_TYPEHASH   = keccak256("DepositFor(uint32 networkId,uint32 tokenId,uint256 amount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce)")
AUTHENTICATE_TYPEHASH  = keccak256("Authenticate(uint32 networkId,uint32 tokenId,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce)")
```

**receive() added:** Accepts ETH refunds from `CawProfile._refundUnusedLzEth` (H-1 fix).

**Behavioral requirements for sponsored callers:**
- `recipient.code.length > 0` required — plain EOAs must submit directly.
- Signer must implement both ERC-1271 `isValidSignature` and `ISmartEOA.{nonceOf,consumeNonce}`.
- Sponsor server (msg.sender) must pre-approve Minter for CAW before calling
  `depositForSponsored` and `mintAndDepositSponsored`.

---

### CawProfile.sol
**Status: MODIFIED** (new address: `0xFb45Cae2073eA04E3cF31A2D6E55F03737bCA327`)

**Constructor changed:**
```solidity
// V1: constructor(address _caw, address _gui, address _buyAndBurn,
//                 address _networkManager, address _endpoint, uint32 mainnetEid)
// V2: constructor(address _caw, address _gui, address _buyAndBurn,
//                 address _networkManager, address _endpoint, uint32 mainnetEid,
//                 address _priceReader)    ← new param
```

**New state:**
```solidity
CawL1PriceReader public immutable priceReader;   // NEW — may be address(0)
```

**New function:**
```solidity
// Minter-only sponsored authenticate (H-1 from Pass 6)
function authenticateForMinter(
    uint32 cawNetworkId, uint32 tokenId, uint32 lzDestId,
    address owner, uint256 lzTokenAmount
) external payable
```

**`setMinter` hardened to `onlyOnce`** (was plain `onlyOwner` in V1).

**`setUriGenerator` hardened to `onlyOnce`**.

**`setPeer` overridden to `onlyOnce` per eid** (new in V2 — prevents peer swap attacks).

**LZ payload format changed:** Every L1→L2 message now prepends a 36-byte price prefix
(`cumulative:uint256` + `timestamp:uint32`) before the 4-byte selector. L2 strips it in
`_lzReceive`. All payload parsing on the L2 side must account for the 40-byte header
(36 prefix + 4 selector) instead of the previous 4-byte selector-only header.

**Per-fee ceiling checks:** `CawProfile.payFee` now calls per-fee getters
(`getDepositFeeAndAddress`, `getAuthFeeAndAddress`) separately — was `getFeeAndAddress`
(single combined call) in V1. Audit fix 2026-05-17 H-1.

**Custom errors** replacing require-strings (EIP-170 size optimization on solc 0.8.30):
`ZeroAddr, NotMinter, NotOwner, RefundFailed, NotNetOwner, NoFees, ZeroDeposit,
NothingToWithdraw, NoPending, Unauthorized, DelegateFailed, NotApproved, NotL2Mirror,
TooManyChains`

**New storage (per-fee lock):**
```solidity
mapping(uint32 => mapping(uint32 => uint256)) public lockedWithdrawFee;
mapping(uint32 => mapping(uint32 => bool))    public withdrawFeeLocked;
```

**New event:** None beyond the existing set; `MinterSet` still emitted.

---

### CawProfileL2.sol
**Status: MODIFIED** (new address: `0x866bD663cadf2a5bA23Fab2049732F4067301DfA` L2, `0x6f310D30bd954D24b83d3233C8529dBdC9B6C72a` L2b)

**Constructor changed:**
```solidity
// V1: constructor(uint32 _endpointId, address _endpoint)
// V2: constructor(uint32 _endpointId, address _endpoint, address _capOracle)
```

**New state:**
```solidity
ICawCapOracle public immutable capOracle;            // NEW
uint256 public constant MAX_SESSION_SPEND = 1_000_000_000 ether; // 1B CAW  // NEW
mapping(uint32 => uint32) internal tokenSessionEpoch;            // NEW (token-scoped session invalidation)
mapping(uint32 => uint256) public tokenSessionNonce;             // NEW
```

**New function:**
```solidity
function setERC1271Sibling(address _sibling) external onlyOwner
    // one-shot inline guard (SiblingSet error if already set)
    // V1 did not have this function

function registerTokenScopedSession(
    uint32 profileId, address sessionKey, uint64 expiry,
    uint8 scopeBitmap, uint256 spendLimit, uint64 perActionTipRate,
    uint256 nonce, uint8 v, bytes32 r, bytes32 s
) external

function validSession(address owner, address sessionKey)
    external view returns (StoredSession memory)
    // New — returns zeroed struct if epoch mismatch (token or wallet epoch)
```

**`registerSession` signature change:**
```solidity
// V1: (signer, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate,
//       nonce, uint8 v, bytes32 r, bytes32 s)
// V2: (signer, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate,
//       nonce, bytes calldata signature)
//     ↑ bytes sig replaces v/r/s — supports both 65-byte ECDSA AND ERC-1271 contract owners
```

**`StoredSession` struct extended:**
```solidity
// V1 StoredSession (5 fields):
//   expiry, scopeBitmap, epoch, perActionTipRate, spendLimit

// V2 StoredSession (6 fields):
struct StoredSession {
    uint64  expiry;
    uint8   scopeBitmap;
    uint32  epoch;
    uint64  perActionTipRate;
    uint32  profileId;    // NEW: 0 = wallet-scoped; non-zero = token-scoped
    uint256 spendLimit;
}
```

**`_lzReceive` changed:** Now strips 36-byte price prefix and calls
`capOracle.recordSample` before dispatching the selector (try/catch — oracle failure
does not block LZ delivery). Payload parsing offsets shifted from `[0:4]` to `[36:40]`
for selector; args start at `[40]` instead of `[4]`.

**`setERC1271Sibling`** — one-shot, emits `ERC1271SiblingSet(address sibling)`. The
sibling (`CawActionsERC1271`) is also authorized to call `setWithdrawable`.

**MAX_SESSION_SPEND enforcement:** `_writeWalletSession` and `registerTokenScopedSession`
both revert with `SpendLimitTooHigh` if `spendLimit > 1B CAW`.

**New error codes:**
```
SiblingSet, ZeroSibling, SpendLimitTooHigh
```

**`setWithdrawable` caller check changed:** V1 checked `msg.sender == cawActions`; V2
checks `msg.sender == address(cawActions) || msg.sender == erc1271Sibling`.

---

### CawActionsArchive.sol
**Status: MODIFIED** (new addresses: `0x506c5c09B064fcFf6861B1e08b6530D997715159` L2, `0x56BC0Ef3E55CcCb9e0E6ad7E8d8Ce332B368E06b` L2b)

**Constants changed:**
```
V1: MIN_STAKE = 0.01 ether
V2: MIN_STAKE = 0.05 ether   (Round-2 censorship drill finding)

V1: No CLAIM_COOLDOWN
V2: CLAIM_COOLDOWN = 10 minutes  (prevents 1-2 block re-claim after slash)

V1: No MAX_PENDING_PER_VALIDATOR
V2: MAX_PENDING_PER_VALIDATOR = 16   (H-6 fix — caps slash-loop gas)
```

**New state:**
```solidity
mapping(address => uint256[]) public validatorSubmissions;        // H-6 fix (pruned on finalize)
mapping(uint256 => uint256) internal validatorSubmissionsIndexPlusOne;
mapping(uint32 => mapping(uint256 => uint64)) public checkpointClaimReopensAt;  // cooldown
```

**`setPeer` overridden to `onlyOnce` per eid** (same pattern as CawProfile).

**`finalizeSubmission`** — fixed `>` → `>=` for CHALLENGE_PERIOD boundary (off-by-one
on challenge window edge, Pass 3 finding).

**Slash mechanism** — `resolveChallenge` now pruning `validatorSubmissions` via
swap-and-pop; slash invalidates ALL pending submissions and sets `checkpointClaimReopensAt`.

---

### CawProfileMarketplace.sol
**Status: MODIFIED** (new address: `0x68bFF54d7597387b8CB0e81C9Cf4DA7f0a253312`)

**H-15: Seller payouts now pull-pattern (breaking):**
- V1: Sale proceeds were pushed directly to seller.
- V2: Sale proceeds are accumulated in `pendingPayouts[seller]`. Seller must call:
```solidity
function withdrawPayouts() external nonReentrant
function withdrawPayoutsTo(address recipient) external nonReentrant
```

**H-17: English auction escape hatch (new function):**
```solidity
function refundDefaultedAuction(uint256 listingId) external nonReentrant
    // Available to highest bidder after AUCTION_DEFAULT_GRACE (7 days) past endTime
    // if seller never called settleAuction
```

**New state:**
```solidity
mapping(address => uint256) public pendingPayouts;   // H-15
```

**New events:**
```
PayoutQueued(address indexed seller, uint256 amount)
PayoutWithdrawn(address indexed seller, address indexed recipient, uint256 amount)
AuctionDefaulted(uint256 indexed listingId, address indexed bidder, uint256 amount)
```

---

### CawChallengeRelay.sol
**Status: MODIFIED** (new addresses: `0x166FD4aa0379D01251beFAdcc3646004D5be9e91` L2, `0x5e8fFC6fe6F2902970b6733f064B8bF82E5c4D0e` L2b)

**`setPeer` overridden to `onlyOnce` per eid** (same pattern as CawProfile and CawActionsArchive).

Interface reference renamed from `clientHashAtCheckpoint` to `networkHashAtCheckpoint`
(matching the field rename in CawActions).

---

## REMOVED contracts

### CawClientManager.sol
**Status: REMOVED.** Replaced wholesale by `CawNetworkManager.sol`. No migration path —
V1 deployment address `0xA5C515D35C291110090b6edc4278acdEf1424C7a` is abandoned.

Any BE/FE code still referencing `CawClientManager` ABI or `clientId` terminology will fail.

---

## UNCHANGED contracts

- `MintableCaw.sol` — unchanged (same address `0x56817dc696448135203C0556f702c6a953260411`).
- `CawFontDataA.sol`, `CawFontDataB.sol` — new addresses (`0xa024...`, `0x2529...`) but
  logic unchanged; redeployed as part of the full V2 deploy set.
- `CawProfileURI.sol` — new address (`0xC2F8...`); logic unchanged.
- `CawBuyAndBurn.sol` — new address (`0xC6D0...`); logic unchanged (intentionally
  accepted findings: `block.timestamp` deadline, unchecked transfer — see AUDIT_TRAIL.md §3).
- `CawProfileQuoter.sol` — new address (`0xbA30...`); logic unchanged.
- `OnlyOnce.sol` — unchanged (no deployed address; library).
- `PathwayExpander.sol` — unchanged.

---

## Consumer changes required

### Frontend (`client/src/services/FrontEnd/`)

**1. Contract addresses updated (breaking — hard-code in env or constants file):**
- All contracts except `MintableCaw` have new addresses. Contracts file / `generated.ts`
  ABI has been updated (commit `1d54dbcd` starts V2 ABI era). Verify
  `VITE_CAW_PROFILE_ADDRESS`, `VITE_CAW_ACTIONS_ADDRESS`, `VITE_NETWORK_MANAGER_ADDRESS`,
  `VITE_MARKETPLACE_ADDRESS`, `VITE_MINTER_ADDRESS`, `VITE_SMART_EOA_ADDRESS` env vars.
  _Related: CawNetworkManager, CawActions, CawProfileMinter, SmartEOA, CawProfileMarketplace._

**2. CawClientManager → CawNetworkManager (breaking rename):**
- All FE calls to `createClient`, `getClient`, `setWithdrawFee`, etc. must use the new
  `createNetwork`, `getNetwork`, `setWithdrawFee` equivalents on `CawNetworkManager`.
- `ClientCreated` event listener → `NetworkCreated`. The `network` payload now carries 4
  ceiling fields; any parsing that expected the V1 `CawClient` struct shape will miss them.
- Fee ceiling getters (`getWithdrawFeeCeiling`, etc.) are now available — FE should display
  committed ceilings to users.
  _Related: CawNetworkManager._

**3. Marketplace — seller balance no longer changes on sale (H-15, breaking):**
- FE logic that refetched seller.balance after a sale to show proceeds must be replaced.
  Proceeds are in `pendingPayouts[seller]` until the seller calls `withdrawPayouts()`.
- Add a "Claim proceeds" button / banner for sellers with `pendingPayouts[address] > 0`.
  _Related: CawProfileMarketplace._

**4. Population B signup flow (EIP-7702 + passkey) — already built:**
- `SmartEOA.initialize(pubkeyX, pubkeyY, ecdsaFallbackAddr, minterContract, mintCalldata)`
  must be called in the same type-0x04 tx. Single-tx bootstrap proved by `EIP7702Bootstrap.t.sol`.
- WebAuthn sig blob format for `isValidSignature`: `abi.encode(authenticatorData, clientDataJSON, r, s)`.
- See `native/docs/` for the full Population B onboarding design.
  _Related: SmartEOA, CawProfileMinter sponsored entry points._

**5. Session registration — signature parameter changed:**
- `registerSession` now takes `bytes calldata signature` instead of `uint8 v, bytes32 r, bytes32 s`.
  FE must pack as `abi.encodePacked(r, s, v)` (65 bytes) for EOA signers.
  For SmartEOA owners, pass the full WebAuthn blob.
  _Related: CawProfileL2._

**6. Token-scoped sessions — new registration flow:**
- New function `registerTokenScopedSession` requires `uint8 v, bytes32 r, bytes32 s` from
  the token owner (ECDSA only). FE must expose per-profile session creation distinct from
  wallet-wide sessions.
  _Related: CawProfileL2._

**7. Fee ceiling reads — update fee-display and onboarding modals:**
- V1 had no ceilings; V2 FE should read `getWithdrawFeeCeiling/getDepositFeeCeiling/
  getAuthFeeCeiling/getMintFeeCeiling` to show committed limits in "trust-minimized" UI.
- Any existing `feeCeiling` (single field) reads are dead — replace with the 4-field getters.
  _Related: CawNetworkManager._

**8. Passkey management UI (new work):**
- `addPasskey / removePasskey / cancelPendingPasskey / rotateEcdsaFallback` flows need UI.
  Management-op sigs require `SmartEOA.managementNonceOf()` read + digest construction per
  `_managementDigest` ABI (opName + params + managementNonce + chainId + address(this)).
  _Related: SmartEOA._

---

### Backend (`client/src/services/{ActionProcessor, ValidatorService, Api}`)

**1. CawClientManager → CawNetworkManager (breaking):**
- Replace all `CawClientManager` ABI references, event listeners for `ClientCreated`, and
  storage reads (`clients[id]`) with CawNetworkManager equivalents (`NetworkCreated`,
  `networks[id]`). Update `REPLICATE_NETWORK_IDS` env (was `REPLICATE_CLIENT_IDS`).
  _Related: CawNetworkManager._

**2. NetworkFeeUpdated event listener needed (new):**
- V1 fee changes were silent. V2 emits `NetworkFeeUpdated(networkId, feeType, newFee)`.
  Indexer should listen and update the cached fee in the network config store.
  Ceiling-lowered events (`WithdrawFeeCeilingLowered`, etc.) should also be stored.
  _Related: CawNetworkManager._

**3. CawActionsERC1271 entry point — new action submission path:**
- ValidatorService must handle Population B and contract-wallet batches via
  `processActionsERC1271`. Existing `processActions` path unchanged.
- The `ActionsProcessed` event emitted by CawActionsERC1271 has the same shape as
  CawActions' `ActionsProcessed` — indexers can consume both from separate addresses.
  _Related: CawActionsERC1271._

**4. ZK path bitmap — indexer must read `ActionsProcessedZk.actionsExecutedBitmap`:**
- V2 ZK path emits `ActionsProcessedZk` (new event). Bit i = 0 means slot i was skipped
  (cawonce conflict). Indexers that reconstruct state from ZK batches must check the bitmap
  before applying each action's side effects.
  _Related: CawActions._

**5. Cap oracle — no indexer action needed, but validators can call `pushRatioIfStale`:**
- CawCapOracle pushes automatically on every sample. Validators wanting to avoid a 24h
  dormancy window during L1 idle periods can call `pushRatioIfStale()` (permissionless,
  5-min rate limit). Not required for correctness.
  _Related: CawCapOracle._

**6. L1 price sample piggybacking — no new server action, but monitoring change:**
- Every L1→L2 LZ message now carries a 36-byte price prefix. The `_lzReceive` payload
  layout changed: selector is at byte offset 36, args start at offset 40 (was 4 / 4).
  Any BE code that parses LZ payload bytes directly must update offsets.
  _Related: CawProfileL2._

**7. Sponsored actions — SponsorService (already wired per Wave 2):**
- `depositForSponsored` HIGH-1 fix: sponsor must pre-approve Minter for CAW before the
  call (`CAW.approve(minterAddress, amount)`). The Minter now pulls from msg.sender
  (the sponsor) rather than relying on a pre-existing allowance chain.
  _Related: CawProfileMinter._

**8. Archive validator config:**
- `MIN_STAKE` raised from 0.01 ETH to 0.05 ETH. Validators with only 0.01 ETH staked
  will be unable to submit until they top up.
- `MAX_PENDING_PER_VALIDATOR = 16`. Validator loops must track and not exceed this.
  _Related: CawActionsArchive._

---

### Indexers / data layer

**1. Network table: rename `clientId` → `networkId`, add 4 ceiling columns:**
- `Network` (or `Client`) table needs `withdrawFeeCeiling`, `depositFeeCeiling`,
  `authFeeCeiling`, `mintFeeCeiling` columns.
- Migration: `ALTER TABLE networks ADD COLUMN withdraw_fee_ceiling BIGINT NOT NULL DEFAULT 0`, etc.
- Seed from `NetworkCreated` event payload on reindex.

**2. Session table: add `profile_id` column:**
- `StoredSession.profileId` is new. Token-scoped sessions have `profileId != 0`.
- Token-scoped sessions use `tokenSessionEpoch[profileId]` not `ownerSessionEpoch[owner]`.
- Migration: `ALTER TABLE sessions ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 0`.

**3. Marketplace seller payouts table (new):**
- Index `PayoutQueued(seller, amount)` and `PayoutWithdrawn(seller, recipient, amount)`
  to track unsettled proceeds per seller. FE needs this to render the "claim" UI.
- Or read `pendingPayouts[address]` via RPC call — no table needed if pull is synchronous.

**4. ZK bitmap tracking:**
- If the indexer indexes ZK-path batches, it must parse `actionsExecutedBitmap` from
  `ActionsProcessedZk` to determine which actions actually ran. Previously all actions in
  a `processActions` batch either ran or reverted together.

**5. `networkHashAtCheckpoint` field renamed from `clientHashAtCheckpoint`:**
- Any archive-related DB queries or storage keys using the old field name must be updated.

**6. `creationBlock` field in Network now usable:**
- V1 `CawClient` had `creationBlock` but it was rarely used. V2 `CawNetwork` has it in
  the `NetworkCreated` event payload. Indexers should use it to scope historical scans.

---

### Off-chain config / env vars

| Env var (old) | Env var (new) | Notes |
|---|---|---|
| `REPLICATE_CLIENT_IDS` | `REPLICATE_NETWORK_IDS` | ValidatorService |
| (new) | `SMART_EOA_ADDRESS` | Address of deployed SmartEOA delegate |
| (new) | `CAW_CAP_ORACLE_ADDRESS` | L2 CawCapOracle address |
| (new) | `CAW_L1_PRICE_READER_ADDRESS` | L1 CawL1PriceReader address |
| (new) | `CAW_ACTIONS_ERC1271_ADDRESS` | CawActionsERC1271 sibling address |
| `CAW_CLIENT_MANAGER_ADDRESS` | `CAW_NETWORK_MANAGER_ADDRESS` | All services |

All contract address env vars need updating per the new `.deploy-state.json`.

---

### Documentation

- `CLAUDE.md` — references to `CawClientManager` updated to `CawNetworkManager` already
  in the HEAD copy. Verify no stale `CawClientManager` references remain in service docs.
- `docs/WHITEPAPER.md` — Population B / 7702 / passkey model covered in commit `9995751d`.
- `docs/AUDIT_TRAIL.md` — complete (committed).
- `native/docs/` — 12 design docs cover the Population B native app plan; no new changes needed.
