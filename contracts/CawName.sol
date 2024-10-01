// contracts/CawName.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./CawNameURI.sol";
import "./CawNameL2.sol";

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";
import { CawClientManager } from "./CawClientManager.sol";

contract CawName is 
  Context,
  ERC721Enumerable,
  Ownable,
  OApp
{
  using OptionsBuilder for bytes;
  using EnumerableSet for EnumerableSet.UintSet;

  IERC20 public immutable CAW;
  CawNameURI public uriGenerator;

  CawNameL2 public cawNameL2;

  uint256 public totalCaw;

  address public minter;

  uint32 public mainnetLzId;
  string[] public usernames;
  bool private fromLZ;

  bytes4 public addToBalanceSelector = bytes4(keccak256("depositAndUpdateOwners(uint64,uint64,uint256,uint64[],address[])"));
  bytes4 public mintSelector = bytes4(keccak256("mintAndUpdateOwners(uint64,address,string,uint64[],address[])"));
  bytes4 public authSelector = bytes4(keccak256("authenticateAndUpdateOwners(uint64,uint64,uint64[],address[])"));
  bytes4 public updateOwnersSelector = bytes4(keccak256("updateOwners(uint64[],address[])"));

  // Keeping track of clients to which the user has authenticated
  mapping(uint64 => mapping(uint64 => bool)) public authenticated;

  mapping(uint64 => uint256) public withdrawable;

  uint256 public rewardMultiplier = 10**18;

  // tokenId => [lzDestId, lzDestId2, ...]
  mapping(uint64 => EnumerableSet.UintSet) private chosenChainIds;
  EnumerableSet.UintSet peerIds;

  // lzDestId => index => tokenId
  mapping(uint32 => mapping(uint256 => uint64)) public pendingTransfers;
  uint256 public transferUpdateLimit = 50;

  // lzDestId => value
  mapping(uint32 => uint256) public pendingTransferStart;
  mapping(uint32 => uint256) public pendingTransferEnd;

  struct Token {
    uint256 withdrawable;
    uint256 tokenId;
    string username;
  }

  CawClientManager clientManager;
  address buyAndBurnCaw;

  constructor(address _caw, address _gui, address _buyAndBurn, address _clientManager, address _endpoint, uint32 mainnetEid)
    ERC721("CAW NAME", "cawNAME")
    OApp(_endpoint, msg.sender)
  {
    clientManager = CawClientManager(_clientManager);
    uriGenerator = CawNameURI(_gui);
    buyAndBurnCaw = _buyAndBurn;
    CAW = IERC20(_caw);
    mainnetLzId = mainnetEid;
  }

  function setL2Peer(uint32 _eid, address _peer) external onlyOwner {
    if (_eid != mainnetLzId) {
      peerIds.add(uint256(_eid));
      setPeer(_eid, bytes32(uint256(uint160(_peer))));
    } else cawNameL2 = CawNameL2(_peer);
  }

  function setMinter(address _minter) external onlyOwner {
    minter = _minter;
  }

  function setUriGenerator(address _gui) external onlyOwner {
    uriGenerator = CawNameURI(_gui);
  }

  function tokenURI(uint256 tokenId) override public view returns (string memory) {
    return uriGenerator.generate(usernames[uint64(tokenId) - 1]);
  }

  function mint(uint64 cawClientId, address owner, string memory username, uint64 newId, uint256 lzTokenAmount) public payable {
    require(minter == _msgSender(), "caller is not the minter");
    usernames.push(username);
    _safeMint(owner, newId);

    (uint256 fee, address feeAddress) = clientManager.getMintFeeAndAddress(cawClientId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    _updateNewOwners(peerWithMaxPendingTransfers(), lzEthAmount, lzTokenAmount);
  }

  function payFee(uint256 fee, address feeAddress) internal returns (uint256) {
    if (fee > 0) {
      payable(feeAddress).transfer(fee);
      payable(buyAndBurnCaw).transfer(fee);
    }
    return fee * 2;
  }

  function nextId() public view returns (uint64) {
    return uint64(usernames.length) + 1;
  }

  function tokens(address user) external view returns (Token[] memory) {
    uint64 tokenId;
    uint256 balance = balanceOf(user);
    Token[] memory userTokens = new Token[](balance);
    for (uint64 i = 0; i < balance; i++) {
      tokenId = uint64(tokenOfOwnerByIndex(user, i));

      userTokens[i].withdrawable = withdrawable[tokenId];
      userTokens[i].username = usernames[tokenId - 1];
      userTokens[i].tokenId = tokenId;
    }
    return userTokens;
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

  function authenticate(uint64 cawClientId, uint64 tokenId, uint32 lzDestId, uint256 lzTokenAmount) external payable {
    require(ownerOf(tokenId) == msg.sender, "can not authenticate with a CawName that you do not own");

    (uint256 fee, address feeAddress) = clientManager.getAuthFeeAndAddress(cawClientId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);
    authenticated[cawClientId][tokenId] = true;

    if (lzDestId == mainnetLzId)
      cawNameL2.auth(tokenId, cawClientId);
    else {
      uint64[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, msg.sender, tokenId);
      bytes memory payload = abi.encodeWithSelector(authSelector, cawClientId, tokenId, tokenIds, owners);
      lzSend(lzDestId, authSelector, payload, lzEthAmount, lzTokenAmount);
    }
  }

  function deposit(uint64 cawClientId, uint64 tokenId, uint256 amount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    require(ownerOf(tokenId) == msg.sender, "can not deposit into a CawName that you do not own");

    chosenChainIds[tokenId].add(uint256(lzDestId));
    CAW.transferFrom(msg.sender, address(this), amount);
    totalCaw += amount;

    (uint256 fee, address feeAddress) = clientManager.getDepositFeeAndAddress(cawClientId);

    if (!authenticated[cawClientId][tokenId]) {
      fee += clientManager.getAuthFee(cawClientId);
      authenticated[cawClientId][tokenId] = true;
    }

    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    if (lzDestId == mainnetLzId)
      cawNameL2.deposit(cawClientId, tokenId, amount);
    else {
      uint64[] memory tokenIds;
      address[] memory owners;
      (tokenIds, owners) = extractPendingTransferUpdates(lzDestId, msg.sender, tokenId);
      bytes memory payload = abi.encodeWithSelector(addToBalanceSelector, cawClientId, tokenId, amount, tokenIds, owners);
      lzSend(lzDestId, addToBalanceSelector, payload, lzEthAmount, lzTokenAmount);
    }
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

  function withdraw(uint64 cawClientId, uint64 tokenId, uint256 lzTokenAmount) public payable {
    require(ownerOf(tokenId) == msg.sender, "can not withdraw from a CawName that you do not own");
    require(withdrawable[tokenId] >= 0, "nothing to withdraw, you may need to withdraw from the L2 first");

    uint256 amount = withdrawable[tokenId];
    totalCaw -= withdrawable[tokenId];
    withdrawable[tokenId] = 0;

    (uint256 fee, address feeAddress) = clientManager.getDepositFeeAndAddress(cawClientId);
    uint256 lzEthAmount = msg.value - payFee(fee, feeAddress);

    CAW.transfer(msg.sender, amount);
    _updateNewOwners(peerWithMaxPendingTransfers(), lzEthAmount, lzTokenAmount);
  }

  function setWithdrawable(uint64[] memory tokenIds, uint256[] memory amounts) external {
    require(fromLZ, "setWithdrawable only callable internally");
    for (uint256 i = 0; i < tokenIds.length; i++)
      withdrawable[tokenIds[i]] += amounts[i];
  }

  function getChosenChainIdAtIndex(uint64 token, uint256 index) public view returns (uint256) {
    return chosenChainIds[token].at(index);
  }

  function _afterTokenTransfer(address from, address to, uint256 tokenId, uint256 batchSize) internal virtual override {
    uint64 token = uint64(tokenId);
    EnumerableSet.UintSet storage chainIds = chosenChainIds[token];
    for (uint256 i = 0; i < chainIds.length(); i++) {
      uint32 chainId = uint32(chainIds.at(i));
      if (chainId == mainnetLzId) cawNameL2.setOwnerOf(token, to);
      else pendingTransfers[chainId][pendingTransferEnd[chainId]++] = token;
    }
  }

  function updatesNeededForPeer(uint32 lzDestId) public view returns (uint256) {
    return Math.min(transferUpdateLimit, pendingTransferEnd[lzDestId] - pendingTransferStart[lzDestId]);
  }

  function pendingTransferUpdates(uint32 lzDestId) public view returns (uint64[] memory, address[] memory) {
    return pendingTransferUpdates(lzDestId, address(0), 0);
  }

  function pendingTransferUpdates(uint32 lzDestId, address newOwner, uint64 tokenId) public view returns (uint64[] memory, address[] memory) {
    uint256 updateCount = updatesNeededForPeer(lzDestId);
    uint256 includeOwner = newOwner == address(0) && tokenId == 0 ? 0 : 1;
    uint64[] memory tokenIds = new uint64[](updateCount + includeOwner);
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

  function extractPendingTransferUpdates(uint32 lzDestId) internal returns (uint64[] memory, address[] memory) {
    extractPendingTransferUpdates(lzDestId, address(0), 0);
  }

  function extractPendingTransferUpdates(uint32 lzDestId, address newOwner, uint64 tokenId) internal returns (uint64[] memory, address[] memory) {
    uint256 updateCount = updatesNeededForPeer(lzDestId);
    uint256 includeOwner = newOwner == address(0) && tokenId == 0 ? 0 : 1;
    uint64[] memory tokenIds = new uint64[](updateCount + includeOwner);
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

  function _updateNewOwners(uint32 lzDestId, uint256 lzEthAmount, uint256 lzTokenAmount) public payable {
    uint64[] memory tokenIds;
    address[] memory owners;

    (tokenIds, owners) = extractPendingTransferUpdates(lzDestId);
    if (tokenIds.length > 0) {
      if (lzDestId == mainnetLzId)
        cawNameL2.updateOwners(tokenIds, owners);
      else {
        bytes memory payload = abi.encodeWithSelector(updateOwnersSelector, tokenIds, owners);
        lzSend(lzDestId, updateOwnersSelector, payload, lzEthAmount, lzTokenAmount);
      }
    }
  }

  function _lzReceive(
    Origin calldata _origin, // struct containing info about the message sender
    bytes32 _guid, // global packet identifier
    bytes calldata payload, // encoded message payload being received
    address _executor, // the Executor address.
    bytes calldata _extraData // arbitrary data appended by the Executor
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

  // Helper function to verify if the function selector is authorized
  function isAuthorizedFunction(bytes4 selector) private view returns (bool) {
    // Add all authorized function selectors here
    return selector == bytes4(keccak256("setWithdrawable(uint64[],uint256[])"));
  }

  // Overriding this internal function because inherited LZ code requires msg.value == _nativeFee,
  // which doesn't allow for clients to take native fees alongside LZ.
  function _payNative(uint256 _nativeFee) internal virtual override returns (uint256 nativeFee) {
    if (msg.value < _nativeFee) revert NotEnoughNative(msg.value);
    return _nativeFee;
  }

  function lzSend(uint32 lzDestId, bytes4 selector, bytes memory payload, uint256 lzEthAmount, uint256 lzTokenAmount) internal {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector), 0);

    _lzSend(
      lzDestId, // Destination chain's endpoint ID.
      payload, // Encoded message payload being sent.
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(lzEthAmount, lzTokenAmount), // Fee struct containing native gas and ZRO token.
      payable(address(this)) // The refund address in case the send call reverts.
    );
  }


  function authenticateQuote(uint64 clientId, uint64 tokenId, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint64[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      authSelector, clientId, tokenId, tokenIds, owners
    );

    MessagingFee memory quote = lzQuote(authSelector, payload, lzDestId, payInLzToken);
    quote.nativeFee += clientManager.getAuthFee(clientId) * 2;
    return quote;
  }

  function depositQuote(uint64 clientId, uint64 tokenId, uint256 amount, uint32 lzDestId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint64[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = pendingTransferUpdates(lzDestId, msg.sender, tokenId);

    bytes memory payload = abi.encodeWithSelector(
      addToBalanceSelector, clientId, tokenId, amount, tokenIds, owners
    );

    MessagingFee memory quote = lzQuote(addToBalanceSelector, payload, lzDestId, payInLzToken);
    quote.nativeFee += clientManager.getDepositFee(clientId) * 2;

    if (!authenticated[clientId][tokenId])
      quote.nativeFee += clientManager.getAuthFee(clientId) * 2;

    return quote;
  }

  function mintQuote(uint64 clientId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    MessagingFee memory quote = updateOwnerQuote(payInLzToken);
    quote.nativeFee += clientManager.getMintFee(clientId) * 2;
    return quote;
  }

  function withdrawQuote(uint64 clientId, bool payInLzToken) public view returns (MessagingFee memory quote) {
    MessagingFee memory quote = updateOwnerQuote(payInLzToken);
    quote.nativeFee += clientManager.getWithdrawFee(clientId) * 2;
    return quote;
  }

  function updateOwnerQuote(bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint64[] memory tokenIds; address[] memory owners;
    uint32 lzDestId = peerWithMaxPendingTransfers();
    (tokenIds, owners) = pendingTransferUpdates(lzDestId);

    if (tokenIds.length == 0) return MessagingFee(0, 0);
    bytes memory payload = abi.encodeWithSelector(
      updateOwnersSelector, tokenIds, owners
    ); return lzQuote(updateOwnersSelector, payload, lzDestId, payInLzToken);
  }

  function lzQuote(bytes4 selector, bytes memory payload, uint32 lzDestId, bool _payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector), 0);
    return _quote(lzDestId, payload, _options, _payInLzToken);
  }

  function gasLimitFor(bytes4 selector) public view returns (uint128) {
    if (selector == addToBalanceSelector)
      return 600000;
    else if (selector == mintSelector)
      return 600000;
    else if (selector == updateOwnersSelector)
      return 300000;
    else if (selector == authSelector)
      return 300000;
    else revert('unexpected selector');
  }

  receive() external payable {}
  fallback() external payable {}

}

