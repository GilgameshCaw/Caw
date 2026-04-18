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

  function mint(uint32 clientId, string memory username, uint256 lzTokenAmount) public payable {
    require(idByUsername[username] == 0, "Username has already been taken");
    require(isValidUsername(username), "Username must only consist of 1-255 lowercase letters and numbers");
    uint256 amount = costOfName(username);

    require(CAW.balanceOf(_msgSender()) >= amount, "You do not have enough CAW to make this purchase");
    require(CAW.allowance(_msgSender(), address(this)) >= amount, "You must approve spending of your CAW");
    CAW.transferFrom(_msgSender(), address(0xdEAD000000000000000042069420694206942069), amount);

    uint32 newId = CawProfile.nextId();
    idByUsername[username] = newId;

    CawProfile.mint{value: msg.value}(clientId, msg.sender, username, newId, lzTokenAmount);
  }

  /// @notice Mint a username and deposit CAW in one transaction.
  /// @dev The user only needs to approve the Minter for the full amount (burn + deposit).
  ///      The Minter pulls all CAW from the user, burns the burn portion, and forwards
  ///      the deposit portion to CawProfile.
  /// @param clientId The client ID to authenticate with
  /// @param username The username to mint
  /// @param depositAmount The amount of CAW to deposit (in wei)
  /// @param lzDestId The L2 chain endpoint ID for the deposit
  /// @param lzTokenAmount LZ token amount for fees (usually 0)
  function mintAndDeposit(uint32 clientId, string memory username, uint256 depositAmount, uint32 lzDestId, uint256 lzTokenAmount) public payable {
    require(idByUsername[username] == 0, "Username has already been taken");
    require(isValidUsername(username), "Username must only consist of 1-255 lowercase letters and numbers");
    uint256 burnAmount = costOfName(username);

    uint256 totalCawNeeded = burnAmount + depositAmount;
    require(CAW.balanceOf(_msgSender()) >= totalCawNeeded, "You do not have enough CAW");
    require(CAW.allowance(_msgSender(), address(this)) >= totalCawNeeded, "You must approve spending of your CAW");

    // Burn CAW for the username
    CAW.transferFrom(_msgSender(), address(0xdEAD000000000000000042069420694206942069), burnAmount);

    // Pull the deposit portion from the user into this contract,
    // then approve CawProfile to transferFrom this contract during mintAndDeposit.
    if (depositAmount > 0) {
      CAW.transferFrom(_msgSender(), address(this), depositAmount);
      CAW.approve(address(CawProfile), depositAmount);
    }

    uint32 newId = CawProfile.nextId();
    idByUsername[username] = newId;

    // Mint + deposit in one call (CawProfile pulls depositAmount from this contract)
    CawProfile.mintAndDeposit{value: msg.value}(clientId, msg.sender, username, newId, depositAmount, lzDestId, lzTokenAmount);
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
