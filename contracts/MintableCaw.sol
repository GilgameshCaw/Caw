// contracts/CawName.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MintableCaw is ERC20 {

  constructor() ERC20("Mintable Caw", "mCAW") {
    _mint(msg.sender, 100_000_000 * (10 ** uint256(decimals())));
  }

  function mint(address account, uint256 amount) external {
    _mint(account, amount);
  }
}

