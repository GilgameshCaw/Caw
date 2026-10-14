// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../../contracts/SmartEOA.sol";

/// @title SmartEOAInit
/// @notice Helpers for SmartEOA.initialize, which requires a sig from the EOA's
///         own key (initSig) over every argument.
/// @dev Tests stand in for a 7702 delegation by etching SmartEOA's runtime code
///      at vm.addr(pk), so address(this) inside SmartEOA is an address whose
///      key the test holds.
abstract contract SmartEOAInit is Test {
    /// @dev Mirrors SmartEOA._initializeDigest for `account` on the current chain.
    function _initDigest(
        address account,
        bytes32 pubkeyX,
        bytes32 pubkeyY,
        address ecdsaFallbackAddr,
        address minterContract,
        bytes memory mintCalldata
    ) internal view returns (bytes32) {
        bytes32 domainSep = keccak256(abi.encode(
            keccak256("SmartEOA"),
            block.chainid,
            account
        ));
        bytes32 structHash = keccak256(abi.encode(
            keccak256(bytes("initialize")),
            pubkeyX,
            pubkeyY,
            ecdsaFallbackAddr,
            minterContract,
            keccak256(mintCalldata)
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    /// @dev initSig for the account at vm.addr(eoaPk).
    function _initSig(
        uint256 eoaPk,
        bytes32 pubkeyX,
        bytes32 pubkeyY,
        address ecdsaFallbackAddr,
        address minterContract,
        bytes memory mintCalldata
    ) internal view returns (bytes memory) {
        bytes32 digest = _initDigest(
            vm.addr(eoaPk), pubkeyX, pubkeyY, ecdsaFallbackAddr, minterContract, mintCalldata
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(eoaPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Put SmartEOA's runtime code at vm.addr(eoaPk) — the test stand-in
    ///      for a 7702 delegation to the SmartEOA implementation.
    function _delegatedAccount(uint256 eoaPk) internal returns (SmartEOA) {
        address account = vm.addr(eoaPk);
        vm.etch(account, address(new SmartEOA()).code);
        return SmartEOA(payable(account));
    }
}
