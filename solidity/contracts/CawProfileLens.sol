// contracts/CawProfileLens.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Minimal subset of CawProfile that the lens needs to read.
 */
interface ICawProfile {
  function balanceOf(address owner) external view returns (uint256);
  function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
  function ownerOf(uint256 tokenId) external view returns (address);
  function usernames(uint256 index) external view returns (string memory);
  function withdrawable(uint32 tokenId) external view returns (uint256);
  function authenticated(uint32 networkId, uint32 tokenId) external view returns (bool);
  function withdrawFeeLocked(uint32 networkId, uint32 tokenId) external view returns (bool);
  function lockedWithdrawFee(uint32 networkId, uint32 tokenId) external view returns (uint256);
  function CAW() external view returns (IERC20);
}

interface ICawProfileMinter {
  function idByUsername(string memory username) external view returns (uint32);
}

/**
 * @title CawProfileLens
 * @notice Read-only bulk-query helper for CawProfile. Pairs with CawProfileQuoter
 *         as the second sibling read-only view contract — `Quoter` answers
 *         "how much will this tx cost," `Lens` answers "what tokens exist /
 *         what's their current state." Both exist to keep CawProfile.sol
 *         under EIP-170.
 *
 * @dev    Three views:
 *           - `tokens(owner)` — full profile structs for an address (replaces
 *             the V1 `CawProfile.tokens()` that was removed for bytecode budget)
 *           - `tokenByUsername(username)` — username → full profile
 *           - `profilesWithNetworkState(owner, networkId)` — bulk `tokens()`
 *             plus per-(network,tokenId) auth/lock state
 */
contract CawProfileLens {
  struct Token {
    uint32 tokenId;
    string username;
    address owner;
    uint256 ownerBalance;   // CAW.balanceOf(owner) — same across array
    uint256 withdrawable;
  }

  struct TokenWithNetworkState {
    uint32 tokenId;
    string username;
    address owner;
    uint256 ownerBalance;
    uint256 withdrawable;
    bool authenticated;
    bool withdrawFeeLocked;
    uint256 lockedWithdrawFee;
  }

  ICawProfile        public immutable cawProfile;
  ICawProfileMinter  public immutable cawProfileMinter;

  constructor(address _cawProfile, address _cawProfileMinter) {
    cawProfile = ICawProfile(_cawProfile);
    cawProfileMinter = ICawProfileMinter(_cawProfileMinter);
  }

  /// @notice All profiles owned by `owner` with username, withdrawable, and
  ///         the owner's CAW balance attached. Single RPC call.
  function tokens(address owner) external view returns (Token[] memory result) {
    uint256 n = cawProfile.balanceOf(owner);
    result = new Token[](n);
    if (n == 0) return result;
    uint256 ownerBalance = cawProfile.CAW().balanceOf(owner);
    for (uint256 i = 0; i < n; i++) {
      uint256 tokenId = cawProfile.tokenOfOwnerByIndex(owner, i);
      result[i] = Token({
        tokenId: uint32(tokenId),
        username: cawProfile.usernames(tokenId - 1),
        owner: owner,
        ownerBalance: ownerBalance,
        withdrawable: cawProfile.withdrawable(uint32(tokenId))
      });
    }
  }

  /// @notice Look up a profile by its lowercase username. Returns a zeroed
  ///         struct (tokenId == 0) when no such profile exists.
  function tokenByUsername(string memory username) external view returns (Token memory result) {
    uint32 tokenId = cawProfileMinter.idByUsername(username);
    if (tokenId == 0) return result; // username free / not minted
    address owner = cawProfile.ownerOf(tokenId);
    result = Token({
      tokenId: tokenId,
      username: username,
      owner: owner,
      ownerBalance: cawProfile.CAW().balanceOf(owner),
      withdrawable: cawProfile.withdrawable(tokenId)
    });
  }

  /// @notice Same as `tokens(owner)` but also reports the per-(network,tokenId)
  ///         auth + withdraw-fee-lock state. Useful for any page that needs
  ///         to know "has this profile authed to network N yet?" without
  ///         a fan-out of N extra RPC calls.
  function profilesWithNetworkState(
    address owner,
    uint32 networkId
  ) external view returns (TokenWithNetworkState[] memory result) {
    uint256 n = cawProfile.balanceOf(owner);
    result = new TokenWithNetworkState[](n);
    if (n == 0) return result;
    uint256 ownerBalance = cawProfile.CAW().balanceOf(owner);
    for (uint256 i = 0; i < n; i++) {
      uint32 tokenId = uint32(cawProfile.tokenOfOwnerByIndex(owner, i));
      result[i] = TokenWithNetworkState({
        tokenId: tokenId,
        username: cawProfile.usernames(uint256(tokenId) - 1),
        owner: owner,
        ownerBalance: ownerBalance,
        withdrawable: cawProfile.withdrawable(tokenId),
        authenticated: cawProfile.authenticated(networkId, tokenId),
        withdrawFeeLocked: cawProfile.withdrawFeeLocked(networkId, tokenId),
        lockedWithdrawFee: cawProfile.lockedWithdrawFee(networkId, tokenId)
      });
    }
  }
}
