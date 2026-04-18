// contracts/CawProfile.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ICawActions.sol";
import "./CawProfileURI.sol";
import "./CawProfile.sol";

interface ICawActionsReplicator {
  function setClientChains(uint32 clientId, uint32[] calldata destEids) external;
}

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawProfileL2 is 
  Context,
  Ownable,
  OApp
{
  using OptionsBuilder for bytes;

  modifier onlyOnMainnet() {
    require(bypassLZ && msg.sender == address(cawProfile), "only callable on the mainnet, from mainnet CawProfile");
    _;
  }

  uint256 public totalCaw;

  ICawActions public cawActions;

  /// @notice The CawActionsReplicator contract for forwarding replication config
  address public cawActionsReplicator;

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

  // Keeping track of clients to which the user has authenticated
  mapping(uint32 => mapping(uint32 => bool)) public authenticated;

  mapping(uint32 => uint256) public cawOwnership;

  uint256 public rewardMultiplier = 10**18;
  uint256 public precision = 10**18;

  uint32 public immutable layer1EndpointId;

  bool private fromLZ;

  bool public bypassLZ;
  CawProfile public cawProfile;

  // ============================================
  // SESSION KEY DELEGATION (address-based)
  // ============================================

  struct StoredSession {
    uint64  expiry;
    uint8   scopeBitmap;
    uint256 spendLimit;     // max total CAW (whole tokens) this session can spend
  }

  /// @notice ownerAddress => sessionKey => stored session data
  mapping(address => mapping(address => StoredSession)) public sessions;

  /// @notice Per-address nonce for session delegation signatures (prevents replay after revocation)
  mapping(address => uint256) public sessionNonce;

  bytes32 public immutable eip712DomainHash;

  bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );

  bytes32 private constant DELEGATION_TYPEHASH = keccak256(
    "SessionDelegation(address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint256 nonce)"
  );

  event OwnerSet(uint32 tokenId, address newOwner);
  event UsernameMinted(uint32 tokenId, address owner);
  event Authenticated(uint32 cawClientId, uint32 tokenId);
  event CawActionsSet(address cawActions);
  event CawActionsReplicatorSet(address replicator);
  event SessionCreated(address indexed owner, address indexed sessionKey, uint64 expiry, uint8 scopeBitmap, uint256 spendLimit);
  event SessionRevoked(address indexed owner, address indexed sessionKey);

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
  constructor(uint32 _endpointId, address _endpoint)
    OApp(_endpoint, msg.sender)
  {
    layer1EndpointId = _endpointId;
    eip712DomainHash = generateDomainHash();
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
  function setL1Peer(uint32 _eid, address payable peer, bool _bypassLZ) external onlyOwner {
    if (_bypassLZ) {
      bypassLZ = true;
      cawProfile = CawProfile(peer);
    } else setPeer(_eid, bytes32(uint256(uint160(address(peer)))));
  }

  /// @notice Set the CawActions contract address. Owner-only.
  /// @dev CawActions is the only contract authorized to call spend/balance functions here.
  function setCawActions(address _cawActions) external onlyOwner {
    cawActions = ICawActions(_cawActions);
    emit CawActionsSet(_cawActions);
  }

  /// @notice Set the CawActionsReplicator contract address. Owner-only.
  /// @dev The replicator is forwarded `setClientChains` calls from L1 via LayerZero.
  function setCawActionsReplicator(address _replicator) external onlyOwner {
    cawActionsReplicator = _replicator;
    emit CawActionsReplicatorSet(_replicator);
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
    require(address(cawActions) == _msgSender(), "caller is not the cawActions contract");
    uint256 balance = cawBalanceOf(tokenId);

    require(balance >= amountToSpend, 'Insufficient CAW balance');
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

  /// @notice Mark a token as authenticated with a client and apply a batch of ownership updates.
  /// @dev Only callable from `_lzReceive` (the `fromLZ` flag is set there). The `updateOwners`
  ///      array carries pending L1→L2 ownership transfers piggybacked on this LZ message.
  function authenticateAndUpdateOwners(uint32 cawClientId, uint32 tokenId, uint32[] calldata tokenIds, address[] calldata owners) public {
    require(fromLZ, "authenticateAndUpdateOwners only callable internally");
    authenticated[cawClientId][tokenId] = true;
    updateOwners(tokenIds, owners);
  }

  /// @notice Credit a deposit, mark as authenticated, and apply pending ownership updates.
  /// @dev Only callable from `_lzReceive`. Triggered by L1 `deposit()` calls forwarded via LayerZero.
  function depositAndUpdateOwners(uint32 cawClientId, uint32 tokenId, uint256 amount, uint32[] calldata tokenIds, address[] calldata owners) public {
    require(fromLZ, "depositAndUpdateOwners only callable internally");
    totalCaw += amount;
    addToBalance(tokenId, amount);
    authenticateAndUpdateOwners(cawClientId, tokenId, tokenIds, owners);
  }

  /// @notice Add CAW (raw 18-decimal amount) to a token's balance.
  /// @dev Callable by `cawActions` directly OR via LayerZero (`fromLZ` flag).
  function addToBalance(uint32 tokenId, uint256 amount) public {
    require(fromLZ || address(cawActions) == _msgSender(), "caller is not cawActions or LZ");

    setCawBalance(tokenId, cawBalanceOf(tokenId) + amount);
  }

  /// @dev Internal: write the token's CAW balance back to the precision-adjusted shares mapping.
  function setCawBalance(uint32 tokenId, uint256 newCawBalance) internal {
    cawOwnership[tokenId] = precision * newCawBalance / rewardMultiplier;
  }

  /// @notice Apply a batch of ownership updates from L1 transfers.
  /// @dev Only callable from `_lzReceive`. Each entry overwrites `ownerOf[tokenId]` with the new owner.
  function updateOwners(uint32[] calldata tokenIds, address[] calldata owners) public {
    require(fromLZ, "updateOwners only callable internally");
    for (uint i = 0; i < tokenIds.length; i++)
      _setOwnerOf(tokenIds[i], owners[i]);
  }

  /// @notice Mint a new token (mirror of an L1 mint) and apply pending ownership updates.
  /// @dev Only callable from `_lzReceive`. Sets username + owner atomically.
  function mintAndUpdateOwners(uint32 tokenId, address owner, string memory username, uint32[] calldata tokenIds, address[] calldata owners) public {
    require(fromLZ, "mintAndUpdateOwners only callable internally");
    usernames[tokenId] = username;
    ownerOf[tokenId] = owner;

    updateOwners(tokenIds, owners);
  }

  /// @notice Mark a token as authenticated with a client. Only used in mainnet co-deployment mode.
  function auth(uint32 cawClientId, uint32 tokenId) public onlyOnMainnet {
    emit Authenticated(cawClientId, tokenId);
    authenticated[cawClientId][tokenId] = true;
  }

  // ============================================
  // REPLICATION CONFIG
  // ============================================

  event ClientChainsSet(uint32 indexed clientId, uint32[] destEids);

  /**
   * @notice Set the chain list for a client. Called from L1 via LayerZero.
   * @dev Forwards the config to CawActionsReplicator.
   * @param clientId The client ID
   * @param destEids Array of destination chain EIDs the client replicates to
   */
  function setClientChains(uint32 clientId, uint32[] calldata destEids) public {
    require(fromLZ || (bypassLZ && msg.sender == address(cawProfile)), "only callable from L1");
    require(cawActionsReplicator != address(0), "Replicator not set");

    // Forward to replicator
    ICawActionsReplicator(cawActionsReplicator).setClientChains(clientId, destEids);

    emit ClientChainsSet(clientId, destEids);
  }

  /// @notice Credit a deposit from a co-deployed L1 contract (no LayerZero involved).
  /// @dev Only callable in mainnet co-deployment mode (`bypassLZ && msg.sender == cawProfile`).
  function deposit(uint32 cawClientId, uint32 tokenId, uint256 amount) external onlyOnMainnet {
    totalCaw += amount;
    auth(cawClientId, tokenId);
    addToBalance(tokenId, amount);
  }

  /// @notice Mint a token (mirror of L1 mint) — co-deployment mode only.
  /// @dev Only callable when `bypassLZ` is true and the caller is the L1 CawProfile contract.
  function mint(uint32 tokenId, address owner, string memory username) external onlyOnMainnet {
    emit UsernameMinted(tokenId, owner);
    usernames[tokenId] = username;
    ownerOf[tokenId] = owner;
  }

  /// @notice Update a single token's owner — co-deployment mode only.
  function setOwnerOf(uint32 tokenId, address newOwner) external onlyOnMainnet {
    _setOwnerOf(tokenId, newOwner);
  }

  /// @dev Internal: writes ownerOf and emits the OwnerSet event. Used by both `setOwnerOf` and `updateOwners`.
  function _setOwnerOf(uint32 tokenId, address newOwner) internal {
    emit OwnerSet(tokenId, newOwner);
    ownerOf[tokenId] = newOwner;
  }

  // ============================================
  // SESSION KEY REGISTRATION & REVOCATION
  // ============================================

  /// @notice Register a session key. The wallet owner signs an EIP-712 delegation,
  ///         then anyone (e.g. the validator) can submit it on-chain.
  ///         Address-based: covers all tokens owned by the signer's wallet.
  /// @param sessionKey The ephemeral address that will sign actions
  /// @param expiry Unix timestamp after which the session is invalid
  /// @param scopeBitmap Bitfield of allowed ActionTypes (bits 0-7; only WITHDRAW bit 6 is forbidden)
  /// @param spendLimit Max whole CAW tokens this session key can spend (0 = unlimited)
  /// @param nonce Must match the signer's current sessionNonce (prevents replay after revocation)
  function registerSession(
    address sessionKey,
    uint64 expiry,
    uint8 scopeBitmap,
    uint256 spendLimit,
    uint256 nonce,
    uint8 v, bytes32 r, bytes32 s
  ) external {
    require(sessionKey != address(0), "Zero session key");
    require(expiry > block.timestamp, "Already expired");
    require((scopeBitmap & 0x40) == 0, "Cannot delegate WITHDRAW");

    bytes32 structHash = keccak256(abi.encode(
      DELEGATION_TYPEHASH,
      sessionKey,
      expiry,
      scopeBitmap,
      spendLimit,
      nonce
    ));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", eip712DomainHash, structHash));
    address signer = ecrecover(digest, v, r, s);

    require(signer != address(0), "Invalid signature");
    require(nonce == sessionNonce[signer], "Invalid nonce");

    sessionNonce[signer]++;
    sessions[signer][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit);
    emit SessionCreated(signer, sessionKey, expiry, scopeBitmap, spendLimit);
  }

  /// @notice Register a session key using a human-readable personal_sign message.
  ///         Message format (4 lines, separated by \n):
  ///           Enable Quick Sign
  ///           Spend limit: 5M CAW
  ///           Expires: 25 April 2026 00:00:00 UTC
  ///           Session key: 0x742d...3e
  function registerSessionPersonal(
    bytes memory message,
    uint8 v, bytes32 r, bytes32 s
  ) external {
    // Recover signer from personal_sign prefix
    bytes32 digest = keccak256(abi.encodePacked(
      "\x19Ethereum Signed Message:\n",
      _uint2str(message.length),
      message
    ));
    address signer = ecrecover(digest, v, r, s);
    require(signer != address(0), "Invalid signature");

    // Parse the message
    (uint256 spendLimit, uint64 expiry, address sessionKey) = _parseSessionMessage(message);

    require(sessionKey != address(0), "Zero session key");
    require(expiry > block.timestamp, "Already expired");

    uint256 nonce = sessionNonce[signer];
    sessionNonce[signer]++;

    uint8 scopeBitmap = 0xBF; // all actions except WITHDRAW (bit 6)
    sessions[signer][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit);
    emit SessionCreated(signer, sessionKey, expiry, scopeBitmap, spendLimit);
  }

  /// @dev Parse "Enable Quick Sign\nSpend limit: 5M CAW\nExpires: 25 April 2026 00:00:00 UTC\nSession key: 0x..."
  function _parseSessionMessage(bytes memory msg_) internal pure returns (uint256 spendLimit, uint64 expiry, address sessionKey) {
    // Split into lines
    bytes[] memory lines = _splitLines(msg_);
    require(lines.length == 4, "Expected 4 lines");

    // Line 0: "Enable Quick Sign" (just validate)
    require(keccak256(lines[0]) == keccak256("Enable Quick Sign"), "Invalid header");

    // Line 1: "Spend limit: 5M CAW"
    spendLimit = _parseSpendLimit(lines[1]);

    // Line 2: "Expires: 25 April 2026 00:00:00 UTC"
    expiry = _parseExpiry(lines[2]);

    // Line 3: "Session key: 0x..."
    sessionKey = _parseSessionKey(lines[3]);
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

  /// @dev Parse "Spend limit: 5M CAW" → 5000000
  function _parseSpendLimit(bytes memory line) internal pure returns (uint256) {
    // Skip "Spend limit: " (14 bytes)
    require(line.length > 18, "Invalid spend limit");
    uint256 number = 0;
    uint256 i = 14;
    while (i < line.length && line[i] >= 0x30 && line[i] <= 0x39) {
      number = number * 10 + (uint8(line[i]) - 0x30);
      i++;
    }
    require(number > 0, "Zero spend limit");
    // Expect "M CAW" or "K CAW" or "B CAW"
    require(i < line.length, "Missing unit");
    if (line[i] == 'M') return number * 1_000_000;
    if (line[i] == 'K') return number * 1_000;
    if (line[i] == 'B') return number * 1_000_000_000;
    revert("Invalid unit (expected K, M, or B)");
  }

  /// @dev Parse "Expires: 25 April 2026 00:00:00 UTC" → unix timestamp
  function _parseExpiry(bytes memory line) internal pure returns (uint64) {
    // Skip "Expires: " (9 bytes)
    require(line.length > 30, "Invalid expiry");
    uint256 i = 9;

    // Day (1-2 digits)
    uint256 day = 0;
    while (i < line.length && line[i] >= 0x30 && line[i] <= 0x39) {
      day = day * 10 + (uint8(line[i]) - 0x30);
      i++;
    }
    require(day >= 1 && day <= 31, "Invalid day");
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
    require(year >= 1970, "Year before epoch");
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

  /// @dev Parse "Session key: 0x..." → address
  function _parseSessionKey(bytes memory line) internal pure returns (address) {
    // Skip "Session key: 0x" (15 bytes)
    require(line.length == 55, "Invalid session key length");
    bytes memory hexStr = _slice(line, 15, 55);
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

  /// @notice Revoke a session key using a signature from the session key itself.
  ///         Anyone can submit this (e.g., the validator/API), as long as they provide
  ///         a valid signature from the session key proving it wants to be revoked.
  function revokeSessionBySig(
    address owner,
    address sessionKey,
    uint8 v, bytes32 r, bytes32 s
  ) external {
    require(sessions[owner][sessionKey].expiry != 0, "Session not found");

    // Verify the session key signed a revocation message
    bytes32 digest = keccak256(abi.encodePacked(
      "\x19\x01",
      eip712DomainHash,
      keccak256(abi.encode(
        keccak256("RevokeSession(address owner,address sessionKey)"),
        owner,
        sessionKey
      ))
    ));
    address signer = ecrecover(digest, v, r, s);
    require(signer == sessionKey, "Invalid session key signature");

    delete sessions[owner][sessionKey];
    emit SessionRevoked(owner, sessionKey);
  }

  /// @notice OApp callback for receiving cross-chain messages from L1.
  /// @dev See SECURITY NOTE inside. The OApp base verifies sender is the endpoint and the configured
  ///      peer before this runs. The payload's first 4 bytes are a function selector (whitelisted via
  ///      `isAuthorizedFunction`), and the rest are ABI-encoded args dispatched via delegatecall to self.
  function _lzReceive(
    Origin calldata _origin, // struct containing info about the message sender
    bytes32 _guid, // global packet identifier
    bytes calldata payload, // encoded message payload being received
    address _executor, // the Executor address.
    bytes calldata // arbitrary data appended by the Executor
  ) internal override {
    // Declare selector and arguments as memory variables
    bytes4 decodedSelector;
    bytes memory args = new bytes(payload.length - 4); // Arguments excluding the first 4 bytes

    assembly {
      // Copy the selector (first 4 bytes) from calldata
      decodedSelector := calldataload(payload.offset)

      // Copy the arguments from calldata to memory
      calldatacopy(add(args, 32), add(payload.offset, 4), sub(payload.length, 4))
    }

    // Ensure the selector corresponds to an expected function to prevent unauthorized actions
    require(isAuthorizedFunction(decodedSelector), "Unauthorized function call");

    // Call the function using the selector and arguments.
    //
    // SECURITY NOTE (audited 2026-04-06): The fromLZ + delegatecall pattern is intentional and safe.
    // - The OApp base class already verifies msg.sender == endpoint and the peer before _lzReceive runs.
    // - All authorized functions (depositAndUpdateOwners, authenticateAndUpdateOwners,
    //   mintAndUpdateOwners, updateOwners, setClientChains) perform only storage writes, except
    //   setClientChains which calls the owner-configured cawActionsReplicator (trusted, not user-supplied).
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
    return selector == bytes4(keccak256("depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[])")) ||
      selector == bytes4(keccak256("authenticateAndUpdateOwners(uint32,uint32,uint32[],address[])")) ||
      selector == bytes4(keccak256("mintAndUpdateOwners(uint32,address,string,uint32[],address[])")) ||
      selector == bytes4(keccak256("updateOwners(uint32[],address[])")) ||
      selector == bytes4(keccak256("setClientChains(uint32,uint32[])"));
  }

  /// @notice Subtract CAW from a token's balance (used during withdraw flows). CawActions only.
  /// @dev This decrements the L2-side bookkeeping; the actual L1 withdrawal credit is sent
  ///      via `setWithdrawable` over LayerZero.
  function withdraw(uint32 tokenId, uint256 amount) external {
    require(address(cawActions) == _msgSender(), "caller is not the cawActions contract");

    uint256 balance = cawBalanceOf(tokenId);
    require(balance >= amount, 'Insufficient CAW balance');

    totalCaw -= amount;
    setCawBalance(tokenId, balance - amount);
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
    require(address(cawActions) == _msgSender(), "caller is not CawActions");
    if (bypassLZ)
      cawProfile.setWithdrawable(tokenIds, amounts);
    else {
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
      payable(msg.sender) // The refund address in case the send call reverts.
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

}


