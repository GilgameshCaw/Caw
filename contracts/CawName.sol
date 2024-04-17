// contracts/CawName.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../node_modules/@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "../node_modules/@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";
import "../node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../node_modules/@openzeppelin/contracts/access/Ownable.sol";
import "./CawNameURI.sol";

// AccessControlEnumerable,
contract CawName is 
  Context,
  ERC721Enumerable,
  Ownable
{

  IERC20 public immutable CAW;
  CawNameURI public uriGenerator;

  uint256 public totalCaw;

  address public minter;
  address public cawActions;

  string[] public usernames;

  // mapping(uint256 => uint256) public previousOwners;
  mapping(uint64 => uint256) public cawOwnership;

  uint256 public rewardMultiplier = 10**18;
  uint256 public precision = 30425026352721 ** 2;// ** 3;

  struct Token {
    uint256 tokenId;
    uint256 balance;
    string username;
  }

  constructor(address _caw, address _gui) ERC721("CAW NAME", "cawNAME") {
    uriGenerator = CawNameURI(_gui);
    CAW = IERC20(_caw);
    // CAW = IERC20(0xf3b9569F82B18aEf890De263B84189bd33EBe452);
  }

  function setMinter(address _minter) public onlyOwner {
    minter = _minter;
  }

  function setCawActions(address _cawActions) public onlyOwner {
    cawActions = _cawActions;
  }

  // create an ARTIST_ROLE
  function setUriGenerator(address _gui) public onlyOwner {
    uriGenerator = CawNameURI(_gui);
  }

  function tokenURI(uint256 tokenId) override public view returns (string memory) {
    return uriGenerator.generate(usernames[uint64(tokenId) - 1]);
  }

  function mint(address sender, string memory username, uint64 newId) public {
    require(minter == _msgSender(), "caller is not the minter");
    usernames.push(username);
    _safeMint(sender, newId);
  }

  function nextId() public view returns (uint64) {
    return uint64(usernames.length) + 1;
  }

  function tokens(address user) external view returns (Token[] memory) {
    uint256 tokenId;
    uint256 balance = balanceOf(user);
    Token[] memory userTokens = new Token[](balance);
    for (uint64 i = 0; i < balance; i++) {
      tokenId = tokenOfOwnerByIndex(user, i);

      userTokens[i].balance = cawBalanceOf(uint64(tokenId));
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
    setCawBalance(tokenId, cawBalanceOf(tokenId) + amount);
    totalCaw += amount;
  }

  function withdraw(uint64 tokenId, uint256 amount) public {
    require(ownerOf(tokenId) == msg.sender, "can not withdraw from a CawName that you do not own");
    require(cawBalanceOf(tokenId) >= amount, "insufficent CAW balance");

    setCawBalance(tokenId, cawBalanceOf(tokenId) - amount);
    CAW.transfer(msg.sender, amount);
    totalCaw -= amount;
  }

  function cawBalanceOf(uint64 tokenId) public view returns (uint256){
    return cawOwnership[tokenId] * rewardMultiplier / (precision);
  }

  function spendAndDistribute(uint64 tokenId, uint256 amountToSpend, uint256 amountToDistribute) external {
    spendAndDistributeWei(tokenId, amountToSpend * 10**18, amountToDistribute * 10**18);
  }

  function spendAndDistributeWei(uint64 tokenId, uint256 amountToSpend, uint256 amountToDistribute) public {
    require(cawActions == _msgSender(), "caller is not the cawActions contract");
    uint256 balance = cawBalanceOf(tokenId);

    require(balance >= amountToSpend, 'insufficent CAW balance');
    uint256 newCawBalance = balance - amountToSpend;

    rewardMultiplier += rewardMultiplier * amountToDistribute / (totalCaw - balance);
    setCawBalance(tokenId, newCawBalance);
  }

  function addToBalance(uint64 tokenId, uint256 amount) external {
    addWeiToBalance(tokenId, amount * 10**18);
  }

  function addWeiToBalance(uint64 tokenId, uint256 amount) public {
    require(cawActions == _msgSender(), "caller is not the cawActions");

    setCawBalance(tokenId, cawBalanceOf(tokenId) + amount);
  }

  function setCawBalance(uint64 tokenId, uint256 newCawBalance) internal {
    cawOwnership[tokenId] = precision * newCawBalance / rewardMultiplier;
  }

}

