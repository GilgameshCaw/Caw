// contracts/CawProfile.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawProfileL2 is
  Context,
  Ownable,
  OnlyOnce,
  OApp
{
  using OptionsBuilder for bytes;

  // Custom errors — bytecode-cheaper than `require(cond, "msg")` because the
  // selector is 4 bytes vs the variable-length string. Needed on 0.8.30 where
  // codegen grew the deployed bytecode close enough to the EIP-170 24,576-byte
  // cap that the string form pushed CawProfileL2 over.
  error OnlyLZ();
  error ZeroKey();
  error Expired();
  error NotCa();
  error BadSig();
  error NoWithdraw();    // attempted to delegate WITHDRAW scope (bit 6)
  error BadNonce();      // session-registration nonce didn't match sessionNonce[signer]
  error Replayed();      // personal-sign digest already consumed
  error BadParse();      // any malformed input in the personal-sign message parser
  error SiblingSet();    // setERC1271Sibling already called
  error ZeroSibling();   // setERC1271Sibling called with address(0)

  using SigVerification for address;

  error NotMainnet();
  error ZeroAddress();
  error UnauthorizedSelector();
  error NoSession();
  error NoFee();
  error Unauth();
  error ZeroOwner();
  error InsufficientBalance();
  error BadDate();

  modifier onlyOnMainnet() {
    if (!(bypassLZ && msg.sender == address(cawProfile))) revert NotMainnet();
    _;
  }

  uint256 public totalCaw;

  ICawActions public cawActions;
  /// @notice ERC-1271 sibling contract. Also authorized to call setWithdrawable.
  address public erc1271Sibling;

  // SECURITY NOTE (audited 2026-04-06): Unlike standard ERC721, this ownerOf intentionally returns
  // address(0) for non-existent tokens instead of reverting. This is by design — CawProfileL2 is a
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

  struct StoredSession {
    uint64  expiry;
    uint8   scopeBitmap;
    uint256 spendLimit;        // max total CAW (whole tokens) this session can spend
    uint64  perActionTipRate;  // implicit validator tip per session-signed action (whole CAW)
    uint32  epoch;             // ownerSessionEpoch[owner] at registration time; mismatch invalidates
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

  /// @notice Per-address nonce for session delegation signatures (prevents replay after revocation)
  mapping(address => uint256) public sessionNonce;

  /// @notice Set of session-delegation message digests that have already been
  ///         consumed by `registerSessionPersonal`. The personal-sign message
  ///         format does NOT carry a nonce (it's a fixed-shape human-readable
  ///         string), so the only thing preventing replay is the user's
  ///         signature being one-shot. Without this, an attacker holding a
  ///         user's signed message could re-register a revoked session at
  ///         any time before the message's expiry. Audit fix 2026-05-08.
  mapping(bytes32 => bool) public consumedSessionMessage;

  /// @notice Returns the StoredSession for (owner, sessionKey), zero-ed if the
  ///         session's epoch != current ownerSessionEpoch[owner]. Lets callers
  ///         (CawActions) skip a separate epoch check on the hot verify path.
  function validSession(address owner, address sessionKey) external view returns (StoredSession memory s) {
    s = sessions[owner][sessionKey];
    if (s.epoch != ownerSessionEpoch[owner]) {
      return StoredSession(0, 0, 0, 0, 0);
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

  event OwnerSet(uint32 tokenId, address newOwner);
  event UsernameMinted(uint32 tokenId, address owner);
  event Authenticated(uint32 cawNetworkId, uint32 tokenId);
  event CawActionsSet(address cawActions);
  event SessionCreated(address indexed owner, address indexed sessionKey, uint64 expiry, uint8 scopeBitmap, uint256 spendLimit, uint64 perActionTipRate);
  event SessionRevoked(address indexed owner, address indexed sessionKey);
  /// @notice Emitted when CawActions burns L2 stake on behalf of a token (withdraw flow).
  /// @dev Counterpart to L1 `CawProfile.Withdrawn`. The L2-side decrement of `totalCaw`
  ///      happens here; the L1 setWithdrawable LZ message carries the amounts back to
  ///      L1 where the user eventually receives the underlying CAW. Indexers that
  ///      reconstruct net stake-flow from chain events need both sides — without this,
  ///      the L2 decrement is invisible and `cawProfileL2.totalCaw()` drifts below
  ///      sum-of-deposits-minus-recorded-withdrawals.
  event Withdrawn(uint32 indexed tokenId, uint256 amount);

  bytes4 public setWithdrawableSelector = bytes4(keccak256("setWithdrawable(uint32[],uint256[])"));

  struct Token {
    uint256 tokenId;
    uint256 balance;
    string username;
    uint256 cawBalance;
    uint256 nextCawonce;
  }

  /// @param _endpointId LayerZero EID of the L1 chain (the source of truth for ownership)
  /// @param _endpoint Address of the LayerZero V2 EndpointV2 contract on this chain
  /// @param _capOracle CawCapOracle address (address(0) = cap dormant, backward-compatible)
  constructor(uint32 _endpointId, address _endpoint, address _capOracle)
    OApp(_endpoint, msg.sender)
  {
    layer1EndpointId = _endpointId;
    eip712DomainHash = generateDomainHash();
    capOracle = ICawCapOracle(_capOracle); // address(0) permitted — cap stays dormant
  }

  /// @notice Compute the EIP-712 domain separator hash. Cached in `eip712DomainHash` at construction.
  function generateDomainHash() public view returns (bytes32) {
    return keccak256(
      abi.encode(
        EIP712_DOMAIN_TYPEHASH,
        keccak256(bytes("CawProfileL2")),
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

  /// @notice Configure the L1 peer. Owner-only.
  /// @dev If `_bypassLZ` is true, this contract is co-deployed on the same chain as CawProfile,
  ///      and the L1 contract will call this contract directly instead of via LayerZero.
  /// @param _eid LayerZero EID of the L1 chain
  /// @param peer Address of the L1 CawProfile contract
  /// @param _bypassLZ True for mainnet co-deployment, false for cross-chain operation
  function setL1Peer(uint32 _eid, address payable peer, bool _bypassLZ)
    external
    onlyOwner
    onlyOnce(keccak256("setL1Peer"))
  {
    if (peer == address(0)) revert ZeroAddress();
    if (_bypassLZ) {
      bypassLZ = true;
      cawProfile = CawProfile(peer);
    } else setPeer(_eid, bytes32(uint256(uint160(address(peer)))));
  }

  /// @notice Lock the inherited OApp `setPeer` once per eid. Once a peer is set
  /// (typically the first call to setL1Peer in deploy), it can NEVER be changed —
  /// even by the owner. Prevents a compromised owner from swapping the L1 peer to a
  /// contract they control and forging LZ messages. New eids stay openable by design.
  function setPeer(uint32 _eid, bytes32 _peer)
    public
    override
    onlyOnce(keccak256(abi.encode("setPeer", _eid)))
  {
    super.setPeer(_eid, _peer);
  }

  /// @dev SECURITY NOTE — setDelegate hardening: the inherited setDelegate
  ///      is non-virtual; rely on owner renouncement post-deploy. See
  ///      CawActionsArchive.sol for full reasoning.

  /// @notice Set the CawActions contract address. Owner-only, one-shot.
  /// @dev CawActions is the only contract authorized to call spend/balance functions here.
  function setCawActions(address _cawActions)
    external
    onlyOwner
    onlyOnce(keccak256("setCawActions"))
  {
    if (_cawActions == address(0)) revert ZeroAddress();
    cawActions = ICawActions(_cawActions);
    emit CawActionsSet(_cawActions);
  }

  event ERC1271SiblingSet(address sibling);

  /// @notice Set the ERC-1271 sibling contract. Owner-only; can only be called once.
  function setERC1271Sibling(address _sibling) external onlyOwner {
    if (erc1271Sibling != address(0)) revert SiblingSet();
    if (_sibling == address(0)) revert ZeroSibling();
    erc1271Sibling = _sibling;
    emit ERC1271SiblingSet(_sibling);
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

  /// @notice Mark a token as authenticated with a network and apply a batch of ownership updates.
  /// @dev Only callable from `_lzReceive` (the `fromLZ` flag is set there). The `updateOwners`
  ///      array carries pending L1→L2 ownership transfers piggybacked on this LZ message.
  function authenticateAndUpdateOwners(uint32 cawNetworkId, uint32 tokenId, uint32[] calldata tokenIds, address[] calldata owners, uint64[] calldata stamps) public {
    if (!(fromLZ)) revert OnlyLZ();
    authenticated[cawNetworkId][tokenId] = true;
    updateOwners(tokenIds, owners, stamps);
  }

  /// @notice Credit a deposit, mark as authenticated, and apply pending ownership updates.
  /// @dev Only callable from `_lzReceive`. Triggered by L1 `deposit()` calls forwarded via LayerZero.
  function depositAndUpdateOwners(uint32 cawNetworkId, uint32 tokenId, uint256 amount, uint32[] calldata tokenIds, address[] calldata owners, uint64[] calldata stamps) public {
    if (!(fromLZ)) revert OnlyLZ();
    totalCaw += amount;
    addToBalance(tokenId, amount);
    authenticateAndUpdateOwners(cawNetworkId, tokenId, tokenIds, owners, stamps);
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
  /// @dev Only callable from `_lzReceive`. Each entry overwrites `ownerOf[tokenId]` with the new owner.
  function updateOwners(uint32[] calldata tokenIds, address[] calldata owners, uint64[] calldata stamps) public {
    if (!(fromLZ)) revert OnlyLZ();
    for (uint i = 0; i < tokenIds.length; i++)
      _setOwnerOf(tokenIds[i], owners[i], stamps[i]);
  }

  /// @notice Mint a new token (mirror of an L1 mint) and apply pending ownership updates.
  /// @dev Only callable from `_lzReceive`. Sets username + owner atomically. Currently
  ///      unreachable because L1's mint() does not lzSend — kept wired so a future
  ///      "mint + authenticate (no deposit)" flow can be added without contract changes.
  ///      The trailing entry of (tokenIds, owners, stamps) carries this token's owner.
  function mintAndUpdateOwners(uint32 tokenId, address owner, string memory username, uint32[] calldata tokenIds, address[] calldata owners, uint64[] calldata stamps) public {
    if (!(fromLZ)) revert OnlyLZ();
    usernames[tokenId] = username;
    updateOwners(tokenIds, owners, stamps);
  }

  /// @notice Mint a new token mirror, mark it authenticated with `cawNetworkId`, and
  ///         apply pending ownership updates — all in one LZ-delivered message.
  /// @dev Only callable from `_lzReceive`. Used by the L1 `mintAndAuth` flow: a user
  ///      pays mint+auth fees on L1, the L1 NFT is minted, and this function brings
  ///      the L2 mirror in line with no balance change. Posts will still revert
  ///      until the user does a separate `deposit()` to fund their cawBalance.
  function mintAuthAndUpdateOwners(
    uint32 cawNetworkId,
    uint32 tokenId,
    address owner,
    string memory username,
    uint32[] calldata tokenIds,
    address[] calldata owners,
    uint64[] calldata stamps
  ) public {
    if (!(fromLZ)) revert OnlyLZ();
    emit UsernameMinted(tokenId, owner);
    emit Authenticated(cawNetworkId, tokenId);
    usernames[tokenId] = username;
    authenticated[cawNetworkId][tokenId] = true;

    // Trailing entry of (tokenIds, owners, stamps) is this token's owner; _setOwnerOf via updateOwners.
    updateOwners(tokenIds, owners, stamps);
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

  /// @notice Bundled L2 receiver: deposit + mark authenticated + register a Quick Sign session.
  ///         Only callable from `_lzReceive`. Used by the L1 mintAndDepositAndQuickSign flow.
  /// @dev WITHDRAW is permanently non-delegatable: scopeBitmap is hard-wired to 0xBF here, NOT
  ///      accepted as a parameter. The L1 caller's trust boundary (only-minter on the L1
  ///      function) covers `owner`, so we don't need an EIP-712 signature on this side.
  function depositAndRegisterSessionAndUpdateOwners(
    uint32 cawNetworkId,
    uint32 tokenId,
    uint256 amount,
    address owner,
    address sessionKey,
    uint64 expiry,
    uint256 spendLimit,
    uint64 perActionTipRate,
    uint32[] calldata tokenIds,
    address[] calldata owners,
    uint64[] calldata stamps
  ) public {
    if (!(fromLZ)) revert OnlyLZ();
    if (sessionKey == address(0)) revert ZeroKey();
    if (expiry <= block.timestamp) revert Expired();

    totalCaw += amount;
    addToBalance(tokenId, amount);
    authenticated[cawNetworkId][tokenId] = true;
    emit Authenticated(cawNetworkId, tokenId);

    // Apply ownership updates BEFORE registering the session so the session
    // gets stamped with the current ownerSessionEpoch (post-update).
    updateOwners(tokenIds, owners, stamps);

    // Bump sessionNonce for cross-path coherence: any pending registerSession-by-sig
    // payload the user signed (and never submitted) is invalidated by this on-chain
    // session write. Without this, an old by-sig payload could be submitted later by
    // anyone to register an additional, unintended session under the same owner.
    sessionNonce[owner]++;
    uint8 scopeBitmap = 0xBF; // all actions except WITHDRAW (bit 6) — non-delegatable
    sessions[owner][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit, perActionTipRate, ownerSessionEpoch[owner]);
    emit SessionCreated(owner, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate);
  }

  /// @notice Bundled L2 receiver: mint mirror + mark authenticated + register a Quick Sign
  ///         session — no deposit. Only callable from `_lzReceive`.
  function mintAuthAndRegisterSessionAndUpdateOwners(
    uint32 cawNetworkId,
    uint32 tokenId,
    address owner,
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
    if (sessionKey == address(0)) revert ZeroKey();
    if (expiry <= block.timestamp) revert Expired();

    emit UsernameMinted(tokenId, owner);
    emit Authenticated(cawNetworkId, tokenId);
    usernames[tokenId] = username;
    authenticated[cawNetworkId][tokenId] = true;

    // Apply ownership updates first (stamps trailing entry sets owner).
    updateOwners(tokenIds, owners, stamps);

    // Same nonce-bump rationale as depositAndRegisterSessionAndUpdateOwners.
    sessionNonce[owner]++;
    uint8 scopeBitmap = 0xBF; // all actions except WITHDRAW (bit 6) — non-delegatable
    sessions[owner][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit, perActionTipRate, ownerSessionEpoch[owner]);
    emit SessionCreated(owner, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate);
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
    uint8 scopeBitmap = 0xBF; // all actions except WITHDRAW (bit 6) — non-delegatable
    sessions[owner][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit, perActionTipRate, ownerSessionEpoch[owner]);
    emit SessionCreated(owner, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate);
  }

  /// @notice Mark a token as authenticated with a network. Only used in mainnet co-deployment mode.
  function auth(uint32 cawNetworkId, uint32 tokenId) public onlyOnMainnet {
    emit Authenticated(cawNetworkId, tokenId);
    authenticated[cawNetworkId][tokenId] = true;
  }

  /// @notice Credit a deposit from a co-deployed L1 contract (no LayerZero involved).
  /// @dev Only callable in mainnet co-deployment mode (`bypassLZ && msg.sender == cawProfile`).
  function deposit(uint32 cawNetworkId, uint32 tokenId, uint256 amount) external onlyOnMainnet {
    totalCaw += amount;
    auth(cawNetworkId, tokenId);
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
  ///      bump `ownerSessionEpoch[oldOwner]` so any session keys registered
  ///      while they held the token are invalidated.
  function _setOwnerOf(uint32 tokenId, address newOwner, uint64 stamp) internal {
    if (stamp < lastOwnerUpdateBlock[tokenId]) return; // stale; silent skip
    lastOwnerUpdateBlock[tokenId] = stamp;
    address prev = ownerOf[tokenId];
    if (prev != newOwner && prev != address(0)) {
      unchecked { ownerSessionEpoch[prev]++; }
    }
    emit OwnerSet(tokenId, newOwner);
    ownerOf[tokenId] = newOwner;
  }

  // ============================================
  // SESSION KEY REGISTRATION & REVOCATION
  // ============================================

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
    sessions[signer][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit, perActionTipRate, ownerSessionEpoch[signer]);
    emit SessionCreated(signer, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate);
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
      _uint2str(message.length),
      message
    ));
    if (!signer.recoverOrValidate(digest, signature)) revert BadSig();

    // Replay protection: the personal-sign message format doesn't carry a
    // nonce, so a held signature could otherwise be re-submitted to undo a
    // revocation. Mark the digest consumed; reject duplicates. Audit fix
    // 2026-05-08.
    if (consumedSessionMessage[digest]) revert Replayed();
    consumedSessionMessage[digest] = true;

    (uint256 spendLimit, uint64 perActionTipRate, uint64 expiry, address sessionKey) = _parseSessionMessage(message);

    if (sessionKey == address(0)) revert ZeroKey();
    if (expiry <= block.timestamp) revert Expired();

    sessionNonce[signer]++;

    uint8 scopeBitmap = 0xBF; // all actions except WITHDRAW (bit 6)
    sessions[signer][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit, perActionTipRate, ownerSessionEpoch[signer]);
    emit SessionCreated(signer, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate);
  }

  /// @dev Parse the multi-line session message. Format:
  ///   Enable Quick Sign\n------------------\nSpend limit:\n5M CAW\n\n
  ///   Tip per action:\n1000 CAW\n\nExpires:\n25 April 2026 00:00:00 UTC\n\nCAW Key:\n0x...
  function _parseSessionMessage(bytes memory msg_)
    internal pure returns (uint256 spendLimit, uint64 perActionTipRate, uint64 expiry, address sessionKey)
  {
    bytes[] memory lines = _splitLines(msg_);
    if (lines.length != 13) revert BadParse();

    // Line 0: "Enable Quick Sign"
    if (keccak256(lines[0]) != keccak256("Enable Quick Sign")) revert BadParse();
    // Line 1: "------------------" (decorative, skip)
    // Line 2: "Spend limit:" (label, skip)

    // Line 3: "5M CAW"
    spendLimit = _parseSpendLimitValue(lines[3]);

    // Line 4: "" (blank, skip)
    // Line 5: "Tip per action:" (label, skip)

    // Line 6: "1000 CAW"
    perActionTipRate = _parseTipRateValue(lines[6]);

    // Line 7: "" (blank, skip)
    // Line 8: "Expires:" (label, skip)

    // Line 9: "25 April 2026 00:00:00 UTC"
    expiry = _parseExpiryValue(lines[9]);

    // Line 10: "" (blank, skip)
    // Line 11: "CAW Key:" (label, skip)

    // Line 12: "0x..."
    sessionKey = _parseAddressLine(lines[12]);
  }

  /// @dev Parse a tip-rate line like "1000 CAW" or "0 CAW" → uint64 whole tokens.
  function _parseTipRateValue(bytes memory line) internal pure returns (uint64) {
    if (line.length < 5) revert BadParse();
    uint256 number = 0;
    uint256 i = 0;
    while (i < line.length && line[i] >= 0x30 && line[i] <= 0x39) {
      number = number * 10 + (uint8(line[i]) - 0x30);
      i++;
    }
    if (number > type(uint64).max) revert BadParse();
    // Allow 0 (opt-out) explicitly.
    if (!(i < line.length && line[i] == 0x20)) revert BadParse();
    if (!(
      line.length - i - 1 == 3 &&
      line[i+1] == 'C' && line[i+2] == 'A' && line[i+3] == 'W'
    )) revert BadParse();
    return uint64(number);
  }

  function _splitLines(bytes memory data) internal pure returns (bytes[] memory) {
    // Count newlines
    uint256 count = 1;
    for (uint256 i = 0; i < data.length; i++) {
      if (data[i] == 0x0A) count++;
    }
    bytes[] memory lines = new bytes[](count);
    uint256 lineIdx = 0;
    uint256 start = 0;
    for (uint256 i = 0; i < data.length; i++) {
      if (data[i] == 0x0A) {
        lines[lineIdx] = _slice(data, start, i);
        lineIdx++;
        start = i + 1;
      }
    }
    lines[lineIdx] = _slice(data, start, data.length);
    return lines;
  }

  function _slice(bytes memory data, uint256 from, uint256 to) internal pure returns (bytes memory) {
    bytes memory result = new bytes(to - from);
    for (uint256 i = from; i < to; i++) result[i - from] = data[i];
    return result;
  }

  /// @dev Parse "5M CAW" → 5000000
  function _parseSpendLimitValue(bytes memory line) internal pure returns (uint256) {
    if (line.length < 5) revert BadParse();
    uint256 number = 0;
    uint256 i = 0;
    while (i < line.length && line[i] >= 0x30 && line[i] <= 0x39) {
      number = number * 10 + (uint8(line[i]) - 0x30);
      i++;
    }
    if (number == 0) revert BadParse();
    if (i >= line.length) revert BadParse();
    if (line[i] == 'M') return number * 1_000_000;
    if (line[i] == 'K') return number * 1_000;
    if (line[i] == 'B') return number * 1_000_000_000;
    revert BadParse();
  }

  /// @dev Parse "25 April 2026 00:00:00 UTC" → unix timestamp
  function _parseExpiryValue(bytes memory line) internal pure returns (uint64) {
    if (line.length <= 20) revert BadDate();
    uint256 i = 0;

    // Day (1-2 digits)
    uint256 day = 0;
    while (i < line.length && line[i] >= 0x30 && line[i] <= 0x39) {
      day = day * 10 + (uint8(line[i]) - 0x30);
      i++;
    }
    if (day < 1 || day > 31) revert BadDate();
    i++; // skip space

    // Month name
    uint256 monthStart = i;
    while (i < line.length && line[i] != 0x20) i++;
    uint256 month = _parseMonth(_slice(line, monthStart, i));
    i++; // skip space

    // Year (4 digits)
    uint256 year = 0;
    for (uint256 j = 0; j < 4; j++) {
      year = year * 10 + (uint8(line[i + j]) - 0x30);
    }
    i += 4;
    i++; // skip space

    // HH:MM:SS
    uint256 hour   = (uint8(line[i]) - 0x30) * 10 + (uint8(line[i+1]) - 0x30);
    uint256 minute = (uint8(line[i+3]) - 0x30) * 10 + (uint8(line[i+4]) - 0x30);
    uint256 second = (uint8(line[i+6]) - 0x30) * 10 + (uint8(line[i+7]) - 0x30);

    // Validate ranges so silent rollover can't extend the user's intended
    // expiry. Without these: "Feb 31" parses fine and rolls into March, or
    // "30:99:99" parses and rolls into the next day + extra hours/minutes.
    // Audit fix 2026-05-08 (L2 M-4).
    if (hour >= 24) revert BadDate();
    if (minute >= 60) revert BadDate();
    if (second >= 60) revert BadDate();
    // Month-aware day bound. 28-day Feb default; +1 for leap years.
    uint8[12] memory daysInMonth = [31,28,31,30,31,30,31,31,30,31,30,31];
    if (_isLeapYear(year)) daysInMonth[1] = 29;
    if (day > uint256(daysInMonth[month - 1])) revert BadDate();
    // Sanity cap on year so the for-loop in _toUnixTimestamp can't be
    // weaponized into a 30M-gas DoS (~10K iterations max from 1970).
    if (year > 2200) revert BadDate();

    return uint64(_toUnixTimestamp(year, month, day, hour, minute, second));
  }

  function _parseMonth(bytes memory m) internal pure returns (uint256) {
    bytes32 h = keccak256(m);
    if (h == keccak256("January"))   return 1;
    if (h == keccak256("February"))  return 2;
    if (h == keccak256("March"))     return 3;
    if (h == keccak256("April"))     return 4;
    if (h == keccak256("May"))       return 5;
    if (h == keccak256("June"))      return 6;
    if (h == keccak256("July"))      return 7;
    if (h == keccak256("August"))    return 8;
    if (h == keccak256("September")) return 9;
    if (h == keccak256("October"))   return 10;
    if (h == keccak256("November"))  return 11;
    if (h == keccak256("December"))  return 12;
    revert("Invalid month");
  }

  /// @dev Convert date components to unix timestamp (UTC). Only valid for years >= 1970.
  function _toUnixTimestamp(uint256 year, uint256 month, uint256 day, uint256 hour, uint256 minute, uint256 second) internal pure returns (uint256) {
    if (year < 1970) revert BadDate();
    uint256 timestamp = 0;
    // Years
    for (uint256 y = 1970; y < year; y++) {
      timestamp += _isLeapYear(y) ? 366 days : 365 days;
    }
    // Months
    uint8[12] memory daysInMonth = [31,28,31,30,31,30,31,31,30,31,30,31];
    if (_isLeapYear(year)) daysInMonth[1] = 29;
    for (uint256 m = 1; m < month; m++) {
      timestamp += uint256(daysInMonth[m - 1]) * 1 days;
    }
    // Days, hours, minutes, seconds
    timestamp += (day - 1) * 1 days + hour * 1 hours + minute * 1 minutes + second;
    return timestamp;
  }

  function _isLeapYear(uint256 year) internal pure returns (bool) {
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
  }

  /// @dev Parse "0x742d...3e" → address
  function _parseAddressLine(bytes memory line) internal pure returns (address) {
    // "0x" + 40 hex chars = 42 bytes
    if (line.length != 42) revert BadDate();
    bytes memory hexStr = _slice(line, 2, 42);
    return address(uint160(_hexToUint(hexStr)));
  }

  function _hexToUint(bytes memory hexStr) internal pure returns (uint256 result) {
    for (uint256 i = 0; i < hexStr.length; i++) {
      uint8 c = uint8(hexStr[i]);
      uint8 val;
      if (c >= 0x30 && c <= 0x39) val = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) val = c - 0x61 + 10;
      else if (c >= 0x41 && c <= 0x46) val = c - 0x41 + 10;
      else revert("Invalid hex char");
      result = result * 16 + val;
    }
  }

  function _uint2str(uint256 value) internal pure returns (bytes memory) {
    if (value == 0) return "0";
    uint256 temp = value;
    uint256 digits;
    while (temp != 0) { digits++; temp /= 10; }
    bytes memory buffer = new bytes(digits);
    while (value != 0) {
      digits--;
      buffer[digits] = bytes1(uint8(48 + value % 10));
      value /= 10;
    }
    return buffer;
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
    uint8 scopeBitmap = 0xBF; // all actions except WITHDRAW (bit 6)
    sessions[owner][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit, perActionTipRate, ownerSessionEpoch[owner]);
    emit SessionCreated(owner, sessionKey, expiry, scopeBitmap, spendLimit, perActionTipRate);
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
  // pushes CawProfileL2 over the EIP-170 deployed-bytecode limit; revisit when
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
    // - All authorized functions (depositAndUpdateOwners, authenticateAndUpdateOwners,
    //   mintAndUpdateOwners, mintAuthAndUpdateOwners, depositAndRegisterSessionAndUpdateOwners,
    //   mintAuthAndRegisterSessionAndUpdateOwners, updateOwners) perform only storage writes.
    // - fromLZ cannot get stuck: on success it resets below; on revert the entire tx rolls back.
    // - The endpoint is immutable (set once in constructor, can never change).
    // - These contracts are immutable post-deployment, so no new authorized functions can be added.
    // - An alternative like msg.sender == endpoint would not work here because the authorized functions
    //   are public (required for delegatecall dispatch), and fromLZ is needed to distinguish the
    //   _lzReceive call path from direct external calls.
    fromLZ = true;
    (bool success, bytes memory returnData) = address(this).delegatecall(bytes.concat(decodedSelector, args));
    fromLZ = false;

    // Handle failure and revert with the error message
    if (!success) {
      // If the returndata is empty, use a generic error message
      if (returnData.length == 0) {
        revert("Delegatecall failed with no revert reason");
      } else {
        // Bubble up the revert reason
        assembly {
          let returndata_size := mload(returnData)
          revert(add(32, returnData), returndata_size)
        }
      }
    }
  }

  mapping(bytes4 => string) public functionSigs;

  /// @notice Whitelist of selectors allowed via delegatecall from LayerZero messages.
  /// @dev Security: verified that no authorized selector collides with any inherited
  ///      function from OApp, Ownable, or Context. Since the contract is immutable
  ///      post-deployment, no new selectors can ever be added to this list.
  function isAuthorizedFunction(bytes4 selector) private pure returns (bool) {
    return selector == bytes4(keccak256("depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[],uint64[])")) ||
      selector == bytes4(keccak256("authenticateAndUpdateOwners(uint32,uint32,uint32[],address[],uint64[])")) ||
      selector == bytes4(keccak256("mintAndUpdateOwners(uint32,address,string,uint32[],address[],uint64[])")) ||
      selector == bytes4(keccak256("mintAuthAndUpdateOwners(uint32,uint32,address,string,uint32[],address[],uint64[])")) ||
      selector == bytes4(keccak256("depositAndRegisterSessionAndUpdateOwners(uint32,uint32,uint256,address,address,uint64,uint256,uint64,uint32[],address[],uint64[])")) ||
      selector == bytes4(keccak256("mintAuthAndRegisterSessionAndUpdateOwners(uint32,uint32,address,string,address,uint64,uint256,uint64,uint32[],address[],uint64[])")) ||
      selector == bytes4(keccak256("updateOwners(uint32[],address[],uint64[])"));
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

  /// @notice Quote a generic LayerZero message to L1, given a selector, batch size, and payload.
  function lzQuote(bytes4 selector, uint256 n, bytes memory payload, bool _payInLzToken) public view returns (MessagingFee memory quote) {
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
  ///      measurements (scripts/measure-gas.js): measured ≈ 15.5k + 14.4k*n, with base and
  ///      slope each scaled up ~1.3× for safety margin covering cold-slot warmup variance.
  function gasLimitFor(bytes4 selector, uint256 n) public view returns (uint128) {
    if (selector == setWithdrawableSelector) return uint128(22_000 + 19_000 * n);  // measured: 15.5k + 14.4k*n
    revert('unexpected selector');
  }

  // Signature verification (ERC-1271 fallback included) lives in
  // SigVerification.sol — extracted as a library to keep CawProfileL2's
  // deployed bytecode under the EIP-170 24,576-byte cap.

}


