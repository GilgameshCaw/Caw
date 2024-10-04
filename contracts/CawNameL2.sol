// contracts/CawName.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./CawNameURI.sol";
import "./CawName.sol";

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

  address public cawActions;

  // In a normal ERC271, ownerOf reverts if there is no owner,
  // here, since it's not a real ERC721, just a pretender,
  // we return the zero addres... probably fine. Right?
  mapping(uint256 => address) public ownerOf;

  // Keeping track of clients to which the user has authenticated
  mapping(uint32 => mapping(uint32 => bool)) public authenticated;

  mapping(uint32 => uint256) public cawOwnership;

  uint256 public rewardMultiplier = 10**18;
  uint256 public precision = 30425026352721 ** 2;// ** 3;

  uint32 public layer1EndpointId = 30101;

  bool private fromLZ;

  bool public bypassLZ;
  CawName public cawName;

  bytes4 public setWithdrawableSelector = bytes4(keccak256("setWithdrawable(uint32[],uint256[])"));

  struct Token {
    uint256 tokenId;
    uint256 balance;
    string username;
  }

  constructor(address _endpoint)
    OApp(_endpoint, msg.sender)
  {
  }

  function setL1Peer(uint32 _eid, address payable peer, bool _bypassLZ) external onlyOwner {
    if (_bypassLZ) {
      bypassLZ = true;
      cawName = CawName(peer);
    } else setPeer(_eid, bytes32(uint256(uint160(address(peer)))));
  }

  function setCawActions(address _cawActions) external onlyOwner {
    cawActions = _cawActions;
  }

  function cawBalanceOf(uint32 tokenId) public view returns (uint256){
    return cawOwnership[tokenId] * rewardMultiplier / (precision);
  }

  function spendAndDistributeTokens(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) external {
    spendAndDistribute(tokenId, amountToSpend * 10**18, amountToDistribute * 10**18);
  }

  function spendAndDistribute(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) public {
    require(cawActions == _msgSender(), "caller is not the cawActions contract");
    uint256 balance = cawBalanceOf(tokenId);

    require(balance >= amountToSpend, 'insufficent CAW balance');
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
    require(fromLZ || cawActions == _msgSender(), "caller is not cawActions or LZ");

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
    ownerOf[tokenId] = owner;

    updateOwners(tokenIds, owners);
  }

  function auth(uint32 cawClientId, uint32 tokenId) external onlyOnMainnet {
    authenticated[cawClientId][tokenId] = true;
  }

  function deposit(uint32 cawClientId, uint32 tokenId, uint256 amount) external onlyOnMainnet {
    totalCaw += amount;
    addToBalance(tokenId, amount);
    authenticated[cawClientId][tokenId] = true;
  }

  function mint(uint32 tokenId, address owner, string memory username) external onlyOnMainnet {
    ownerOf[tokenId] = owner;
  }

  function setOwnerOf(uint32 tokenId, address newOwner) external onlyOnMainnet {
    _setOwnerOf(tokenId, newOwner);
  }

  function _setOwnerOf(uint32 tokenId, address newOwner) internal {
    ownerOf[tokenId] = newOwner;
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

  // Helper function to verify if the function selector is authorized
  function isAuthorizedFunction(bytes4 selector) private pure returns (bool) {
    // Add all authorized function selectors here
    return selector == bytes4(keccak256("depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[])")) || 
      selector == bytes4(keccak256("authenticateAndUpdateOwners(uint32,uint32,uint32[],address[])")) ||
      selector == bytes4(keccak256("mintAndUpdateOwners(uint32,address,string,uint32[],address[])")) ||
      selector == bytes4(keccak256("updateOwners(uint32[],address[])"));
  }

  function withdraw(uint32 tokenId, uint256 amount) external {
    require(cawActions == _msgSender(), "caller is not the cawActions contract");

    uint256 balance = cawBalanceOf(tokenId);
    require(balance >= amount, 'insufficent CAW balance');

    totalCaw -= amount;
    setCawBalance(tokenId, balance - amount);
  }

  function setWithdrawable(uint32[] memory tokenIds, uint256[] memory amounts, uint256 lzTokenAmount) external payable {
    require(cawActions == _msgSender(), "caller is not CawActions");
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
  // Find real values for these:
  function gasLimitFor(bytes4 selector) public view returns (uint128) {
    if (selector == setWithdrawableSelector)
      return 300000;
    else revert('unexpected selector');
  }

}


