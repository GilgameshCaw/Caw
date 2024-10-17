// contracts/CawNameL2.sol
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

  mapping(uint256 => address) public ownerOf;

  mapping(uint32 => mapping(uint32 => bool)) public authenticated;

  mapping(uint32 => uint256) public cawOwnership;

  uint256 public rewardMultiplier = 10**18;
  uint256 public precision = 30425026352721 ** 2;

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

  function spendAndDistributeTokens(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) external returns (bool success, string memory errorReason) {
    // Multiply amounts by 10^18
    return spendAndDistribute(tokenId, amountToSpend * 10**18, amountToDistribute * 10**18);
  }

  function spendAndDistribute(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) public returns (bool success, string memory errorReason) {
    if (cawActions != _msgSender()) {
      return (false, "caller is not the cawActions contract");
    }

    uint256 balance = cawBalanceOf(tokenId);

    if (balance < amountToSpend) {
      return (false, "insufficient CAW balance");
    }

    uint256 newCawBalance = balance - amountToSpend;

    if (totalCaw > balance) {
      rewardMultiplier += rewardMultiplier * amountToDistribute / (totalCaw - balance);
    } else {
      newCawBalance += amountToDistribute;
    }

    setCawBalance(tokenId, newCawBalance);
    return (true, "");
  }

  function addTokensToBalance(uint32 tokenId, uint256 amount) external returns (bool success, string memory errorReason) {
    // Multiply amount by 10^18
    return addToBalance(tokenId, amount * 10**18);
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

  function addToBalance(uint32 tokenId, uint256 amount) public returns (bool success, string memory errorReason) {
    if (!(fromLZ || cawActions == _msgSender())) {
      return (false, "caller is not cawActions or LZ");
    }

    setCawBalance(tokenId, cawBalanceOf(tokenId) + amount);
    return (true, "");
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
    Origin calldata _origin,
    bytes32 _guid,
    bytes calldata payload,
    address _executor,
    bytes calldata
  ) internal override {
    bytes4 decodedSelector;
    bytes memory args = new bytes(payload.length - 4);

    assembly {
      decodedSelector := calldataload(payload.offset)
      calldatacopy(add(args, 32), add(payload.offset, 4), sub(payload.length, 4))
    }

    require(isAuthorizedFunction(decodedSelector), "Unauthorized function call");

    fromLZ = true;
    (bool success, bytes memory returnData) = address(this).delegatecall(bytes.concat(decodedSelector, args));
    fromLZ = false;

    if (!success) {
      if (returnData.length == 0) {
        revert("Delegatecall failed with no revert reason");
      } else {
        assembly {
          let returndata_size := mload(returnData)
          revert(add(32, returnData), returndata_size)
        }
      }
    }
  }

  mapping(bytes4 => string) public functionSigs;

  function isAuthorizedFunction(bytes4 selector) private pure returns (bool) {
    return selector == bytes4(keccak256("depositAndUpdateOwners(uint32,uint32,uint256,uint32[],address[])")) || 
      selector == bytes4(keccak256("authenticateAndUpdateOwners(uint32,uint32,uint32[],address[])")) ||
      selector == bytes4(keccak256("mintAndUpdateOwners(uint32,address,string,uint32[],address[])")) ||
      selector == bytes4(keccak256("updateOwners(uint32[],address[])"));
  }

  function withdraw(uint32 tokenId, uint256 amount) external returns (bool success, string memory errorReason) {
    if (cawActions != _msgSender()) {
      return (false, "caller is not the cawActions contract");
    }

    uint256 balance = cawBalanceOf(tokenId);
    if (balance < amount) {
      return (false, "insufficient CAW balance");
    }

    totalCaw -= amount;
    setCawBalance(tokenId, balance - amount);

    return (true, "");
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

  function lzSend(bytes4 selector, bytes memory payload, uint256 lzTokenAmount) internal {
    bytes memory _options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gasLimitFor(selector), 0);

    _lzSend(
      layer1EndpointId,
      payload,
      _options,
      MessagingFee(msg.value, lzTokenAmount),
      payable(msg.sender)
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

