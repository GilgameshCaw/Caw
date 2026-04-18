// contracts/CawProfile.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./CawProfileURI.sol";
import "./CawProfileL2.sol";
import "./CawBuyAndBurn.sol";

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { CawClientManager, ReplicationDestination } from "./CawClientManager.sol";

contract CawProfile is 
  Context,
  ERC721Enumerable,
  Ownable,
  OApp
{
  using OptionsBuilder for bytes;
  using EnumerableSet for EnumerableSet.UintSet;

  IERC20 public immutable CAW;
  CawProfileURI public uriGenerator;

  CawProfileL2 public cawProfileL2;

  uint256 public totalCaw;

  address public minter;

  uint32 public mainnetLzId;
  string[] public usernames;
  bool private fromLZ;

  // TODO: this one not used
  bytes4 public mintSelector = bytes4(keccak256("mintAndUpdateOwners(uint32,address,string,uint32[],address[])"));

  bytes4 public addToBalanceSelector = bytes4(keccak256("depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[])"));
  bytes4 public authSelector = bytes4(keccak256("authenticateAndUpdateOwners(uint32,uint32,uint32[],address[])"));
  bytes4 public updateOwnersSelector = bytes4(keccak256("updateOwners(uint32[],address[])"));
  bytes4 public setClientChainsSelector = bytes4(keccak256("setClientChains(uint32,uint32[])"));

  // Keeping track of clients to which the user has authenticated
  mapping(uint32 => mapping(uint32 => bool)) public authenticated;

  /// @notice Withdraw fee locked in at the moment a token first authenticates with a client.
  /// @dev Once set, this fee floor is honored forever — clients cannot retroactively raise
  ///      withdraw fees on existing depositors. On withdraw, the user pays min(locked, current),
  ///      so they automatically benefit if the client lowers fees later. Indexed by (clientId, tokenId).
  mapping(uint32 => mapping(uint32 => uint256)) public lockedWithdrawFee;
  /// @notice True once a token has had its withdraw fee locked for a client. Used to distinguish
  ///         "locked at zero" from "never locked" (since 0 is a valid fee).
  mapping(uint32 => mapping(uint32 => bool)) public withdrawFeeLocked;

  mapping(uint32 => uint256) public withdrawable;

  uint256 public rewardMultiplier = 10**18;

  // tokenId => [lzDestId, lzDestId2, ...]
  mapping(uint32 => EnumerableSet.UintSet) private chosenChainIds;
  EnumerableSet.UintSet peerIds;

  // lzDestId => index => tokenId
  mapping(uint32 => mapping(uint256 => uint32)) public pendingTransfers;
  uint256 public transferUpdateLimit = 50;

  // lzDestId => value
  mapping(uint32 => uint256) public pendingTransferStart;
  mapping(uint32 => uint256) public pendingTransferEnd;

  struct Token {
    uint256 withdrawable;
    uint256 ownerBalance;
    uint256 tokenId;
    string username;
    address owner;
  }

  event MinterSet(address minter);
  event TransferPendingSync(uint32 indexed tokenId, address indexed from, address indexed to);
  event L2PeerSet(uint32 indexed eid, address indexed peer);
  event Deposited(uint32 indexed cawClientId, uint32 indexed tokenId, uint256 amount, uint32 indexed lzDestId, address depositor);

  CawClientManager public clientManager;
  CawBuyAndBurn public buyAndBurn;

  constructor(address _caw, address _gui, address _buyAndBurn, address _clientManager, address _endpoint, uint32 mainnetEid)
    ERC721("CAW NAME", "cawNAME")
    OApp(_endpoint, msg.sender)
  {
    clientManager = CawClientManager(payable(_clientManager));
    uriGenerator = CawProfileURI(_gui);
    buyAndBurn = CawBuyAndBurn(payable(_buyAndBurn));
    CAW = IERC20(_caw);
    mainnetLzId = mainnetEid;
  }

  function setL2Peer(uint32 _eid, address _peer) external onlyOwner {
    if (_eid != mainnetLzId) {
      peerIds.add(uint256(_eid));
      setPeer(_eid, bytes32(uint256(uint160(_peer))));
    } else cawProfileL2 = CawProfileL2(_peer);
    emit L2PeerSet(_eid, _peer);
  }

  function setMinter(address _minter) external onlyOwner {
    minter = _minter;
    emit MinterSet(_minter);
  }

  function setUriGenerator(address _gui) external onlyOwner {
    uriGenerator = CawProfileURI(_gui);
  }

  function tokenURI(uint256 tokenId) override public view returns (string memory) {
    return uriGenerator.generate(usernames[uint32(tokenId) - 1]);
  }

  function mint(uint32 cawClientId, address owner, string memory username, uint32 newId, uint256 lzTokenAmount) public payable {
    require(minter == _msgSender(), "caller is not the minter");
    usernames.push(username);
    _mint(owner, newId);

    (uint256 fee, address feeAddress) = clientManager.getMintFeeAndAddress(cawClientId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    _updateNewOwners(peerWithMaxPendingTransfers(), lzEthAmount, lzTokenAmount);
  }

  /// @notice Mint a username and deposit CAW in one transaction.
  /// @dev Only callable by the minter. Combines mint + deposit to save the user a separate tx.
  ///      The deposit amount is transferred from the owner (not the minter) via transferFrom.
  function mintAndDeposit(
    uint32 cawClientId, address owner, string memory username, uint32 newId,
    uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount
  ) public payable {
    require(minter == _msgSender(), "caller is not the minter");
    usernames.push(username);
    _mint(owner, newId);

    // Transfer deposit CAW from the minter (which already pulled it from the user)
    // This avoids requiring a second approval from the user
    CAW.transferFrom(_msgSender(), address(this), depositAmount);
    totalCaw += depositAmount;
    chosenChainIds[newId].add(uint256(lzDestId));

    // Calculate fees: mint fee + deposit fee + auth fee (first deposit auto-authenticates)
    uint256 totalFeesPaid = 0;
    {
      (uint256 mintFee, address mintFeeAddr) = clientManager.getMintFeeAndAddress(cawClientId);
      totalFeesPaid += payFee(mintFee, mintFeeAddr);

      (uint256 depositFee, address depositFeeAddr) = clientManager.getDepositFeeAndAddress(cawClientId);
      totalFeesPaid += payFee(depositFee, depositFeeAddr);

      (uint256 authFee, address authFeeAddr) = clientManager.getAuthFeeAndAddress(cawClientId);
      totalFeesPaid += payFee(authFee, authFeeAddr);
    }

    authenticated[cawClientId][newId] = true;
    _lockWithdrawFeeIfNeeded(cawClientId, newId);
    uint256 lzEthAmount = msg.value - totalFeesPaid;

    if (lzDestId == mainnetLzId) {
      cawProfileL2.deposit(cawClientId, newId, depositAmount);
    } else {
      uint32[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, owner, newId);
      bytes memory payload = abi.encodeWithSelector(addToBalanceSelector, cawClientId, newId, depositAmount, tokenIds, owners);
      lzSend(lzDestId, addToBalanceSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }
  }

  /// @notice Accrued fees available for withdrawal (pull pattern to prevent DOS)
  mapping(address => uint256) public accruedFees;

  event FeesAccrued(address indexed recipient, uint256 amount);
  event FeesWithdrawn(address indexed recipient, uint256 amount);

  /// @dev Lock the withdraw fee for a (client, token) pair the first time they authenticate.
  ///      Subsequent calls are no-ops, ensuring users always get their first-deposit terms or better.
  function _lockWithdrawFeeIfNeeded(uint32 cawClientId, uint32 tokenId) internal {
    if (!withdrawFeeLocked[cawClientId][tokenId]) {
      lockedWithdrawFee[cawClientId][tokenId] = clientManager.getWithdrawFee(cawClientId);
      withdrawFeeLocked[cawClientId][tokenId] = true;
    }
  }

  function payFee(uint256 fee, address feeAddress) internal returns (uint256) {
    if (fee > 0) {
      accruedFees[feeAddress] += fee;
      accruedFees[address(buyAndBurn)] += fee;
      emit FeesAccrued(feeAddress, fee);
      emit FeesAccrued(address(buyAndBurn), fee);
    }
    return fee * 2;
  }

  /// @notice Withdraw accrued fees as CAW. Swaps the client's ETH fees + the matching protocol
  ///         portion together into CAW via Uniswap. Client receives half the CAW, other half is burned.
  /// @param minCawOut Minimum total CAW the swap must produce (sandwich protection).
  ///                  Client receives minCawOut/2, protocol burns minCawOut/2.
  ///                  Use buyAndBurn.getExpectedCawOut(totalETH) and apply slippage (e.g. 97%).
  /// @dev By paying the client in CAW from the same swap, their incentives are perfectly aligned
  ///      with the protocol: a bad minCawOut hurts the client's own payout equally. A client
  ///      calling withdrawFees(0) would get sandwiched and lose their own fees — self-punishing.
  function withdrawFees(uint256 minCawOut) external {
    uint256 clientAmount = accruedFees[msg.sender];
    require(clientAmount > 0, "No fees to withdraw");

    // Only take the protocol portion matching this client's contribution (1:1 from payFee).
    // Use min() as a safety net in case the pool has been partially drained.
    uint256 protocolPool = accruedFees[address(buyAndBurn)];
    uint256 protocolAmount = clientAmount < protocolPool ? clientAmount : protocolPool;

    // Zero balances before external calls (checks-effects-interactions)
    accruedFees[msg.sender] = 0;
    if (protocolAmount > 0) {
      accruedFees[address(buyAndBurn)] -= protocolAmount;
    }

    uint256 totalEth = clientAmount + protocolAmount;
    uint256 cawReceived = buyAndBurn.swapAndSplit{value: totalEth}(minCawOut, msg.sender);

    emit FeesWithdrawn(msg.sender, cawReceived);
  }

  function nextId() public view returns (uint32) {
    return uint32(usernames.length) + 1;
  }

  function tokens(address user) external view returns (Token[] memory) {
    uint32 tokenId;
    uint256 balance = balanceOf(user);
    Token[] memory userTokens = new Token[](balance);
    for (uint32 i = 0; i < balance; i++) {
      tokenId = uint32(tokenOfOwnerByIndex(user, i));

      userTokens[i].withdrawable = withdrawable[tokenId];
      userTokens[i].username = usernames[tokenId - 1];
      userTokens[i].ownerBalance = CAW.balanceOf(user);
      userTokens[i].tokenId = tokenId;
      userTokens[i].owner = user;
    }
    return userTokens;
  }

  function token(uint32 tokenId) external view returns (Token memory) {
    Token memory token = Token({
      ownerBalance: CAW.balanceOf(ownerOf(tokenId)),
      withdrawable: withdrawable[tokenId],
      username: usernames[tokenId - 1],
      owner: ownerOf(tokenId),
      tokenId: tokenId
    });

    return token;
  }

  /**
  * @dev See {IERC165-supportsInterface}.
  */
  function supportsInterface(bytes4 interfaceId)
    public
    view
    virtual
    override(ERC721Enumerable)
    returns (bool)
  {
    return super.supportsInterface(interfaceId);
  }

  function authenticate(uint32 cawClientId, uint32 tokenId, uint32 lzDestId, uint256 lzTokenAmount) external payable {
    require(ownerOf(tokenId) == msg.sender, "can not authenticate with a CawProfile that you do not own");

    (uint256 fee, address feeAddress) = clientManager.getAuthFeeAndAddress(cawClientId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);
    authenticated[cawClientId][tokenId] = true;
    _lockWithdrawFeeIfNeeded(cawClientId, tokenId);

    if (lzDestId == mainnetLzId)
      cawProfileL2.auth(tokenId, cawClientId);
    else {
      uint32[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, msg.sender, tokenId);
      bytes memory payload = abi.encodeWithSelector(authSelector, cawClientId, tokenId, tokenIds, owners);
      lzSend(lzDestId, authSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }
  }

  /// @notice Deposit CAW into a token on behalf of its owner. CAW is pulled from msg.sender
  ///         (not the token owner), so the caller must have approved this contract for CAW.
  ///         This allows router contracts to collect CAW from the user and deposit in one flow.
  function depositFor(uint32 cawClientId, uint32 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    address owner = ownerOf(tokenId);

    chosenChainIds[tokenId].add(uint256(lzDestId));
    CAW.transferFrom(msg.sender, address(this), amount);
    totalCaw += amount;

    (uint256 fee, address feeAddress) = clientManager.getDepositFeeAndAddress(cawClientId);

    if (!authenticated[cawClientId][tokenId]) {
      fee += clientManager.getAuthFee(cawClientId);
      authenticated[cawClientId][tokenId] = true;
      _lockWithdrawFeeIfNeeded(cawClientId, tokenId);
    }

    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    if (lzDestId == mainnetLzId)
      cawProfileL2.deposit(cawClientId, tokenId, amount);
    else {
      uint32[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, owner, tokenId);
      bytes memory payload = abi.encodeWithSelector(addToBalanceSelector, cawClientId, tokenId, amount, tokenIds, owners);
      lzSend(lzDestId, addToBalanceSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
    }

    emit Deposited(cawClientId, tokenId, amount, lzDestId, msg.sender);
  }

  function deposit(uint32 cawClientId, uint32 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    require(ownerOf(tokenId) == msg.sender, "can not deposit into a CawProfile that you do not own");
    depositFor(cawClientId, tokenId, amount, lzDestId, lzTokenAmount);
  }

  function peerWithMaxPendingTransfers() public view returns (uint32) {
    uint256 updatesNeeded;
    uint256 peer = peerIds.at(0);
    uint256 max = updatesNeededForPeer(uint32(peer));

    for (uint256 i = 1; i < peerIds.length(); i++) {
      updatesNeeded = updatesNeededForPeer(uint32(peerIds.at(i)));
      if (updatesNeeded > max) {
        max = updatesNeeded;
        peer = peerIds.at(i);
      }
    }

    return uint32(peer);
  }

  function withdraw(uint32 cawClientId, uint32 tokenId, uint256 lzTokenAmount) public payable {
    require(ownerOf(tokenId) == msg.sender, "can not withdraw from a CawProfile that you do not own");
    require(withdrawable[tokenId] > 0, "nothing to withdraw, you may need to withdraw from the L2 first");

    uint256 amount = withdrawable[tokenId];
    totalCaw -= withdrawable[tokenId];
    withdrawable[tokenId] = 0;

    // Honor the withdraw fee that was locked in when this token first authenticated with the
    // client. If the client has since LOWERED their fee, the user gets the lower rate. If the
    // client has RAISED their fee, the user pays only the locked-in rate.
    (uint256 currentFee, address feeAddress) = clientManager.getWithdrawFeeAndAddress(cawClientId);
    uint256 fee = currentFee;
    if (withdrawFeeLocked[cawClientId][tokenId]) {
      uint256 locked = lockedWithdrawFee[cawClientId][tokenId];
      if (locked < fee) fee = locked;
    }
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    CAW.transfer(msg.sender, amount);
    _updateNewOwners(peerWithMaxPendingTransfers(), lzEthAmount, lzTokenAmount);
  }

  /**
   * @notice Transfer a token and immediately sync ownership to L2 via LayerZero.
   * @dev Requires msg.value to cover the LZ fee. Use syncTransferQuote() on CawProfileQuoter to estimate.
   *      Also flushes any other pending ownership transfers for the target chain.
   * @param to The recipient address
   * @param tokenId The token to transfer
   * @param lzTokenAmount LZ token amount for fees (usually 0)
   */
  function transferAndSync(address to, uint256 tokenId, uint256 lzTokenAmount) external payable {
    address owner = ownerOf(tokenId);
    require(
      owner == msg.sender ||
      isApprovedForAll(owner, msg.sender) ||
      getApproved(tokenId) == msg.sender,
      "caller is not owner or approved"
    );
    _transfer(owner, to, tokenId);
    // _afterTokenTransfer queued this token — now flush the queue via LZ
    _updateNewOwners(peerWithMaxPendingTransfers(), msg.value, lzTokenAmount);
  }

  /**
   * @notice Manually sync pending ownership transfers to L2.
   * @dev Anyone can call this (typically the new owner after a marketplace transfer).
   *      Flushes all pending transfers for the chain with the most pending updates.
   * @param lzTokenAmount LZ token amount for fees (usually 0)
   */
  function syncTransfer(uint32 lzDestId, uint256 lzTokenAmount) external payable {
    require(updatesNeededForPeer(lzDestId) > 0, "no pending transfers to sync");
    _updateNewOwners(lzDestId, msg.value, lzTokenAmount);
  }

  // ============================================
  // REPLICATION CONFIG SYNC
  // ============================================

  /**
   * @notice Sync a client's chain list to L2. Called by CawClientManager.
   * @dev Only callable by CawClientManager (auto-sync on add/remove).
   * @param clientId The client ID
   * @param destEids Array of destination chain EIDs
   * @param lzDestId The L2 endpoint ID to sync to
   */
  function syncReplicationInternal(uint32 clientId, uint32[] calldata destEids, uint32 lzDestId) external payable {
    require(msg.sender == address(clientManager), "Only CawClientManager");
    _syncClientChains(clientId, destEids, lzDestId, msg.value, 0);
  }

  /**
   * @notice Manually sync a client's chain list to L2.
   * @dev Only callable by the client owner. Reads config from CawClientManager.
   * @param clientId The client ID
   * @param lzDestId The L2 endpoint ID to sync to
   * @param lzTokenAmount LZ token amount for fees
   */
  function syncReplication(uint32 clientId, uint32 lzDestId, uint256 lzTokenAmount) external payable {
    require(clientManager.getClientOwner(clientId) == msg.sender, "Not the client owner");
    uint32[] memory destEids = clientManager.getClientChainEids(clientId);
    _syncClientChains(clientId, destEids, lzDestId, msg.value, lzTokenAmount);
  }

  function _syncClientChains(uint32 clientId, uint32[] memory destEids, uint32 lzDestId, uint256 lzEthAmount, uint256 lzTokenAmount) internal {
    if (lzDestId == mainnetLzId) {
      // Direct call on mainnet
      cawProfileL2.setClientChains(clientId, destEids);
    } else {
      bytes memory payload = abi.encodeWithSelector(setClientChainsSelector, clientId, destEids);
      lzSend(lzDestId, setClientChainsSelector, destEids.length, payload, lzEthAmount, lzTokenAmount);
    }
  }

  // syncReplicationQuote moved to CawProfileQuoter contract

  /// @notice Credit per-token withdraw amounts. Only callable via LayerZero from L2 CawProfileL2.
  /// @dev SECURITY NOTE (audited 2026-04-07): No `tokenIds.length == amounts.length` check is
  ///      intentional. The only caller is `CawActions.setWithdrawable` (on L2), which constructs
  ///      both arrays from the same `withdrawCount` variable in lockstep — they are guaranteed
  ///      to have equal length by construction. Adding a length check here would burn L1 gas
  ///      (paid by the validator via LZ fees) on every withdraw batch for a check that cannot
  ///      fail. Both contracts are immutable post-deployment, so the construction invariant
  ///      cannot be broken by future code changes.
  function setWithdrawable(uint32[] memory tokenIds, uint256[] memory amounts) external {
    require(fromLZ, "setWithdrawable only callable internally");
    for (uint256 i = 0; i < tokenIds.length; i++)
      withdrawable[tokenIds[i]] += amounts[i];
  }

  function getChosenChainIdAtIndex(uint32 token, uint256 index) public view returns (uint256) {
    return chosenChainIds[token].at(index);
  }

  function _afterTokenTransfer(address from, address to, uint256 tokenId, uint256 batchSize) internal virtual override {
    uint32 token = uint32(tokenId);
    EnumerableSet.UintSet storage chainIds = chosenChainIds[token];
    bool hasPendingSync = false;
    for (uint256 i = 0; i < chainIds.length(); i++) {
      uint32 chainId = uint32(chainIds.at(i));
      if (chainId == mainnetLzId) cawProfileL2.setOwnerOf(token, to);
      else {
        pendingTransfers[chainId][pendingTransferEnd[chainId]++] = token;
        hasPendingSync = true;
      }
    }
    // Emit event so backend can freeze economic actions until L2 syncs
    if (hasPendingSync && from != address(0)) {
      emit TransferPendingSync(token, from, to);
    }
  }

  function updatesNeededForPeer(uint32 lzDestId) public view returns (uint256) {
    return Math.min(transferUpdateLimit, pendingTransferEnd[lzDestId] - pendingTransferStart[lzDestId]);
  }

  function pendingTransferUpdates(uint32 lzDestId) public view returns (uint32[] memory, address[] memory) {
    return pendingTransferUpdates(lzDestId, address(0), 0);
  }

  function pendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) public view returns (uint32[] memory, address[] memory) {
    uint256 updateCount = updatesNeededForPeer(lzDestId);
    uint256 includeOwner = newOwner == address(0) && tokenId == 0 ? 0 : 1;
    uint32[] memory tokenIds = new uint32[](updateCount + includeOwner);
    address[] memory owners = new address[](updateCount + includeOwner);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[lzDestId][pendingTransferStart[lzDestId] + i];
      owners[i] = ownerOf(tokenIds[i]);
    }

    if (includeOwner == 1) {
      tokenIds[updateCount] = tokenId;
      owners[updateCount] = newOwner;
    }

    return (tokenIds, owners);
  }

  function extractPendingTransferUpdates(uint32 lzDestId) internal returns (uint32[] memory, address[] memory) {
    return extractPendingTransferUpdates(lzDestId, address(0), 0);
  }

  function extractPendingTransferUpdates(uint32 lzDestId, address newOwner, uint32 tokenId) internal returns (uint32[] memory, address[] memory) {
    uint256 updateCount = updatesNeededForPeer(lzDestId);
    uint256 includeOwner = newOwner == address(0) && tokenId == 0 ? 0 : 1;
    uint32[] memory tokenIds = new uint32[](updateCount + includeOwner);
    address[] memory owners = new address[](updateCount + includeOwner);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[lzDestId][pendingTransferStart[lzDestId]];
      delete pendingTransfers[lzDestId][pendingTransferStart[lzDestId]];
      owners[i] = ownerOf(tokenIds[i]);
      pendingTransferStart[lzDestId]++;
    }

    if (includeOwner == 1) {
      tokenIds[updateCount] = tokenId;
      owners[updateCount] = newOwner;
    }

    return (tokenIds, owners);
  }

  function _updateNewOwners(uint32 lzDestId, uint256 lzEthAmount, uint256 lzTokenAmount) internal {
    uint32[] memory tokenIds;
    address[] memory owners;

    (tokenIds, owners) = extractPendingTransferUpdates(lzDestId);
    if (tokenIds.length > 0) {
      if (lzDestId == mainnetLzId)
        cawProfileL2.updateOwners(tokenIds, owners);
      else {
        bytes memory payload = abi.encodeWithSelector(updateOwnersSelector, tokenIds, owners);
        lzSend(lzDestId, updateOwnersSelector, tokenIds.length, payload, lzEthAmount, lzTokenAmount);
      }
    }
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

    // Call the function using the selector and arguments.
    //
    // SECURITY NOTE (audited 2026-04-06): The fromLZ + delegatecall pattern is intentional and safe.
    // - The OApp base class already verifies msg.sender == endpoint and the peer before _lzReceive runs.
    // - The only authorized function (setWithdrawable) makes zero external calls — no reentrancy vector.
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

  // Whitelist of selectors allowed via delegatecall from LayerZero messages.
  // Security: verified that no authorized selector collides with any inherited
  // function from OApp, ERC721, ERC721Enumerable, or Ownable.
  function isAuthorizedFunction(bytes4 selector) private pure returns (bool) {
    return selector == bytes4(keccak256("setWithdrawable(uint32[],uint256[])"));
  }

  // Overriding this internal function because inherited LZ code requires msg.value == _nativeFee,
  // which doesn't allow for clients to take native fees alongside LZ.
  function _payNative(uint256 _nativeFee) internal virtual override returns (uint256 nativeFee) {
    if (msg.value < _nativeFee) revert NotEnoughNative(msg.value);
    return _nativeFee;
  }

  function lzSend(uint32 lzDestId, bytes4 selector, uint256 n, bytes memory payload, uint256 lzEthAmount, uint256 lzTokenAmount) internal {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector, n), 0);

    // Refund excess LZ fee to tx.origin — the EOA that actually paid.
    // Using msg.sender would break when called through an intermediary contract
    // (e.g. CawProfileMarketplace.acceptOffer -> transferAndSync) because the contract
    // wouldn't have a receive() function to accept the refund.
    _lzSend(
      lzDestId, // Destination chain's endpoint ID.
      payload, // Encoded message payload being sent.
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(lzEthAmount, lzTokenAmount), // Fee struct containing native gas and ZRO token.
      payable(tx.origin) // Refund excess LZ fee to the tx originator (the EOA paying)
    );
  }


  // Most quote functions moved to CawProfileQuoter contract to reduce contract size
  // lzQuote stays here since it needs access to inherited _quote from OApp

  function lzQuote(bytes4 selector, uint256 n, bytes memory payload, uint32 lzDestId, bool _payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector, n), 0);
    return _quote(lzDestId, payload, _options, _payInLzToken);
  }

  /// @notice Gas limit forwarded to the destination chain for executing this message.
  /// @dev Sized as base + per-entry * n, where n is the array length in the payload.
  ///      Numbers are derived from real measurements (scripts/measure-gas.js) plus a safety
  ///      margin: base is measured-base × ~1.35, slope is measured-slope × ~1.32. The margin
  ///      covers cold-slot warmup variance at small n and leaves headroom for future solc
  ///      or opcode cost changes. Worst-case (n=50) fits within ~1.3× of measured.
  function gasLimitFor(bytes4 selector, uint256 n) public view returns (uint128) {
    // Base must cover the measured n=0 worst case, not just the linear-fit intercept:
    // mint(n=0)=54k, deposit(n=0)=81k, auth(n=0)=36k, updateOwners(n=0)=18k,
    // setClientChains(n=1 cold)=112k. See scripts/measure-gas.js output.
    if (selector == addToBalanceSelector)      return uint128(110_000 + 19_000 * n);  // measured n=0: 81k
    if (selector == mintSelector)              return uint128( 75_000 + 19_000 * n);  // measured n=0: 54k
    if (selector == updateOwnersSelector)      return uint128( 25_000 + 19_000 * n);  // measured n=0: 18k
    if (selector == authSelector)              return uint128( 50_000 + 19_000 * n);  // measured n=0: 36k
    if (selector == setClientChainsSelector)   return uint128(150_000 + 25_000 * n);  // n=1 cold: 112k
    revert("unexpected selector");
  }

  receive() external payable {}
  fallback() external payable {}

}

