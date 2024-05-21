// contracts/CawName.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./CawNameURI.sol";

import { OApp, Origin, MessagingFee } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/OApp.sol";

contract CawNameL2 is 
  Context,
  Ownable,
  OApp
{

  CawNameURI public uriGenerator;

  uint256 public totalCaw;

  address public cawActions;

  mapping(uint64 => string) public usernames;

  // In a normal ERC271, ownerOf reverts if there is no owner,
  // here, since it's not a real ERC721, just a pretender,
  // we return the zero addres... probably fine. Right?
  mapping(uint256 => address) public ownerOf;

  mapping(uint64 => uint256) public cawOwnership;

  uint256 public rewardMultiplier = 10**18;
  uint256 public precision = 30425026352721 ** 2;// ** 3;

  uint32 public layer1EndpointId;

  // at some point... use this selector:
  bytes4 public setWithdrawableSelector = bytes4(keccak256("setWithdrawable(uint64,uint256)"));

  struct Token {
    uint256 tokenId;
    uint256 balance;
    string username;
  }

  constructor(address _gui, address _endpoint, uint32 _layer1EndpointId)
    OApp(_endpoint, msg.sender)
  {
    uriGenerator = CawNameURI(_gui);
    layer1EndpointId = _layer1EndpointId;
  }

  function setCawActions(address _cawActions) public onlyOwner {
    cawActions = _cawActions;
  }

  // create an ARTIST_ROLE
  function setUriGenerator(address _gui) public onlyOwner {
    uriGenerator = CawNameURI(_gui);
  }

  function tokenURI(uint256 tokenId, string calldata name) public view returns (string memory) {
    return uriGenerator.generate(name);
  }

  function cawBalanceOf(uint64 tokenId) public view returns (uint256){
    return cawOwnership[tokenId] * rewardMultiplier / (precision);
  }

  function spendAndDistributeTokens(uint64 tokenId, uint256 amountToSpend, uint256 amountToDistribute) external {
    spendAndDistribute(tokenId, amountToSpend * 10**18, amountToDistribute * 10**18);
  }

  function spendAndDistribute(uint64 tokenId, uint256 amountToSpend, uint256 amountToDistribute) public {
    require(cawActions == _msgSender(), "caller is not the cawActions contract");
    uint256 balance = cawBalanceOf(tokenId);

    require(balance >= amountToSpend, 'insufficent CAW balance');
    uint256 newCawBalance = balance - amountToSpend;

    rewardMultiplier += rewardMultiplier * amountToDistribute / (totalCaw - balance);
    setCawBalance(tokenId, newCawBalance);
  }

  function addTokensToBalance(uint64 tokenId, uint256 amount) external {
    addToBalance(tokenId, amount * 10**18);
  }

  function addToBalanceAndUpdateOwners(uint64 tokenId, uint256 amount, uint64[] calldata tokenIds, address[] calldata owners) public {
    addToBalance(tokenId, amount);
    updateOwners(tokenIds, owners);
  }

  function addToBalance(uint64 tokenId, uint256 amount) public {
    require(cawActions == _msgSender(), "caller is not the cawActions");

    setCawBalance(tokenId, cawBalanceOf(tokenId) + amount);
  }

  function setCawBalance(uint64 tokenId, uint256 newCawBalance) internal {
    cawOwnership[tokenId] = precision * newCawBalance / rewardMultiplier;
  }

  function updateOwners(uint64[] calldata tokenIds, address[] calldata owners) internal {
    for (uint i = 0; i < tokenIds.length; i++)
      setOwnerOf(tokenIds[i], owners[i]);
  }

  function mintAndUpdateOwners(uint64 tokenId, address owner, string memory username, uint64[] calldata tokenIds, address[] calldata owners) internal {
    usernames[tokenId] = username;
    ownerOf[tokenId] = owner;

    updateOwners(tokenIds, owners);
  }

  function setOwnerOf(uint64 tokenId, address newOwner) internal {
    ownerOf[tokenId] = newOwner;
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
    return selector == bytes4(keccak256("addToBalanceAndUpdateOwners(uint64,uint256,uint64[],address[])")) || 
      selector == bytes4(keccak256("mintAndUpdateOwners(uint64,address,string memory,uint64[],address[])")) ||
      selector == bytes4(keccak256("updateOwners(uint64[],address[])"));
  }


  // Will use to send withdrawable amount to L1
  function lzSend(bytes4 selector, bytes memory payload) internal {
    uint256 gasPrice = 0;
    bytes memory _options = abi.encode(
      gasLimitFor(selector),  // The gas limit for the execution of the message on L2
      uint256(gasPrice)   // The gas price you are willing to pay on L2
    );

    _lzSend(
      layer1EndpointId, // Destination chain's endpoint ID.
      payload, // Encoded message payload being sent.
      _options, // Message execution options (e.g., gas to use on destination).
      MessagingFee(msg.value, 0), // Fee struct containing native gas and ZRO token.
      payable(msg.sender) // The refund address in case the send call reverts.
    );
  }

  function gasLimitFor(bytes4 selector) public view returns (uint256) {
    if (selector == setWithdrawableSelector)
      return 300000;
  }

}


