// contracts/CawProfileMinter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IMint.sol";

contract CawProfileMinter is Context {

  mapping(string => uint32) public idByUsername;

  IMint CawProfile;
  IERC20 CAW;

  constructor(address _caw, address _cawProfiles) {
    CAW = IERC20(_caw);
    CawProfile = IMint(_cawProfiles);
  }

  // ============================================
  // PRIMARY ENTRYPOINTS — owner mints for themselves
  // ============================================
  // The plain `mint` / `mintAndAuth` / `mintAndDeposit` functions are thin
  // recipient=msg.sender wrappers. The real work lives in their `*For`
  // variants below — same pattern as `deposit` ↔ `depositFor` on CawProfile,
  // so an external router contract can collect any currency from the user
  // and call `mintFor`/`mintAndAuthFor`/`mintAndDepositFor` on their behalf
  // (CAW for the burn + deposit comes from the router's balance).

  function mint(uint32 clientId, string memory username, uint256 lzTokenAmount) public payable {
    mintFor(clientId, msg.sender, username, lzTokenAmount);
  }

  function mintAndAuth(uint32 clientId, string memory username, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    mintAndAuthFor(clientId, msg.sender, username, lzDestId, lzTokenAmount);
  }

  function mintAndDeposit(uint32 clientId, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    mintAndDepositFor(clientId, msg.sender, username, depositAmount, lzDestId, lzTokenAmount);
  }

  // ============================================
  // *For VARIANTS — caller pays in CAW, NFT goes to `recipient`
  // ============================================

  /// @notice Mint a username on behalf of `recipient`. The burn-cost CAW is pulled from
  ///         `msg.sender`, but the Profile NFT (and ownership of any future deposit) goes
  ///         to `recipient`. Mirrors depositFor's pattern so external routers can offer
  ///         "pay in <other-currency>, get a CAW Profile" without holding the user's CAW.
  function mintFor(uint32 clientId, address recipient, string memory username, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, 0);
    CawProfile.mint{value: msg.value}(clientId, recipient, username, newId, lzTokenAmount);
  }

  /// @notice mintAndAuth on behalf of `recipient`. The burn cost is pulled from msg.sender.
  function mintAndAuthFor(uint32 clientId, address recipient, string memory username, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, 0);
    CawProfile.mintAndAuth{value: msg.value}(clientId, recipient, username, newId, lzDestId, lzTokenAmount);
  }

  /// @notice mintAndDeposit on behalf of `recipient`. burn + deposit CAW is pulled from
  ///         msg.sender; the NFT and the deposit credit go to `recipient`.
  function mintAndDepositFor(uint32 clientId, address recipient, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    uint32 newId = _burnAndAssignId(username, depositAmount);
    if (depositAmount > 0) {
      // Pull the deposit portion into this contract and approve CawProfile to pull it back —
      // mirrors the original mintAndDeposit pattern (CawProfile expects the deposit CAW
      // to be transferable from the Minter's allowance during its mintAndDeposit call).
      CAW.transferFrom(_msgSender(), address(this), depositAmount);
      CAW.approve(address(CawProfile), depositAmount);
    }
    CawProfile.mintAndDeposit{value: msg.value}(clientId, recipient, username, newId, depositAmount, lzDestId, lzTokenAmount);
  }

  /// @dev Shared prologue for every mint path: validate the username, take the burn cost
  ///      from msg.sender, register the new tokenId, and return it. `extraCawNeeded` is the
  ///      additional CAW msg.sender must hold + have approved beyond burnAmount (e.g. the
  ///      deposit portion in mintAndDepositFor). Pulling the extra is the caller's job —
  ///      this function only verifies the headroom and burns the burn portion.
  function _burnAndAssignId(string memory username, uint256 extraCawNeeded) internal returns (uint32 newId) {
    require(idByUsername[username] == 0, "Username has already been taken");
    require(isValidUsername(username), "Username must only consist of 1-255 lowercase letters and numbers");
    uint256 burnAmount = costOfName(username);
    uint256 totalCawNeeded = burnAmount + extraCawNeeded;

    require(CAW.balanceOf(_msgSender()) >= totalCawNeeded, "You do not have enough CAW to make this purchase");
    require(CAW.allowance(_msgSender(), address(this)) >= totalCawNeeded, "You must approve spending of your CAW");
    CAW.transferFrom(_msgSender(), address(0xdEAD000000000000000042069420694206942069), burnAmount);

    newId = CawProfile.nextId();
    idByUsername[username] = newId;
  }

  function isValidUsername(string memory _input) public pure returns (bool) {
    bytes memory input = bytes(_input);
    if (input.length == 0 || input.length > 255) return false;

    for (uint256 i = 0; i < input.length; i++) {
      uint8 char = uint8(input[i]);
      if (
        (char < 48 || char > 57) && // not a number
          (char < 97 || char > 122) // not a lowercase character
      ) return false;
    }

    return true;
  }

  function costOfName(string memory username) public pure returns (uint256) {
    uint8 usernameLength = uint8(bytes(username).length);
    uint256 amount;

    // FROM THE SPEC:
    //
    // Every username is unique, and may use a-z and 0-9,
    //   without the use of special characters (emojis, etc..,) or capital letters. 
    //
    // - Single Character username (rare!) BURN 1,000,000,000,000 ($89,985, $1,799,712, $17,997,120) 
    // - 2 Character username - BURN 240,000,000,000 CAW ($21,600, $432,000, $4,320,000) 
    // - 3 Character Username - BURN 60,000,000,000 CAW ($5400, $108,000, $1,080,000) 
    // - 4 Character Username - BURN 6,000,000,000 CAW ($540, $10,800 $108,000) 
    // - 5 Character username - BURN 200,000,000 CAW ($18, $360, $3600) 
    // - 6 Character username - BURN 20,000,000 CAW ($1.80, $36, $360) 
    // - 7 Character username -BURN 10,000,000 CAW (90c, $18, $180) 
    // - 8 Character and up username - BURN 1,000,000 CAW (9c, $1.80, $18) 


    if (usernameLength == 1)
      amount = 10 ** 12; // 1,000,000,000,000
    else if (usernameLength == 2)
      amount = 24 * 10 ** 10; // 240,000,000,000
    else if (usernameLength == 3)
      amount = 6 * 10 ** 10;  // 60,000,000,000
    else if (usernameLength == 4)
      amount = 6 * 10 ** 9;  // 6,000,000,000
    else if (usernameLength == 5)
      amount = 2 * 10 ** 8; // 200,000,000
    else if (usernameLength == 6)
      amount = 2 * 10 ** 7; // 20,000,000
    else if (usernameLength == 7)
      amount = 10 ** 7; // 10,000,000
    else amount = 10 ** 6; // 1,000,000

    return amount * 10**18;
  }
}
