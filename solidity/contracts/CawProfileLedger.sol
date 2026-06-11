// contracts/CawProfileLedger.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @dev Formerly CawProfileL2. Renamed 2026-06-03 — the contract is a per-tokenId
///      CAW balance ledger that posting actions debit and withdraws drain, not
///      necessarily an L2. In bypassLZ co-deployment mode it lives on the same
///      chain as CawProfile; in cross-chain mode it lives on the target L2.

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ICawActions.sol";
import "./interfaces/ICawCapOracle.sol";
import "./CawProfileURI.sol";
import "./CawProfile.sol";
import "./OnlyOnce.sol";
import "./SigVerification.sol";
import { SessionMessageParser } from "./SessionMessageParser.sol";

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawProfileLedger is
  Context,
  Ownable,
  OnlyOnce,
  OApp
{
  using OptionsBuilder for bytes;

  // Custom errors — bytecode-cheaper than `require(cond, "msg")` because the
  // selector is 4 bytes vs the variable-length string. Needed on 0.8.30 where
  // codegen grew the deployed bytecode close enough to the EIP-170 24,576-byte
  // cap that the string form pushed CawProfileLedger over.
  error OnlyLZ();
  error ZeroKey();
  error Expired();
  error NotCa();
  error BadSig();
  error NoWithdraw();    // attempted to delegate WITHDRAW scope (bit 6)
  error BadNonce();      // session-registration nonce didn't match sessionNonce[signer]
  error Replayed();      // personal-sign digest already consumed
  error ZeroSibling();   // constructor _erc1271Sibling arg was address(0)
  error SpendLimitTooHigh(); // parsed or supplied spendLimit exceeds MAX_SESSION_SPEND

  using SigVerification for address;

  error NotMainnet();
  error ZeroAddress();
  error UnauthorizedSelector();
  error NoSession();
  error NoFee();
  error Unauth();
  error ZeroOwner();
  error InsufficientBalance();

  modifier onlyOnMainnet() {
    if (!(bypassLZ && msg.sender == address(cawProfile))) revert NotMainnet();
    _;
  }

  uint256 public totalCaw;

  ICawActions public cawActions;
  /// @notice ERC-1271 sibling contract. Also authorized to call setWithdrawable.
  address public erc1271Sibling;

  // SECURITY NOTE (audited 2026-04-06): Unlike standard ERC721, this ownerOf intentionally returns
  // address(0) for non-existent tokens instead of reverting. This is by design — CawProfileLedger is a
  // lightweight mirror synced from L1 via LayerZero, and tokens may be in a "not yet synced" state.
  // Reverting here would cascade failures through batch reads (CawProfile.sol:435,459), marketplace
  // operations (CawProfileMarketplace.sol:331 reclaimBid), and action processing (CawActions.sol:111).
  // The zero-address return is NOT a security risk: registerSession cannot populate
  // sessions[address(0)][...] because ecrecover cannot produce address(0), and the default session
  // expiry of 0 always fails the expiry > block.timestamp check in CawActions.verifySignature.
  // DO NOT change this to revert — it will break downstream callers.
  mapping(uint256 => address) public ownerOf;
  mapping(uint32 => string) public usernames;

  // Keeping track of networks to which the user has authenticated
  mapping(uint32 => mapping(uint32 => bool)) public authenticated;

  /// @notice True if a network allows actions without per-token authentication.
  ///         Set via LZ from L1 when authFee crosses the zero boundary.
  mapping(uint32 => bool) private _allowFreeAuth;
  function allowFreeAuth(uint32 networkId) external view returns (bool) { return _allowFreeAuth[networkId]; }

  /// @notice Last accepted sequence number for allowFreeAuth LZ messages per network.
  ///         Messages with seq <= lastAllowFreeAuthSeq[networkId] are stale and ignored,
  ///         preventing out-of-order or replayed LZ delivery from rolling back state.
  ///         (Audit fix 2026-05-23.)
  /// @dev Internal: no public getter needed — callers verify via allowFreeAuth() state.
  mapping(uint32 => uint64) internal lastAllowFreeAuthSeq;

  // Per-network tip target (wei). Packed: high 64 bits = last seq, low 192 bits = tipTargetWei.
  mapping(uint32 => uint256) private _tipTargetPacked;

  mapping(uint32 => uint256) public cawOwnership;

  uint256 public rewardMultiplier = 10**18;
  uint256 public precision = 10**18;

  uint32 public immutable layer1EndpointId;

  /// @notice Cap oracle. Receives piggybacked price samples from every L1->L2
  ///         message. May be address(0) if no oracle is configured (cap dormant).
  ICawCapOracle public immutable capOracle;

  bool private fromLZ;

  bool public bypassLZ;
  CawProfile public cawProfile;

  // ============================================
  // SESSION KEY DELEGATION (address-based)
  // ============================================

  /// @notice Packed session record. Slot layout (two storage slots):
  ///   Slot 0 (200 bits used): expiry(64) | scopeBitmap(8) | epoch(32) | perActionTipRate(64) | profileId(32)
  ///   Slot 1 (256 bits):       spendLimit(256)
  /// profileId == 0 → wallet-scoped (all tokens owned by `owner`).
  /// profileId != 0 → token-scoped (actions only valid for that specific tokenId).
  struct StoredSession {
    uint64  expiry;
    uint8   scopeBitmap;
    uint32  epoch;             // ownerSessionEpoch[owner] or tokenSessionEpoch[profileId] at registration; mismatch invalidates
    uint64  perActionTipRate;  // implicit validator tip per session-signed action (whole CAW)
    uint32  profileId;         // 0 = wallet-scoped; non-zero = token-scoped (only valid for that tokenId)
    uint256 spendLimit;        // max total CAW (whole tokens) this session can spend
  }

  /// @notice ownerAddress => sessionKey => stored session data
  mapping(address => mapping(address => StoredSession)) public sessions;

  /// @notice Per-tokenId L1-stamp of last applied ownership update. LZ messages
  ///         carrying ownership writes include uint64 stamp set to L1 block
  ///         number at flush time. L2 silently skips ownership writes whose
  ///         stamp is strictly less than the stored value; funds-moving
  ///         fields in the same message (deposits, mints, withdraws) ALWAYS
  ///         apply regardless. CL-4 fix.
  mapping(uint32 => uint64) public lastOwnerUpdateBlock;

  /// @notice Per-owner session epoch. Bumped on every ownership-out transfer.
  ///         Sessions stamp their epoch at registration; verification rejects
  ///         sessions whose stamped epoch != current. CL-4 fix.
  mapping(address => uint32) public ownerSessionEpoch;

  /// @dev Per-tokenId session epoch. Bumped on every transfer of that token (in _setOwnerOf).
  ///      Token-scoped sessions stamp this at registration; mismatch after transfer invalidates them.
  ///      Internal: callers verify indirectly via validSession().
  mapping(uint32 => uint32) internal tokenSessionEpoch;

  /// @notice Per-address nonce for session delegation signatures (prevents replay after revocation)
  mapping(address => uint256) public sessionNonce;

  /// @notice Per-tokenId nonce for token-scoped session delegation signatures.
  mapping(uint32 => uint256) public tokenSessionNonce;

  /// @notice Set of session-delegation message digests that have already been
  ///         consumed by `registerSessionPersonal`. The personal-sign message
  ///         format does NOT carry a nonce (it's a fixed-shape human-readable
  ///         string), so the only thing preventing replay is the user's
  ///         signature being one-shot. Without this, an attacker holding a
  ///         user's signed message could re-register a revoked session at
  ///         any time before the message's expiry. Audit fix 2026-05-08.
  /// @dev Internal: the replay guard is security state, but no external caller
  ///      needs to query it — the revert is the observable signal. Saves getter bytecode.
  mapping(bytes32 => bool) internal consumedSessionMessage;

  /// @notice Returns the StoredSession for (owner, sessionKey), zero-ed if the
  ///         session's epoch != current epoch or the session is expired.
  ///         For wallet-scoped sessions (profileId == 0) uses ownerSessionEpoch[owner];
  ///         for token-scoped sessions (profileId != 0) uses tokenSessionEpoch[profileId].
  function validSession(address owner, address sessionKey) external view returns (StoredSession memory s) {
    s = sessions[owner][sessionKey];
    uint32 expectedEpoch = s.profileId == 0
      ? ownerSessionEpoch[owner]
      : tokenSessionEpoch[s.profileId];
    if (s.epoch != expectedEpoch) {
      return StoredSession(0, 0, 0, 0, 0, 0);
    }
  }

  bytes32 public immutable eip712DomainHash;

  bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );

  bytes32 private constant DELEGATION_TYPEHASH = keccak256(
    "SessionDelegation(address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)"
  );

  bytes32 private constant REVOKE_SESSION_TYPEHASH = keccak256(
    "RevokeSession(address owner,address sessionKey,uint64 expiry)"
  );

  bytes32 private constant TOKEN_DELEGATION_TYPEHASH = keccak256(
    "TokenSessionDelegation(uint32 profileId,address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)"
  );

  /// @notice Absolute upper bound on any session spend limit. Prevents phishing
  ///         pages from submitting an inflated value (e.g. "999B CAW") after
  ///         showing the user a lower figure. Finding NEW-4, audit 2026-05-19.
  ///         Internal: no external getter needed — no caller reads this constant.
  uint256 internal constant MAX_SESSION_SPEND = 1_000_000_000 ether; // 1B CAW

  event OwnerSet(uint32 tokenId, address newOwner);
  event UsernameMinted(uint32 tokenId, address owner);
  event Authenticated(uint32 cawNetworkId, uint32 tokenId);
  event SessionCreated(address indexed owner, address indexed sessionKey, uint64 expiry, uint8 scopeBitmap, uint256 spendLimit, uint64 perActionTipRate);
  event SessionRevoked(address indexed owner, address indexed sessionKey);
  /// @notice Emitted when CawActions burns L2 stake on behalf of a token (withdraw flow).
  /// @dev Counterpart to L1 `CawProfile.Withdrawn`. The L2-side decrement of `totalCaw`
  ///      happens here; the L1 setWithdrawable LZ message carries the amounts back to
  ///      L1 where the user eventually receives the underlying CAW. Indexers that
  ///      reconstruct net stake-flow from chain events need both sides — without this,
  ///      the L2 decrement is invisible and `cawProfileLedger.totalCaw()` drifts below
  ///      sum-of-deposits-minus-recorded-withdrawals.
  event Withdrawn(uint32 indexed tokenId, uint256 amount);

  bytes4 public constant setWithdrawableSelector = bytes4(keccak256("setWithdrawable(uint32[],uint256[])"));

  struct Token {
    uint256 tokenId;
    uint256 balance;
    string username;
    uint256 cawBalance;
    uint256 nextCawonce;
  }

  /// @param _endpointId    LayerZero EID of the L1 chain (the source of truth for ownership).
  /// @param _endpoint      Address of the LayerZero V2 EndpointV2 contract on this chain.
  /// @param _capOracle     CawCapOracle address (address(0) = cap dormant, backward-compatible).
  /// @param _cawProfile    Address of the L1 CawProfile contract. Required — this contract's
  ///                       authorized L1 caller in bypassLZ mode and the LZ peer target in
  ///                       cross-chain mode. Cannot be zero.
  /// @param _cawActions    Address of the CawActions contract on this chain. Cannot be zero.
  /// @param _erc1271Sibling Address of the CawActionsERC1271 sibling contract. Cannot be zero.
  /// @param _bypassLZ      True for mainnet co-deployment (L1 calls directly), false for
  ///                       cross-chain operation (LZ messages from L1 CawProfile peer).
  ///
  /// @dev  WHY THREE NEW ARGS — All three wiring addresses are now resolved at deploy time
  ///       via nonce prediction (the same pattern CawProfile uses for its own ctor args),
  ///       eliminating the post-deploy setL1Peer / setCawActions / setERC1271Sibling admin
  ///       surface. Those setters existed so the deploy script could wire up circular
  ///       dependencies after-the-fact; prediction breaks the circularity without any
  ///       on-chain admin round-trips.
  ///
  /// @dev  WHY RENOUNCE-IN-CTOR — After this constructor runs there is nothing left for an
  ///       owner to do: all wiring is immutable (stored in `cawProfile`, `cawActions`,
  ///       `erc1271Sibling`) or handled by the defense-in-depth `setPeer` override (per-eid
  ///       OnlyOnce). Holding owner authority any longer is pure attack surface. Pattern
  ///       mirrors CawProfile.sol, which transfers ownership to PathwayExpander in its own
  ///       constructor; here we renounce unconditionally because CawProfileLedger has no
  ///       future additions-only surface (new L2 peers are added on the CawProfile side).
  constructor(
    uint32  _endpointId,
    address _endpoint,
    address _capOracle,
    address _cawProfile,
    address _cawActions,
    address _erc1271Sibling,
    bool    _bypassLZ,
    address _pathwayExpander
  )
    OApp(_endpoint, _pathwayExpander)
  {
    if (_pathwayExpander == address(0)) revert ZeroAddress();
    if (_cawProfile == address(0)) revert ZeroAddress();
    if (_cawActions == address(0)) revert ZeroAddress();
    if (_erc1271Sibling == address(0)) revert ZeroSibling();
    layer1EndpointId = _endpointId;
    eip712DomainHash = generateDomainHash();
    capOracle = ICawCapOracle(_capOracle); // address(0) permitted — cap stays dormant
    cawActions = ICawActions(_cawActions);
    erc1271Sibling = _erc1271Sibling;
    if (_bypassLZ) {
      bypassLZ = true;
      cawProfile = CawProfile(payable(_cawProfile));
    } else {
      // Cross-chain: wire _cawProfile as the L1 LZ peer for this eid.
      // Consumes the per-eid OnlyOnce slot via the defense-in-depth setPeer override.
      setPeer(_endpointId, bytes32(uint256(uint160(_cawProfile))));
    }
    // Zero admin from here on — no owner action is needed post-deploy.
    renounceOwnership();
  }

  /// @dev Compute the EIP-712 domain separator hash. Cached in `eip712DomainHash` at construction.
  ///      Read `eip712DomainHash` directly for the pre-computed value; off-chain callers
  ///      do not need to call this function.
  function generateDomainHash() internal view returns (bytes32) {
    return keccak256(
      abi.encode(
        EIP712_DOMAIN_TYPEHASH,
        keccak256(bytes("CawProfileLedger")),
        keccak256(bytes("1")),
        block.chainid,
        address(this)
      )
    );
  }

  /// @notice Batch fetch token metadata (username, CAW balance, next cawonce) for the given tokenIds.
  /// @param tokenIds The token IDs to fetch
  /// @return userTokens Array of Token structs in the same order as the input
  function getTokens(uint32[] memory tokenIds) external view returns (Token[] memory) {
    uint32 tokenId;
    uint256 tokenCount = tokenIds.length;
    Token[] memory userTokens = new Token[](tokenCount);
    for (uint32 i = 0; i < tokenCount; i++) {
      tokenId = tokenIds[i];

      userTokens[i].tokenId = tokenId;
      userTokens[i].username = usernames[tokenId];
      userTokens[i].cawBalance = cawBalanceOf(tokenId);
      userTokens[i].nextCawonce = cawActions.nextCawonce(tokenId);
    }
    return userTokens;
  }

  /// @notice Defense-in-depth: lock the inherited OApp `setPeer` once per eid so it
  ///         can NEVER be changed post-deploy — even if owner were somehow recovered.
  ///         The constructor calls this once (for the L1 eid in cross-chain mode);
  ///         future new-eid calls would also be locked after the first invocation per eid.
  ///         Owner is renounced at the end of the constructor, so only this path remains.
  ///
  /// @dev SECURITY NOTE — setDelegate hardening: the inherited setDelegate
  ///      is non-virtual; its trust model relies on owner renouncement in the constructor.
  ///      See CawActionsArchive.sol for full reasoning.
  function setPeer(uint32 _eid, bytes32 _peer)
    public
    override
    onlyOnce(keccak256(abi.encode("setPeer", _eid)))
  {
    super.setPeer(_eid, _peer);
  }

  /// @notice Get the CAW balance for a token, scaled by the global reward multiplier.
  /// @dev Internal storage uses `cawOwnership` (precision-adjusted shares); this returns the
  ///      actual CAW amount the token is entitled to.
  function cawBalanceOf(uint32 tokenId) public view returns (uint256){
    return cawOwnership[tokenId] * rewardMultiplier / (precision);
  }

  /// @notice Spend CAW from one token, distribute to all holders, and credit a recipient. CawActions only.
  /// @dev Used for tipping flows where the spender pays a tip to a specific recipient and a global reward.
  ///      Reverts unless `msg.sender == cawActions` (enforced inside `spendAndDistribute`).
  /// @param tokenId Token paying the cost
  /// @param amountToSpend CAW amount (whole tokens) the spender pays
  /// @param amountToDistribute CAW amount (whole tokens) distributed to all holders via reward multiplier
  /// @param recipientId Token receiving a direct credit
  /// @param recipientAmount CAW amount (whole tokens) credited to the recipient
  function spendDistributeAndAddTokensToBalance(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute, uint32 recipientId, uint256 recipientAmount) external {
    // SECURITY NOTE: No explicit access control here, but the first internal call
    // (spendAndDistribute) reverts unless msg.sender == cawActions. The second call
    // (addToBalance) is reachable only after that check passes. Safe by sequencing.
    spendAndDistribute(tokenId, amountToSpend * 10**18, amountToDistribute * 10**18);
    addToBalance(recipientId, recipientAmount * 10**18);
  }

  /// @notice Spend CAW from a token and distribute to all holders. CawActions only.
  /// @dev Whole-token wrapper around `spendAndDistribute` that scales inputs by 10**18.
  /// @param tokenId Token paying the cost
  /// @param amountToSpend CAW amount (whole tokens) the spender pays
  /// @param amountToDistribute CAW amount (whole tokens) distributed to all holders
  function spendAndDistributeTokens(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) external {
    // SECURITY NOTE: No explicit access control here, but spendAndDistribute reverts
    // unless msg.sender == cawActions. Safe by sequencing.
    spendAndDistribute(tokenId, amountToSpend * 10**18, amountToDistribute * 10**18);
  }

  /// @notice Spend CAW from a token (raw 18-decimal amounts) and distribute to all holders. CawActions only.
  /// @dev If the token's balance equals the total supply, the distributed amount is added back to the
  ///      single holder. Otherwise it inflates the global `rewardMultiplier`, crediting all holders.
  /// @param tokenId Token paying the cost
  /// @param amountToSpend Raw CAW amount (18 decimals) the spender pays
  /// @param amountToDistribute Raw CAW amount (18 decimals) distributed to all holders
  function spendAndDistribute(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) public {
    if (!(address(cawActions) == _msgSender())) revert NotCa();
    uint256 balance = cawBalanceOf(tokenId);

    if (balance < amountToSpend) revert InsufficientBalance();
    uint256 newCawBalance = balance - amountToSpend;

    // SECURITY (audited 2026-04-07): if "everyone else" holds less than the distribute amount,
    // refund to the spender instead. Caps per-call rewardMultiplier growth at 2x, preventing
    // a degenerate (1 whale + dust) attacker from overflowing uint256 in ~5 calls. The fallback
    // only triggers in early-network conditions; once any other holder has >=6001 CAW, normal
    // distribution always applies.
    uint256 denominator = totalCaw > balance ? totalCaw - balance : 0;
    if (denominator >= amountToDistribute && denominator > 0) {
      rewardMultiplier += rewardMultiplier * amountToDistribute / denominator;
    } else {
      newCawBalance += amountToDistribute;
    }

    setCawBalance(tokenId, newCawBalance);
  }

  /// @notice Add whole-token CAW to a token's balance. Wrapper around `addToBalance` for whole-token amounts.
  /// @dev Reverts inside `addToBalance` unless caller is cawActions or invocation came via LayerZero.
  function addTokensToBalance(uint32 tokenId, uint256 amount) external {
    addToBalance(tokenId, amount * 10**18);
  }

  /// @notice Unified LZ receiver. Conditionally deposits, mints, authenticates, registers
  ///         a session, and updates owners — based on which params are non-zero/non-empty.
  ///         Replaces the prior per-combination entry points (depositAndUpdateOwners,
  ///         mintAuthAndUpdateOwners, etc.) to reduce deployed bytecode.
  /// @param cawNetworkId  Network to authenticate with. 0 = skip auth.
  /// @param tokenId       Token being operated on.
  /// @param amount        CAW to deposit (18-decimal wei). 0 = skip deposit.
  /// @param username      Username for mint. Empty = skip mint.
  /// @param sessionKey    Session key to register. address(0) = skip session.
  /// @param expiry        Session expiry (unix seconds). Ignored if sessionKey == 0.
  /// @param spendLimit    Session spend limit. Ignored if sessionKey == 0.
  /// @param perActionTipRate  Session tip rate. Ignored if sessionKey == 0.
  /// @param tokenIds      Piggybacked ownership updates.
  /// @param owners        Corresponding new owners.
  /// @param stamps        Corresponding transfer timestamps.
  function lzDepositMintSession(
    uint32 cawNetworkId,
    uint32 tokenId,
    uint256 amount,
    string memory username,
    address sessionKey,
    uint64 expiry,
    uint256 spendLimit,
    uint64 perActionTipRate,
    uint32[] calldata tokenIds,
    address[] calldata owners,
    uint64[] calldata stamps
  ) public {
    if (!(fromLZ)) revert OnlyLZ();
    if (bytes(username).length > 0) {
      usernames[tokenId] = username;
      emit UsernameMinted(tokenId, owners.length > 0 ? owners[owners.length - 1] : address(0));
    }
    if (amount > 0) {
      totalCaw += amount;
      addToBalance(tokenId, amount);
    }
    if (cawNetworkId > 0) {
      authenticated[cawNetworkId][tokenId] = true;
      emit Authenticated(cawNetworkId, tokenId);
    }
    // Apply ownership updates BEFORE session registration so ownerOf[tokenId]
    // is current when we read it for the session nonce bump.
    updateOwners(tokenIds, owners, stamps);
    if (sessionKey != address(0)) {
      if (expiry <= block.timestamp) revert Expired();
      address owner = ownerOf[tokenId];
      sessionNonce[owner]++;
      _writeWalletSession(owner, sessionKey, expiry, 0xBF, perActionTipRate, spendLimit);
    }
  }

  /// @notice Set the free-auth flag for a network.
  ///         Callable via LZ message (_lzReceive sets fromLZ) or directly by the co-deployed
  ///         L1 CawProfile contract (bypassLZ mode). Permissionless in neither path: both
  ///         require the LZ peer or the trusted CawProfile address.
  ///
  ///         seq must be strictly greater than lastAllowFreeAuthSeq[networkId]. Stale or
  ///         replayed messages (seq <= last seen) are silently ignored to prevent
  ///         out-of-order LZ delivery from rolling back free-auth state.
  ///         (Audit fix 2026-05-23.)
  function setAllowFreeAuth(uint32 networkId, bool allow, uint64 seq) public {
    if (!(fromLZ || (bypassLZ && _msgSender() == address(cawProfile)))) revert OnlyLZ();
    if (seq <= lastAllowFreeAuthSeq[networkId]) return; // stale, ignore
    lastAllowFreeAuthSeq[networkId] = seq;
    _allowFreeAuth[networkId] = allow;
  }

  function networkTipTargetWei(uint32 networkId) external view returns (uint256) {
    return uint192(_tipTargetPacked[networkId]);
  }

  function setNetworkTipTarget(uint32 networkId, uint256 targetWei, uint64 seq) public {
    if (!(fromLZ || (bypassLZ && msg.sender == address(cawProfile)))) revert OnlyLZ();
    assembly {
      mstore(0x00, networkId)
      mstore(0x20, _tipTargetPacked.slot)
      let slot := keccak256(0x00, 0x40)
      let packed := sload(slot)
      if gt(seq, shr(192, packed)) {
        sstore(slot, or(shl(192, seq), and(targetWei, sub(shl(192, 1), 1))))
      }
    }
  }

  /// @notice Add CAW (raw 18-decimal amount) to a token's balance.
  /// @dev Callable by `cawActions` directly, via LayerZero (`fromLZ` flag), OR by the L1
  ///      `cawProfile` contract in bypassLZ co-deployment mode (the same trust boundary
  ///      `onlyOnMainnet` enforces — used by `deposit()` for L1-storage networks).
  function addToBalance(uint32 tokenId, uint256 amount) public {
    if (!(fromLZ || address(cawActions) == _msgSender() || (bypassLZ && _msgSender() == address(cawProfile)))) revert Unauth();

    setCawBalance(tokenId, cawBalanceOf(tokenId) + amount);
  }

  /// @dev Internal: write the token's CAW balance back to the precision-adjusted shares mapping.
  function setCawBalance(uint32 tokenId, uint256 newCawBalance) internal {
    cawOwnership[tokenId] = precision * newCawBalance / rewardMultiplier;
  }

  /// @notice Apply a batch of ownership updates from L1 transfers.
  /// @dev Callable from `_lzReceive` (cross-chain) OR directly by the L1 CawProfile
  ///      contract in bypassLZ co-deployment mode (same trust boundary).
  function updateOwners(uint32[] calldata tokenIds, address[] calldata owners, uint64[] calldata stamps) public {
    if (!(fromLZ || (bypassLZ && _msgSender() == address(cawProfile)))) revert OnlyLZ();
    for (uint i = 0; i < tokenIds.length; i++)
      _setOwnerOf(tokenIds[i], owners[i], stamps[i]);
  }

  // ----------------------------------------------------------------
  // Sponsor Repay — trustless L2-side enforcement of sponsor gifts.
  // The L1 minter declares `(sponsorTokenId, repayAmount)` at sponsored
  // mint time. Repay is plumbed here over the same LZ path (or directly
  // in bypassLZ mode) and stored. On withdraw, `sponsorSweepPreview`
  // returns the amount to credit the sponsor (capped at outstanding
  // repay and the user's withdrawal amount). The sponsor — verified by
  // ownership of `sponsorTokenId` — can `forgiveSponsorRepay` to zero
  // the obligation at any time.
  //
  // PHASE 2 SCOPE: registration + view + forgive land here. The
  // auto-sweep-on-withdraw integration on CawActions is deferred until
  // CawActions has byte-budget headroom (currently at EIP-170 minus 9
  // bytes). `sweepSponsorRepay` is callable today but only by CawActions
  // — wire its call site in CawActions in a future reclaim round.
  // ----------------------------------------------------------------

  /// @notice Outstanding repay obligation in wei, keyed by user's tokenId.
  mapping(uint32 => uint256) public sponsorRepay;
  /// @notice Sponsor's profile tokenId that receives sweep credits.
  mapping(uint32 => uint32) public repaySponsorTokenId;

  event SponsorRepayRegistered(uint32 indexed tokenId, uint32 sponsorTokenId, uint256 repayAmount);
  event SponsorRepaySwept(uint32 indexed tokenId, uint32 sponsorTokenId, uint256 swept, uint256 remaining);
  event SponsorRepayForgiven(uint32 indexed tokenId, uint32 sponsorTokenId);

  /// @notice Register a sponsor-repay obligation from L1.
  /// @dev Callable from `_lzReceive` (cross-chain) or directly by L1 CawProfile
  ///      in bypassLZ mode. Idempotent: only writes if currently unset.
  function registerSponsorRepayFromL1(uint32 tokenId, uint32 sponsorTokenId, uint256 repayAmount) external {
    if (!(fromLZ || (bypassLZ && _msgSender() == address(cawProfile)))) revert OnlyLZ();
    if (repayAmount == 0) return;
    if (sponsorRepay[tokenId] != 0) return; // already set; do not overwrite
    sponsorRepay[tokenId] = repayAmount;
    repaySponsorTokenId[tokenId] = sponsorTokenId;
    emit SponsorRepayRegistered(tokenId, sponsorTokenId, repayAmount);
  }

  /// @notice Preview the sweep amount for a hypothetical withdraw. CawActions
  ///         calls this before `withdraw` to compute the user-side credit.
  function sponsorSweepPreview(uint32 tokenId, uint256 amount) external view returns (uint256 swept) {
    uint256 outstanding = sponsorRepay[tokenId];
    swept = outstanding < amount ? outstanding : amount;
  }

  /// @notice Sweep the repay obligation onto the sponsor's balance.
  ///         CawActions-only. Must be called in the same tx as `withdraw` so
  ///         the user's L1 setWithdrawable credit is reduced by `swept`.
  function sweepSponsorRepay(uint32 tokenId, uint256 amount) external returns (uint256 swept) {
    if (!(address(cawActions) == _msgSender())) revert NotCa();
    uint256 outstanding = sponsorRepay[tokenId];
    swept = outstanding < amount ? outstanding : amount;
    if (swept > 0) {
      sponsorRepay[tokenId] = outstanding - swept;
      uint32 sponsorId = repaySponsorTokenId[tokenId];
      setCawBalance(sponsorId, cawBalanceOf(sponsorId) + swept);
      emit SponsorRepaySwept(tokenId, sponsorId, swept, outstanding - swept);
    }
  }

  /// @notice Sponsor — verified by ownership of `repaySponsorTokenId` — drops
  ///         the obligation, freeing the user to withdraw without sweep.
  function forgiveSponsorRepay(uint32 tokenId) external {
    uint32 sponsorId = repaySponsorTokenId[tokenId];
    if (ownerOf[sponsorId] != _msgSender()) revert Unauth();
    sponsorRepay[tokenId] = 0;
    emit SponsorRepayForgiven(tokenId, sponsorId);
  }



  /// @notice Co-deployment (bypassLZ) variant: mint the L2 mirror AND auth in one call.
  /// @dev Only callable when `bypassLZ` is true and the caller is the L1 CawProfile contract.
  ///      Mirrors `mintAuthAndUpdateOwners` but without the LZ payload — pending owner
  ///      updates aren't relevant in bypassLZ mode (L1 transfers update L2 directly).
  function mintAndAuth(uint32 tokenId, address owner, string memory username, uint32 cawNetworkId, uint64 stamp)
    external onlyOnMainnet
  {
    emit UsernameMinted(tokenId, owner);
    emit Authenticated(cawNetworkId, tokenId);
    usernames[tokenId] = username;
    _setOwnerOf(tokenId, owner, stamp);
    authenticated[cawNetworkId][tokenId] = true;
  }



  /// @notice Co-deployment (bypassLZ) helper for the bundled mint+quicksign flows. Registers a
  ///         session on behalf of `owner` without an EIP-712 signature, trusting the L1
  ///         CawProfile contract as the sole caller. WITHDRAW remains non-delegatable.
  /// @dev Only callable when `bypassLZ` is true and the caller is the L1 CawProfile contract.
  function registerSessionFromL1(address owner, address sessionKey, uint64 expiry, uint256 spendLimit, uint64 perActionTipRate)
    external onlyOnMainnet
  {
    if (sessionKey == address(0)) revert ZeroKey();
    if (expiry <= block.timestamp) revert Expired();
    // Same nonce-bump rationale as depositAndRegisterSessionAndUpdateOwners.
    sessionNonce[owner]++;
    _writeWalletSession(owner, sessionKey, expiry, 0xBF, perActionTipRate, spendLimit);
  }

  /// @notice Mark a token as authenticated with a network. Only used in mainnet co-deployment mode.
  /// @dev RT-1 sibling (audit 2026-06-11): like `deposit`, when `owner != address(0)`
  ///      this also sets the ledger's ownerOf. The standalone authenticate path
  ///      (CawProfile._authenticateBody, bypassLZ) can run on a token whose ledger
  ///      ownerOf was never set (plain `mint` then `authenticate`, no deposit) —
  ///      leaving ownerOf == address(0) bricks every CawAction with SessionExpired.
  ///      The internal `deposit` caller passes address(0) (it set ownerOf itself).
  function auth(uint32 cawNetworkId, uint32 tokenId, address owner) public onlyOnMainnet {
    emit Authenticated(cawNetworkId, tokenId);
    authenticated[cawNetworkId][tokenId] = true;
    if (owner != address(0)) _setOwnerOf(tokenId, owner, uint64(block.number));
  }

  /// @notice Credit a deposit from a co-deployed L1 contract (no LayerZero involved).
  /// @dev Only callable in mainnet co-deployment mode (`bypassLZ && msg.sender == cawProfile`).
  /// @dev RT-1 (audit 2026-06-10): when `owner != address(0)` (mint+deposit path)
  ///      set the ledger ownerOf so the freshly minted token is operable. The
  ///      existing-token `depositFor` path passes address(0) to skip it
  ///      (re-setting would bump epochs and kill live sessions every deposit).
  function deposit(uint32 cawNetworkId, uint32 tokenId, uint256 amount, address owner) external onlyOnMainnet {
    totalCaw += amount;
    if (owner != address(0)) _setOwnerOf(tokenId, owner, uint64(block.number));
    auth(cawNetworkId, tokenId, address(0)); // ownerOf already handled above
    addToBalance(tokenId, amount);
  }

  /// @notice Mint a token (mirror of L1 mint) — co-deployment mode only.
  /// @dev Only callable when `bypassLZ` is true and the caller is the L1 CawProfile contract.
  function mint(uint32 tokenId, address owner, string memory username, uint64 stamp) external onlyOnMainnet {
    emit UsernameMinted(tokenId, owner);
    usernames[tokenId] = username;
    _setOwnerOf(tokenId, owner, stamp);
  }

  /// @notice Update a single token's owner — co-deployment mode only.
  function setOwnerOf(uint32 tokenId, address newOwner, uint64 stamp) external onlyOnMainnet {
    _setOwnerOf(tokenId, newOwner, stamp);
  }

  /// @dev Internal: silent-skip if `stamp` is older than the last applied stamp
  ///      for this token (CL-4 / out-of-order LZ delivery). On owner-change,
  ///      bump `tokenSessionEpoch[tokenId]` so any token-scoped session keys
  ///      registered for this token are invalidated. Wallet-scoped sessions
  ///      do not need an epoch bump here: after transfer, `ownerOf[tokenId]`
  ///      is updated to the new owner, so CawActions.validSession() lookups
  ///      use the NEW owner's session table — the old owner's wallet-scoped
  ///      sessions are unreachable for that token regardless of epoch.
  function _setOwnerOf(uint32 tokenId, address newOwner, uint64 stamp) internal {
    if (stamp <= lastOwnerUpdateBlock[tokenId]) return; // stale or same-stamp; silent skip
    lastOwnerUpdateBlock[tokenId] = stamp;
    address prev = ownerOf[tokenId];
    if (prev != newOwner && prev != address(0)) {
      // CL-4 invariant: bump BOTH epochs on owner change.
      //   - ownerSessionEpoch[prev]: invalidates EVERY wallet-scoped session
      //     for the prev wallet. Required because an LZ unordered redelivery
      //     could later re-stamp ownerOf back to prev, reanimating sessions
      //     prev registered during their brief ownership. Without this, the
      //     intermediate-holder drain attack from project_l1l2_ownership_desync
      //     re-opens.
      //   - tokenSessionEpoch[tokenId]: invalidates token-scoped sessions
      //     bound to this profileId. Required for the same reason on the
      //     token-scoped path.
      unchecked { ownerSessionEpoch[prev]++; }
      unchecked { tokenSessionEpoch[tokenId]++; }
    }
    emit OwnerSet(tokenId, newOwner);
    ownerOf[tokenId] = newOwner;
  }

  // ============================================
  // SESSION KEY REGISTRATION & REVOCATION
  // ============================================

  /// @dev Write a wallet-scoped session record and emit SessionCreated.
  ///      Caller responsible for all pre-checks (expiry, nonce, sig).
  function _writeWalletSession(
    address owner, address sessionKey, uint64 expiry, uint8 scopeBitmap, uint64 perActionTipRate, uint256 spendLimit
  ) internal {
    if (spendLimit > MAX_SESSION_SPEND) revert SpendLimitTooHigh();
    sessions[owner][sessionKey] = StoredSession(expiry, scopeBitmap, ownerSessionEpoch[owner], perActionTipRate, 0, spendLimit);
    emit SessionCreated(owner, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate);
  }

  /// @notice Register a session key. The wallet owner signs an EIP-712
  ///         delegation, then anyone (e.g. the validator) can submit it
  ///         on-chain. Address-based: covers all tokens owned by `signer`.
  /// @dev    Signature handling routes through `SigVerification.recoverOrValidate`:
  ///           - 65-byte sig + EOA `signer`: ECDSA fast path via ecrecover
  ///             (both `r||s||v` and `v||r||s` packings supported).
  ///           - any-length sig + contract `signer` (Safe, 7702-delegated, etc.):
  ///             ERC-1271 `isValidSignature` fallback with a 50k-gas budget.
  ///         Callers that previously passed `(v, r, s)` should now pass
  ///         `abi.encodePacked(r, s, v)` as the signature.
  /// @param signer The address whose authorization is being claimed.
  /// @param sessionKey The ephemeral address that will sign actions.
  /// @param expiry Unix timestamp after which the session is invalid.
  /// @param scopeBitmap Bitfield of allowed ActionTypes (bits 0-7; only WITHDRAW bit 6 is forbidden).
  /// @param spendLimit Max whole CAW tokens this session key can spend (0 = unlimited).
  /// @param nonce Must match the signer's current sessionNonce (prevents replay after revocation).
  function registerSession(
    address signer,
    address sessionKey,
    uint64 expiry,
    uint8 scopeBitmap,
    uint256 spendLimit,
    uint64 perActionTipRate,
    uint256 nonce,
    bytes calldata signature
  ) external {
    if (signer == address(0)) revert BadSig();
    if (sessionKey == address(0)) revert ZeroKey();
    if (expiry <= block.timestamp) revert Expired();
    if ((scopeBitmap & 0x40) != 0) revert NoWithdraw();

    bytes32 digest = keccak256(abi.encodePacked(
      "\x19\x01",
      eip712DomainHash,
      keccak256(abi.encode(
        DELEGATION_TYPEHASH,
        sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate, nonce
      ))
    ));
    if (!signer.recoverOrValidate(digest, signature)) revert BadSig();
    if (nonce != sessionNonce[signer]) revert BadNonce();

    sessionNonce[signer]++;
    _writeWalletSession(signer, sessionKey, expiry, scopeBitmap, perActionTipRate, spendLimit);
  }

  /// @notice Register a session key using a human-readable personal_sign message.
  ///         Message format (13 lines, separated by \n):
  ///           Enable Quick Sign
  ///           ------------------
  ///           Spend limit:
  ///           5M CAW
  ///           (blank)
  ///           Tip per action:
  ///           1000 CAW
  ///           (blank)
  ///           Expires:
  ///           25 April 2026 00:00:00 UTC
  ///           (blank)
  ///           CAW Key:
  ///           0x742d...3e
  /// @dev    Signature handling mirrors `registerSession`: 65-byte sigs route
  ///         through ecrecover (both `r||s||v` and `v||r||s` packings); longer
  ///         sigs hit the ERC-1271 fallback if `signer` has code. ECDSA
  ///         callers pack as `abi.encodePacked(r, s, v)`.
  function registerSessionPersonal(
    address signer,
    bytes memory message,
    bytes calldata signature
  ) external {
    if (signer == address(0)) revert BadSig();
    bytes32 digest = keccak256(abi.encodePacked(
      "\x19Ethereum Signed Message:\n",
      SessionMessageParser.uint2str(message.length),
      message
    ));
    if (!signer.recoverOrValidate(digest, signature)) revert BadSig();

    // Replay protection: the personal-sign message format doesn't carry a
    // nonce, so a held signature could otherwise be re-submitted to undo a
    // revocation. Mark the digest consumed; reject duplicates. Audit fix
    // 2026-05-08.
    if (consumedSessionMessage[digest]) revert Replayed();
    consumedSessionMessage[digest] = true;

    (uint256 spendLimit, uint64 perActionTipRate, uint64 expiry, address sessionKey) = SessionMessageParser.parseSessionMessage(message);

    if (sessionKey == address(0)) revert ZeroKey();
    if (expiry <= block.timestamp) revert Expired();

    sessionNonce[signer]++;
    _writeWalletSession(signer, sessionKey, expiry, 0xBF, perActionTipRate, spendLimit);
  }

  /// @notice Register a token-scoped session key. Bound to a specific profileId;
  ///         only valid for actions from that profile. WITHDRAW (bit 6) force-cleared.
  ///         Invalidated on transfer via tokenSessionEpoch bump.
  ///         v/r/s: ECDSA sig from the current token owner over the typed-data digest.
  function registerTokenScopedSession(
    uint32 profileId,
    address sessionKey,
    uint64 expiry,
    uint8 scopeBitmap,
    uint256 spendLimit,
    uint64 perActionTipRate,
    uint256 nonce,
    uint8 v, bytes32 r, bytes32 s
  ) external {
    if (sessionKey == address(0)) revert ZeroKey();
    if (expiry <= block.timestamp) revert Expired();
    if (nonce != tokenSessionNonce[profileId]) revert BadNonce();
    if (spendLimit > MAX_SESSION_SPEND) revert SpendLimitTooHigh();
    uint8 bm = scopeBitmap & 0xBF;
    bytes32 digest = keccak256(abi.encodePacked(
      "\x19\x01",
      eip712DomainHash,
      keccak256(abi.encode(
        TOKEN_DELEGATION_TYPEHASH,
        profileId, sessionKey, expiry, bm, spendLimit, perActionTipRate, nonce
      ))
    ));
    address recovered = ecrecover(digest, v, r, s);
    // Use L2's local ownerOf mirror (kept in sync via LZ updateOwners + _setOwnerOf).
    // cawProfile.ownerOf() would only work in bypassLZ co-deployment mode; on a
    // real cross-chain deployment cawProfile is on L1 and the call reverts.
    if (recovered == address(0) || recovered != ownerOf[profileId]) revert BadSig();
    tokenSessionNonce[profileId]++;
    sessions[recovered][sessionKey] = StoredSession(expiry, bm, tokenSessionEpoch[profileId], perActionTipRate, profileId, spendLimit);
    emit SessionCreated(recovered, sessionKey, expiry, bm, spendLimit, perActionTipRate);
  }

  /// @notice Revoke a session key. Callable by the delegating wallet.
  function revokeSession(address sessionKey) external {
    delete sessions[msg.sender][sessionKey];
    emit SessionRevoked(msg.sender, sessionKey);
  }

  /// @notice Register a session via an OTHER action (qs:) submitted by CawActions.
  /// @dev    Auth: msg.sender must be the linked CawActions contract. CawActions has
  ///         already verified that the action's outer EIP-712 signature came from the
  ///         token owner (NOT a session key — session keys cannot escalate by
  ///         registering new sessions). The owner's tokenId is resolved on the
  ///         CawActions side via ownerOf(senderId), and that owner is what we
  ///         persist here.
  ///
  ///         Bumps sessionNonce so any in-flight registerSession-by-sig with the
  ///         same nonce is invalidated — keeps the off-chain action path and the
  ///         on-chain sig path coherent.
  ///
  ///         WITHDRAW remains non-delegatable (scopeBitmap forced to 0xBF), matching
  ///         every other "trusted-caller" register path in this contract.
  function registerSessionFromActions(
    address owner,
    address sessionKey,
    uint64 expiry,
    uint256 spendLimit,
    uint64 perActionTipRate
  ) external {
    if (!(msg.sender == address(cawActions))) revert NotCa();
    if (owner == address(0)) revert ZeroOwner();
    if (sessionKey == address(0)) revert ZeroKey();
    if (expiry <= block.timestamp) revert Expired();

    sessionNonce[owner]++;
    _writeWalletSession(owner, sessionKey, expiry, 0xBF, perActionTipRate, spendLimit);
  }

  /// @notice Revoke a session via an OTHER action (qx:) submitted by CawActions.
  /// @dev    Same auth gate + threat model as registerSessionFromActions.
  function revokeSessionFromActions(address owner, address sessionKey) external {
    if (!(msg.sender == address(cawActions))) revert NotCa();
    delete sessions[owner][sessionKey];
    emit SessionRevoked(owner, sessionKey);
  }

  /// @notice Revoke a session key using a signature from the session key itself.
  ///         Anyone can submit this (e.g., the validator/API), as long as they provide
  ///         a valid signature from the session key proving it wants to be revoked.
  function revokeSessionBySig(
    address owner,
    address sessionKey,
    uint8 v, bytes32 r, bytes32 s
  ) external {
    StoredSession memory session = sessions[owner][sessionKey];
    if (session.expiry == 0) revert NoSession();

    // EIP-712 digest for the RevokeSession message. Bound to the CURRENT
    // session's expiry — without binding, a previously-signed revocation could
    // be replayed if the user later re-registers the same sessionKey under the
    // same owner, letting an attacker who held the old signature revoke the
    // freshly-registered session. Each register fixes a unique expiry, so a
    // fresh expiry invalidates old revocation sigs. Audit fix 2026-05-08
    // cross-contract MED-5.
    bytes32 digest = keccak256(abi.encodePacked(
      "\x19\x01",
      eip712DomainHash,
      keccak256(abi.encode(REVOKE_SESSION_TYPEHASH, owner, sessionKey, session.expiry))
    ));
    address signer = ecrecover(digest, v, r, s);
    if (!(signer == sessionKey)) revert BadSig();

    delete sessions[owner][sessionKey];
    emit SessionRevoked(owner, sessionKey);
  }

  // Note: no ERC-1271 overload for revokeSessionBySig in v1. Session keys in
  // the magic-wallet design are always ephemeral ECDSA keys (generated locally
  // by the app/browser), so the ecrecover path is sufficient. A contract-style
  // session key (e.g., a smart-EOA delegated to a passkey, self-revoking) is
  // an interesting future case but doesn't exist today. Adding the overload
  // pushes CawProfileLedger over the EIP-170 deployed-bytecode limit; revisit when
  // there's a real consumer.

  /// @notice OApp callback for receiving cross-chain messages from L1.
  /// @dev See SECURITY NOTE inside. The OApp base verifies sender is the endpoint and the configured
  ///      peer before this runs. The payload layout (piggyback format):
  ///        [0..31]  uint256 cumulative  — UQ112.112 price cumulative from CawL1PriceReader
  ///        [32..35] uint32  priceTs     — block.timestamp at L1 read time
  ///        [36..39] bytes4  selector    — function selector (whitelisted via isAuthorizedFunction)
  ///        [40..]   bytes   args        — ABI-encoded arguments for the delegatecall
  ///      The 36-byte price prefix is stripped, fed to capOracle.recordSample, and the
  ///      rest dispatched via delegatecall exactly as before.
  ///
  ///      Error-path behaviour (intentionally asymmetric):
  ///        payload.length < 40  — silent return; the LZ channel is preserved. This path is
  ///                               unreachable from any correct CawProfile.sol deployment; it
  ///                               exists only to avoid a permanent channel stall if somehow
  ///                               a truncated message were delivered at the LZ layer.
  ///        bad selector         — reverts UnauthorizedSelector(); channel halts for operator
  ///                               attention. Recovery via endpoint.skipInboundNonce(). This
  ///                               path indicates a real bug in CawProfile (wrong selector
  ///                               construction) and should NOT be silently discarded.
  ///        delegatecall failure — reverts with the inner error; same rationale as above.
  ///                               A failing authorized function (e.g. InsufficientBalance)
  ///                               must halt the channel — silently dropping would permanently
  ///                               lose a deposit or ownership update.
  function _lzReceive(
    Origin calldata _origin, // struct containing info about the message sender
    bytes32 _guid, // global packet identifier
    bytes calldata payload, // encoded message payload being received
    address _executor, // the Executor address.
    bytes calldata // arbitrary data appended by the Executor
  ) internal override {
    // ── Price sample piggyback ────────────────────────────────────────────
    // Strip the 36-byte price prefix and pass it to the cap oracle.
    // If the oracle is not configured the sample is discarded (no-op).
    // Out-of-order LZ delivery is safe: recordSample silently skips
    // non-monotonic timestamps (see CawCapOracle.recordSample).
    if (address(capOracle) != address(0)) {
      uint256 cumulative;
      uint32 priceTs;
      assembly {
        cumulative := calldataload(payload.offset)
        priceTs    := shr(224, calldataload(add(payload.offset, 32)))
      }
      try capOracle.recordSample(cumulative, priceTs) {} catch {
        // Oracle reverts (OOG, invariant break, etc.) must NOT block L1->L2 delivery.
        // A missed sample only makes the TWAP slightly less dense — safe; cap goes
        // dormant under STALE_THRESHOLD if too many samples are dropped.
      }
    }

    // ── Primary payload dispatch ──────────────────────────────────────────
    // Guard: payload must be at least 40 bytes (36-byte prefix + 4-byte selector).
    // Only the locked-immutable L1 peer can send here, so a short payload indicates
    // a CawProfile bug. Return without reverting to keep the LZ channel alive —
    // this is the one path where silent-drop is preferable to a permanent stall,
    // because there is no meaningful state to preserve or operator action to take.
    if (payload.length < 40) return;

    // Selector at byte 36; args start at byte 40.
    bytes4 decodedSelector;
    bytes memory args = new bytes(payload.length - 40); // args = payload minus 36-byte prefix minus 4-byte selector

    assembly {
      // Copy the selector (bytes 36..39) from calldata
      decodedSelector := calldataload(add(payload.offset, 36))

      // Copy the arguments (bytes 40..) from calldata to memory
      calldatacopy(add(args, 32), add(payload.offset, 40), sub(payload.length, 40))
    }

    // Ensure the selector corresponds to an expected function to prevent unauthorized actions
    if (!isAuthorizedFunction(decodedSelector)) revert UnauthorizedSelector();

    // Call the function using the selector and arguments.
    //
    // SECURITY NOTE (audited 2026-04-06): The fromLZ + delegatecall pattern is intentional and safe.
    // - The OApp base class already verifies msg.sender == endpoint and the peer before _lzReceive runs.
    // - All authorized functions (lzDepositMintSession, updateOwners, setAllowFreeAuth,
    //   setNetworkTipTarget) perform only storage writes.
    // - fromLZ cannot get stuck: on success it resets below; on revert the entire tx rolls back.
    // - The endpoint is immutable (set once in constructor, can never change).
    // - These contracts are immutable post-deployment, so no new authorized functions can be added.
    fromLZ = true;
    (bool success, bytes memory returnData) = address(this).delegatecall(bytes.concat(decodedSelector, args));
    fromLZ = false;

    // Handle failure and revert with the error message
    if (!success) {
      if (returnData.length == 0) revert UnauthorizedSelector();
      assembly {
        let returndata_size := mload(returnData)
        revert(add(32, returnData), returndata_size)
      }
    }
  }

  /// @notice Whitelist of selectors allowed via delegatecall from LayerZero messages.
  function isAuthorizedFunction(bytes4 selector) private pure returns (bool) {
    return selector == bytes4(keccak256("lzDepositMintSession(uint32,uint32,uint256,string,address,uint64,uint256,uint64,uint32[],address[],uint64[])")) ||
      selector == bytes4(keccak256("updateOwners(uint32[],address[],uint64[])")) ||
      selector == bytes4(keccak256("setAllowFreeAuth(uint32,bool,uint64)")) ||
      selector == bytes4(keccak256("setNetworkTipTarget(uint32,uint256,uint64)")) ||
      selector == bytes4(keccak256("registerSponsorRepayFromL1(uint32,uint32,uint256)"));
  }

  /// @notice Subtract CAW from a token's balance (used during withdraw flows). CawActions only.
  /// @dev This decrements the L2-side bookkeeping; the actual L1 withdrawal credit is sent
  ///      via `setWithdrawable` over LayerZero. Wei-precision input — there's a
  ///      `withdrawTokens` whole-token-input wrapper alongside, matching the
  ///      `addTokensToBalance` / `spendAndDistributeTokens` convention.
  function withdraw(uint32 tokenId, uint256 amount) public {
    if (!(address(cawActions) == _msgSender())) revert NotCa();

    uint256 balance = cawBalanceOf(tokenId);
    if (balance < amount) revert InsufficientBalance();

    totalCaw -= amount;
    setCawBalance(tokenId, balance - amount);

    // Emit so L2 watchers can reconstruct net totalCaw flow without
    // having to derive it from CawActions.processActions.WITHDRAW
    // sub-events. See `Withdrawn` event docstring.
    emit Withdrawn(tokenId, amount);
  }

  /// @notice Whole-token wrapper around `withdraw` — scales by 10**18.
  /// @dev Pairs with `addTokensToBalance` / `spendAndDistributeTokens` so
  ///      CawActions can stop multiplying by 10**18 at every callsite. The
  ///      access control is enforced inside `withdraw`, not here.
  function withdrawTokens(uint32 tokenId, uint256 amount) external {
    withdraw(tokenId, amount * 10**18);
  }

  /// @notice Send withdrawable amounts to L1 via LayerZero (or directly in co-deployment mode).
  /// @dev CawActions only. The L1 contract receives this and credits the per-token `withdrawable`
  ///      mapping, allowing token owners to subsequently call `withdraw` on L1.
  ///
  ///      SECURITY NOTE (audited 2026-04-07): No `tokenIds.length == amounts.length` check.
  ///      The only caller is `CawActions.setWithdrawable`, which builds both arrays from the
  ///      same `withdrawCount` in lockstep — they are guaranteed equal by construction.
  ///      Adding a check here would add gas to the validator's hot path for an impossible bug.
  ///      Both contracts are immutable post-deployment.
  /// @param tokenIds Token IDs being credited
  /// @param amounts Corresponding withdraw amounts (raw 18-decimal CAW)
  /// @param lzTokenAmount LayerZero ZRO token amount (0 to pay in native gas)
  function setWithdrawable(uint32[] memory tokenIds, uint256[] memory amounts, uint256 lzTokenAmount) external payable {
    address _s = _msgSender();
    if (_s != address(cawActions) && _s != erc1271Sibling) revert NotCa();
    if (bypassLZ) {
      // bypassLZ mode does no LayerZero send, so any forwarded native fee
      // would be stuck in this contract permanently (there's no sweep path).
      // Reject explicitly so a misconfigured validator quote doesn't silently
      // brick funds. Audit fix 2026-05-08.
      if (msg.value != 0) revert NoFee();
      cawProfile.setWithdrawable(tokenIds, amounts);
    } else {
      bytes memory payload = abi.encodeWithSelector(setWithdrawableSelector, tokenIds, amounts);
      lzSend(setWithdrawableSelector, tokenIds.length, payload, lzTokenAmount);
    }
  }

  /// @notice Quote the LayerZero fee for sending a withdraw message to L1.
  /// @param payInLzToken True to quote in ZRO token, false for native gas
  function withdrawQuote(uint32[] memory tokenIds, uint256[] memory amounts, bool payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory payload = abi.encodeWithSelector(
      setWithdrawableSelector, tokenIds, amounts
    ); return lzQuote(setWithdrawableSelector, tokenIds.length, payload, payInLzToken);
  }

  /// @dev Quote a generic LayerZero message to L1, given a selector, batch size, and payload.
  function lzQuote(bytes4 selector, uint256 n, bytes memory payload, bool _payInLzToken) internal view returns (MessagingFee memory quote) {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector, n), 0);
    return _quote(layer1EndpointId, payload, _options, _payInLzToken);
  }

  /// @dev Internal: send a LayerZero message to the L1 endpoint.
  function lzSend(bytes4 selector, uint256 n, bytes memory payload, uint256 lzTokenAmount) internal {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector, n), 0);

    _lzSend(
      layer1EndpointId, // Destination chain's endpoint ID.
      payload, // Encoded message payload being sent.
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(msg.value, lzTokenAmount), // Fee struct containing native gas and ZRO token.
      // Refund excess LZ fee to the tx originator EOA, NOT msg.sender:
      // msg.sender here is CawActions which has no receive(), so an LZ-fee
      // overpay would fail the endpoint's refund call and revert the whole
      // batch. Mirrors CawProfile.lzSend. Audit fix 2026-05-08 (Round 4 LZ
      // agent MED-1).
      payable(tx.origin)
    );
  }

  /// @notice Gas limit forwarded to the destination chain for executing this message.
  /// @dev L2→L1 destination is Ethereum mainnet — gas overprovisioning is expensive because
  ///      the validator pays L1 gas prices for every wasted unit. Constants come from real
  ///      measurements (test-foundry/SetWithdrawableGas.t.sol, mainnet fork, cold storage slots):
  ///      measured base 35k + 24k*n; prior formula 22k + 19k*n underbudgeted every n.
  function gasLimitFor(bytes4 selector, uint256 n) internal view returns (uint128) {
    // Measured 2026-05-21 on mainnet fork with cold storage slots: see solidity/test-foundry/SetWithdrawableGas.t.sol
    if (selector == setWithdrawableSelector) return uint128(35_000 + 24_000 * n);
    revert UnauthorizedSelector();
  }

  // Signature verification (ERC-1271 fallback included) lives in
  // SigVerification.sol — extracted as a library to keep CawProfileLedger's
  // deployed bytecode under the EIP-170 24,576-byte cap.

}


