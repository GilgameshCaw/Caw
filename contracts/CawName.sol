// contracts/CawName.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./CawNameURI.sol";

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawName is 
  Context,
  ERC721Enumerable,
  Ownable,
  OApp
{
  using OptionsBuilder for bytes;

  IERC20 public immutable CAW;
  CawNameURI public uriGenerator;

  uint256 public totalCaw;

  address public minter;

  string[] public usernames;
  bool private fromLZ;

  bytes4 public addToBalanceSelector = bytes4(keccak256("depositAndUpdateOwners(uint64,uint256,uint64[],address[])"));
  bytes4 public mintSelector = bytes4(keccak256("mintAndUpdateOwners(uint64,address,string,uint64[],address[])"));
  bytes4 public updateOwnersSelector = bytes4(keccak256("updateOwners(uint64[],address[])"));

  mapping(uint64 => uint256) public withdrawable;

  uint256 public rewardMultiplier = 10**18;

  uint32 public layer2EndpointId;

  mapping(uint256 => uint64) public pendingTransfers;
  uint256 public transferUpdateLimit = 50;
  uint256 public pendingTransferStart = 0;
  uint256 public pendingTransferEnd = 0;

  struct Token {
    uint256 withdrawable;
    uint256 tokenId;
    string username;
  }

  constructor(address _caw, address _gui, address _endpoint, uint32 _layer2EndpointId, address peer)
    ERC721("CAW NAME", "cawNAME")
    OApp(_endpoint, msg.sender)
  {
    setPeer(_layer2EndpointId, bytes32(uint256(uint160(peer))));
    layer2EndpointId = _layer2EndpointId;
    uriGenerator = CawNameURI(_gui);
    CAW = IERC20(_caw);
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

  function mint(address owner, string memory username, uint64 newId, uint256 lzTokenAmount) public payable {
    require(minter == _msgSender(), "caller is not the minter");
    usernames.push(username);
    _safeMint(owner, newId);

    uint64[] memory tokenIds;
    address[] memory owners;

    (tokenIds, owners) = extractPendingTransferUpdates();

    bytes memory payload = abi.encodeWithSelector(
      mintSelector, newId, owner, usernames[newId - 1], tokenIds, owners
    ); lzSend(mintSelector, payload, lzTokenAmount);
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

  function deposit(uint64 tokenId, uint256 amount, uint256 lzTokenAmount) public payable {
    require(ownerOf(tokenId) == msg.sender, "can not deposit into a CawName that you do not own");

    CAW.transferFrom(msg.sender, address(this), amount);
    totalCaw += amount;

    uint64[] memory tokenIds;
    address[] memory owners;
    (tokenIds, owners) = extractPendingTransferUpdates();

    bytes memory payload = abi.encodeWithSelector(addToBalanceSelector, tokenId, amount, tokenIds, owners);
    lzSend(addToBalanceSelector, payload, lzTokenAmount);
  }

  function withdraw(uint64 tokenId, uint256 lzTokenAmount) public payable {
    require(ownerOf(tokenId) == msg.sender, "can not withdraw from a CawName that you do not own");
    require(withdrawable[tokenId] >= 0, "nothing to withdraw, you may need to withdraw from the L2 first");

    uint256 amount = withdrawable[tokenId];
    totalCaw -= withdrawable[tokenId];
    withdrawable[tokenId] = 0;

    CAW.transfer(msg.sender, amount);
    _updateNewOwners(lzTokenAmount);
  }

  function withdrawQuote(bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint64[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = pendingTransferUpdates();

    bytes memory payload = abi.encodeWithSelector(
      updateOwnersSelector, tokenIds, owners
    ); return lzQuote(updateOwnersSelector, payload, payInLzToken);
  }

  function setWithdrawable(uint64[] memory tokenIds, uint256[] memory amounts) external {
    require(fromLZ, "setWithdrawable only callable internally");
    for (uint256 i = 0; i < tokenIds.length; i++)
      withdrawable[tokenIds[i]] += amounts[i];
  }

  function _afterTokenTransfer(address from, address to, uint256 tokenId, uint256 batchSize) internal virtual override {
    if (from != address(0)) {
      pendingTransfers[pendingTransferEnd++] = uint64(tokenId);
    }
  }

  function pendingTransferUpdates() public view returns (uint64[] memory, address[] memory) {
    uint256 updateCount = Math.min(transferUpdateLimit, pendingTransferEnd - pendingTransferStart);
    uint64[] memory tokenIds = new uint64[](updateCount);
    address[] memory owners = new address[](updateCount);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[pendingTransferStart + i];
      owners[i] = ownerOf(tokenIds[i]);
    }

    return (tokenIds, owners);
  }

  function extractPendingTransferUpdates() internal returns (uint64[] memory, address[] memory) {
    uint256 updateCount = Math.min(transferUpdateLimit, pendingTransferEnd - pendingTransferStart);
    uint64[] memory tokenIds = new uint64[](updateCount);
    address[] memory owners = new address[](updateCount);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[pendingTransferStart];
      delete pendingTransfers[pendingTransferStart];
      owners[i] = ownerOf(tokenIds[i]);
      pendingTransferStart++;
    }

    return (tokenIds, owners);
  }

  function _updateNewOwners(uint256 lzTokenAmount) public payable {
    uint64[] memory tokenIds;
    address[] memory owners;

    (tokenIds, owners) = extractPendingTransferUpdates();
    bytes memory payload = abi.encodeWithSelector(updateOwnersSelector, tokenIds, owners);
    lzSend(updateOwnersSelector, payload, lzTokenAmount);
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

  function lzSend(bytes4 selector, bytes memory payload, uint256 lzTokenAmount) internal {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector), 0);

    _lzSend(
      layer2EndpointId, // Destination chain's endpoint ID.
      payload, // Encoded message payload being sent.
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(msg.value, lzTokenAmount), // Fee struct containing native gas and ZRO token.
      payable(msg.sender) // The refund address in case the send call reverts.
    );
  }

  function depositQuote(uint64 tokenId, uint256 amount, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint64[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = pendingTransferUpdates();

    bytes memory payload = abi.encodeWithSelector(
      addToBalanceSelector, tokenId, amount, tokenIds, owners
    ); return lzQuote(addToBalanceSelector, payload, payInLzToken);
  }

  function mintQuote(address owner, string memory username, bool payInLzToken) public view returns (MessagingFee memory quote) {
    uint64[] memory tokenIds; address[] memory owners;
    (tokenIds, owners) = pendingTransferUpdates();

    bytes memory payload = abi.encodeWithSelector(
      mintSelector, nextId(), owner, username, tokenIds, owners
    ); return lzQuote(mintSelector, payload, payInLzToken);
  }

  function lzQuote(bytes4 selector, bytes memory payload, bool _payInLzToken) public view returns (MessagingFee memory quote) {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector), 0);
    return _quote(layer2EndpointId, payload, _options, _payInLzToken);
  }

  function gasLimitFor(bytes4 selector) public view returns (uint128) {
    if (selector == addToBalanceSelector)
      return 600000;
    else if (selector == mintSelector)
      return 600000;
    else if (selector == updateOwnersSelector)
      return 300000;
    else revert('unexpected selector');
  }

}

