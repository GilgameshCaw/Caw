// contracts/CawName.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ICawActions.sol";
import "./CawNameURI.sol";
import "./CawName.sol";

interface ICawActionsReplicator {
  function setClientChains(uint32 clientId, uint32[] calldata destEids) external;
}

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawNameL2 is 
  Context,
  Ownable,
  OApp
{
  using OptionsBuilder for bytes;

  modifier onlyOnMainnet() {
    require(bypassLZ && msg.sender == address(cawName), "only callable on the mainnet, from mainnet CawName");
    _;
  }

  uint256 public totalCaw;

  ICawActions public cawActions;

  /// @notice The CawActionsReplicator contract for forwarding replication config
  address public cawActionsReplicator;

  // In a normal ERC271, ownerOf reverts if there is no owner,
  // here, since it's not a real ERC721, just a pretender,
  // we return the zero addres.
  mapping(uint256 => address) public ownerOf;
  mapping(uint32 => string) public usernames;

  // Keeping track of clients to which the user has authenticated
  mapping(uint32 => mapping(uint32 => bool)) public authenticated;

  mapping(uint32 => uint256) public cawOwnership;

  uint256 public rewardMultiplier = 10**18;
  uint256 public precision = 30425026352721 ** 2;

  uint32 public immutable layer1EndpointId;

  bool private fromLZ;

  bool public bypassLZ;
  CawName public cawName;

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

  bytes32 public immutable eip712DomainHash;

  bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  );

  bytes32 private constant DELEGATION_TYPEHASH = keccak256(
    "SessionDelegation(address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit)"
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

  constructor(uint32 _endpointId, address _endpoint)
    OApp(_endpoint, msg.sender)
  {
    layer1EndpointId = _endpointId;
    eip712DomainHash = generateDomainHash();
  }

  function generateDomainHash() public view returns (bytes32) {
    return keccak256(
      abi.encode(
        EIP712_DOMAIN_TYPEHASH,
        keccak256(bytes("CawNameL2")),
        keccak256(bytes("1")),
        block.chainid,
        address(this)
      )
    );
  }

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

  function setL1Peer(uint32 _eid, address payable peer, bool _bypassLZ) external onlyOwner {
    if (_bypassLZ) {
      bypassLZ = true;
      cawName = CawName(peer);
    } else setPeer(_eid, bytes32(uint256(uint160(address(peer)))));
  }

  function setCawActions(address _cawActions) external onlyOwner {
    cawActions = ICawActions(_cawActions);
    emit CawActionsSet(_cawActions);
  }

  function setCawActionsReplicator(address _replicator) external onlyOwner {
    cawActionsReplicator = _replicator;
    emit CawActionsReplicatorSet(_replicator);
  }

  function cawBalanceOf(uint32 tokenId) public view returns (uint256){
    return cawOwnership[tokenId] * rewardMultiplier / (precision);
  }

  function spendDistributeAndAddTokensToBalance(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute, uint32 recipientId, uint256 recipientAmount) external {
    spendAndDistribute(tokenId, amountToSpend * 10**18, amountToDistribute * 10**18);
    addToBalance(recipientId, recipientAmount * 10**18);
  }

  function spendAndDistributeTokens(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) external {
    spendAndDistribute(tokenId, amountToSpend * 10**18, amountToDistribute * 10**18);
  }

  function spendAndDistribute(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) public {
    require(address(cawActions) == _msgSender(), "caller is not the cawActions contract");
    uint256 balance = cawBalanceOf(tokenId);

    require(balance >= amountToSpend, 'Insufficient CAW balance');
    uint256 newCawBalance = balance - amountToSpend;

    if (totalCaw > balance)
      rewardMultiplier += rewardMultiplier * amountToDistribute / (totalCaw - balance);
    else newCawBalance += amountToDistribute;

    setCawBalance(tokenId, newCawBalance);
  }

  function addTokensToBalance(uint32 tokenId, uint256 amount) external {
    addToBalance(tokenId, amount * 10**18);
  }

  function authenticateAndUpdateOwners(uint32 cawClientId, uint32 tokenId, uint32[] calldata tokenIds, address[] calldata owners) public {
    require(fromLZ, "authenticateAndUpdateOwners only callable internally");
    authenticated[cawClientId][tokenId] = true;
    updateOwners(tokenIds, owners);
  }

  function depositAndUpdateOwners(uint32 cawClientId, uint32 tokenId, uint256 amount, uint32[] calldata tokenIds, address[] calldata owners) public {
    require(fromLZ, "depositAndUpdateOwners only callable internally");
    totalCaw += amount;
    addToBalance(tokenId, amount);
    authenticateAndUpdateOwners(cawClientId, tokenId, tokenIds, owners);
  }

  function addToBalance(uint32 tokenId, uint256 amount) public {
    require(fromLZ || address(cawActions) == _msgSender(), "caller is not cawActions or LZ");

    setCawBalance(tokenId, cawBalanceOf(tokenId) + amount);
  }

  function setCawBalance(uint32 tokenId, uint256 newCawBalance) internal {
    cawOwnership[tokenId] = precision * newCawBalance / rewardMultiplier;
  }

  function updateOwners(uint32[] calldata tokenIds, address[] calldata owners) public {
    require(fromLZ, "updateOwners only callable internally");
    for (uint i = 0; i < tokenIds.length; i++)
      _setOwnerOf(tokenIds[i], owners[i]);
  }

  function mintAndUpdateOwners(uint32 tokenId, address owner, string memory username, uint32[] calldata tokenIds, address[] calldata owners) public {
    require(fromLZ, "mintAndUpdateOwners only callable internally");
    usernames[tokenId] = username;
    ownerOf[tokenId] = owner;

    updateOwners(tokenIds, owners);
  }

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
    require(fromLZ || (bypassLZ && msg.sender == address(cawName)), "only callable from L1");
    require(cawActionsReplicator != address(0), "Replicator not set");

    // Forward to replicator
    ICawActionsReplicator(cawActionsReplicator).setClientChains(clientId, destEids);

    emit ClientChainsSet(clientId, destEids);
  }

  function deposit(uint32 cawClientId, uint32 tokenId, uint256 amount) external onlyOnMainnet {
    totalCaw += amount;
    auth(cawClientId, tokenId);
    addToBalance(tokenId, amount);
  }

  function mint(uint32 tokenId, address owner, string memory username) external onlyOnMainnet {
    emit UsernameMinted(tokenId, owner);
    usernames[tokenId] = username;
    ownerOf[tokenId] = owner;
  }

  function setOwnerOf(uint32 tokenId, address newOwner) external onlyOnMainnet {
    _setOwnerOf(tokenId, newOwner);
  }

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
  /// @param scopeBitmap Bitfield of allowed ActionTypes (bits 0-5 only; WITHDRAW and OTHER forbidden)
  /// @param spendLimit Max whole CAW tokens this session key can spend (0 = unlimited)
  function registerSession(
    address sessionKey,
    uint64 expiry,
    uint8 scopeBitmap,
    uint256 spendLimit,
    uint8 v, bytes32 r, bytes32 s
  ) external {
    require(sessionKey != address(0), "Zero session key");
    require(expiry > block.timestamp, "Already expired");
    require((scopeBitmap & 0xC0) == 0, "Cannot delegate WITHDRAW or OTHER");

    bytes32 structHash = keccak256(abi.encode(
      DELEGATION_TYPEHASH,
      sessionKey,
      expiry,
      scopeBitmap,
      spendLimit
    ));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", eip712DomainHash, structHash));
    address signer = ecrecover(digest, v, r, s);

    require(signer != address(0), "Invalid signature");

    sessions[signer][sessionKey] = StoredSession(expiry, scopeBitmap, spendLimit);
    emit SessionCreated(signer, sessionKey, expiry, scopeBitmap, spendLimit);
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

    // Call the function using the selector and arguments
    // (bool success, bytes memory returnData) = address(this).delegatecall(abi.encode(decodedSelector, args));
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

  // Whitelist of selectors allowed via delegatecall from LayerZero messages.
  // Security: verified that no authorized selector collides with any inherited
  // function from OApp, Ownable, or Context.
  function isAuthorizedFunction(bytes4 selector) private pure returns (bool) {
    return selector == bytes4(keccak256("depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[])")) ||
      selector == bytes4(keccak256("authenticateAndUpdateOwners(uint32,uint32,uint32[],address[])")) ||
      selector == bytes4(keccak256("mintAndUpdateOwners(uint32,address,string,uint32[],address[])")) ||
      selector == bytes4(keccak256("updateOwners(uint32[],address[])")) ||
      selector == bytes4(keccak256("setClientChains(uint32,uint32[])"));
  }

  function withdraw(uint32 tokenId, uint256 amount) external {
    require(address(cawActions) == _msgSender(), "caller is not the cawActions contract");

    uint256 balance = cawBalanceOf(tokenId);
    require(balance >= amount, 'Insufficient CAW balance');

    totalCaw -= amount;
    setCawBalance(tokenId, balance - amount);
  }

  function setWithdrawable(uint32[] memory tokenIds, uint256[] memory amounts, uint256 lzTokenAmount) external payable {
    require(address(cawActions) == _msgSender(), "caller is not CawActions");
    if (bypassLZ)
      cawName.setWithdrawable(tokenIds, amounts);
    else {
      bytes memory payload = abi.encodeWithSelector(setWithdrawableSelector, tokenIds, amounts);
      lzSend(setWithdrawableSelector, payload, lzTokenAmount);
    }
  }

  function withdrawQuote(uint32[] memory tokenIds, uint256[] memory amounts, bool payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory payload = abi.encodeWithSelector(
      setWithdrawableSelector, tokenIds, amounts
    ); return lzQuote(setWithdrawableSelector, payload, payInLzToken);
  }

  function lzQuote(bytes4 selector, bytes memory payload, bool _payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector), 0);
    return _quote(layer1EndpointId, payload, _options, _payInLzToken);
  }

  // Will use to send withdrawable amount to L1
  function lzSend(bytes4 selector, bytes memory payload, uint256 lzTokenAmount) internal {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector), 0);

    _lzSend(
      layer1EndpointId, // Destination chain's endpoint ID.
      payload, // Encoded message payload being sent.
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(msg.value, lzTokenAmount), // Fee struct containing native gas and ZRO token.
      payable(msg.sender) // The refund address in case the send call reverts.
    );
  }

  // TODO:
  // TODO:
  // TODO:
  // TODO:
  // TODO:
  // Find real values for these:
  function gasLimitFor(bytes4 selector) public view returns (uint128) {
    if (selector == setWithdrawableSelector)
      return 300000;
    else revert('unexpected selector');
  }

}


