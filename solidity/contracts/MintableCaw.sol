// contracts/MintableCaw.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MintableCaw
/// @notice TEST/DEV ONLY — a permissionless mintable ERC20 used as a stand-in for the real CAW
///         token on local testnets. The real CAW token is an already-deployed ERC20 on mainnet
///         and L2 (a-hunters-dream); CawProfile / CawProfileLedger are configured to point at it directly.
///         This contract MUST NEVER be deployed to mainnet under any circumstances. The
///         unrestricted `mint()` function would let anyone create unlimited tokens.
contract MintableCaw is ERC20 {

  constructor() ERC20("Mintable Caw", "mCAW") {
    _mint(msg.sender, 100_000_000 * (10 ** uint256(decimals())));
  }

  /// @notice TEST ONLY — anyone can mint any amount. Do not use on mainnet.
  function mint(address account, uint256 amount) external {
    _mint(account, amount);
  }
}

