// contracts/CawName.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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

  IERC20 public immutable CAW;
  CawNameURI public uriGenerator;

  uint256 public totalCaw;

  address public minter;

  string[] public usernames;

  bytes4 public addToBalanceSelector = bytes4(keccak256("addToBalanceAndUpdateOwners(uint64,uint256,uint64[],address[])"));
  bytes4 public mintSelector = bytes4(keccak256("mintAndUpdateOwners(uint64,address,string memory,uint64[],address[])"));
  bytes4 public updateOwnersSelector = bytes4(keccak256("updateOwners(uint64[],address[])"));

  mapping(uint64 => uint256) public withdrawable;

  uint256 public rewardMultiplier = 10**18;
  uint256 public precision = 30425026352721 ** 2;// ** 3;

  uint32 public layer2EndpointId;

  mapping(uint256 => uint256) public pendingTransfers;
  uint256 public transferUpdateLimit = 50;
  uint256 public pendingTransferStart = 1;
  uint256 public pendingTransferEnd = 0;

  struct Token {
    uint256 withdrawable;
    uint256 tokenId;
    string username;
  }

  constructor(address _caw, address _gui, address _endpoint, uint32 _layer2EndpointId)
    ERC721("CAW NAME", "cawNAME")
    OApp(_endpoint, msg.sender)
  {

    layer2EndpointId = _layer2EndpointId;
    uriGenerator = CawNameURI(_gui);
    CAW = IERC20(_caw);
    // CAW = IERC20(0xf3b9569F82B18aEf890De263B84189bd33EBe452);
  }

  function setMinter(address _minter) public onlyOwner {
    minter = _minter;
  }

  // create an ARTIST_ROLE
  function setUriGenerator(address _gui) public onlyOwner {
    uriGenerator = CawNameURI(_gui);
  }

  function tokenURI(uint256 tokenId) override public view returns (string memory) {
    return uriGenerator.generate(usernames[uint64(tokenId) - 1]);
  }

  function mint(address owner, string memory username, uint64 newId) public {
    require(minter == _msgSender(), "caller is not the minter");
    usernames.push(username);
    _safeMint(owner, newId);

    uint256[] memory tokenIds;
    address[] memory owners;

    (tokenIds, owners) = extractPendingTransferUpdates();

    bytes memory payload = abi.encodeWithSelector(
      mintSelector, newId, owner, usernames[newId - 1], tokenIds, owners
    ); lzSend(mintSelector, payload);
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

  function deposit(uint64 tokenId, uint256 amount) public {
    require(ownerOf(tokenId) == msg.sender, "can not deposit into a CawName that you do not own");

    CAW.transferFrom(msg.sender, address(this), amount);
    // setCawBalance(tokenId, cawBalanceOf(tokenId) + amount);
    totalCaw += amount;

    uint256[] memory tokenIds;
    address[] memory owners;
    (tokenIds, owners) = extractPendingTransferUpdates();

    bytes memory payload = abi.encodeWithSelector(addToBalanceSelector, tokenId, amount, tokenIds, owners);
    lzSend(addToBalanceSelector, payload);
    _updateNewOwners();
  }

  function withdraw(uint64 tokenId) public {
    require(ownerOf(tokenId) == msg.sender, "can not withdraw from a CawName that you do not own");
    require(withdrawable[tokenId] >= 0, "nothing to withdraw, you may need to withdraw from the L2 first");

    withdrawable[tokenId] = 0;
    totalCaw -= withdrawable[tokenId];
    CAW.transfer(msg.sender, withdrawable[tokenId]);
    _updateNewOwners();
  }

  function setWithdrawable(uint64 tokenId, uint256 amount) internal {
    withdrawable[tokenId] = amount;
  }

  function _afterTokenTransfer(address from, address to, uint64 tokenId, uint64 batchSize) internal virtual {
    if (from != address(0))
      pendingTransfers[++pendingTransferEnd] = tokenId;
  }

  function extractPendingTransferUpdates() internal returns (uint256[] memory, address[] memory) {
    uint256 updateCount = Math.min(transferUpdateLimit, pendingTransferEnd - pendingTransferStart + 1);
    uint256[] memory tokenIds = new uint256[](updateCount);
    address[] memory owners = new address[](updateCount);

    for (uint256 i = 0; i < updateCount; i++) {
      tokenIds[i] = pendingTransfers[pendingTransferStart];
      delete pendingTransfers[pendingTransferStart];
      owners[i] = ownerOf(tokenIds[i]);
      pendingTransferStart++;
    }

    return (tokenIds, owners);
  }

  function _updateNewOwners() public {
    uint256[] memory tokenIds;
    address[] memory owners;

    (tokenIds, owners) = extractPendingTransferUpdates();
    bytes memory payload = abi.encodeWithSelector(updateOwnersSelector, tokenIds, owners);
    lzSend(updateOwnersSelector, payload);
  }

  function _lzReceive(
    Origin calldata _origin, // struct containing info about the message sender
    bytes32 _guid, // global packet identifier
    bytes calldata payload, // encoded message payload being received
    address _executor, // the Executor address.
    bytes calldata _extraData // arbitrary data appended by the Executor
  ) internal override {
    // Decode the function selector and arguments from the payload
    (bytes4 selector, bytes memory args) = abi.decode(payload, (bytes4, bytes));

    // Ensure the selector corresponds to an expected function to prevent unauthorized actions
    require(isAuthorizedFunction(selector), "Unauthorized function call");

    // Call the function using the selector and arguments
    (bool success, ) = address(this).delegatecall(abi.encodePacked(selector, args));
    require(success, "Function call failed");
  }

  // Helper function to verify if the function selector is authorized
  function isAuthorizedFunction(bytes4 selector) private view returns (bool) {
    // Add all authorized function selectors here
    return selector == bytes4(keccak256("setWithdrawable(uint64,uint256)"));
  }

  function lzSend(bytes4 selector, bytes memory payload) internal {
    uint256 gasPrice = 0;
    bytes memory _options = abi.encode(
      gasLimitFor(selector),  // The gas limit for the execution of the message on L2
      uint256(gasPrice)   // The gas price you are willing to pay on L2
    );

    _lzSend(
      layer2EndpointId, // Destination chain's endpoint ID.
      payload, // Encoded message payload being sent.
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(msg.value, 0), // Fee struct containing native gas and ZRO token.
      payable(msg.sender) // The refund address in case the send call reverts.
    );
  }

  function gasLimitFor(bytes4 selector) public view returns (uint256) {
    if (selector == addToBalanceSelector)
      return 600000;
    else if (selector == updateOwnersSelector)
      return 300000;
  }

}

