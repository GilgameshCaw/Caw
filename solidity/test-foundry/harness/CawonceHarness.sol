// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Standalone re-implementation of the CawActions cawonce bitmap
///         (see CawActions.sol::useCawonce / nextCawonce / isCawonceUsed),
///         lifted into a public surface for invariant testing without the
///         rest of the CawActions deploy graph.
///
/// @dev Functions match the production names so any tweak can be cross-applied.
///      The invariant we want to lock in is:
///
///        Once `useCawonce(senderId, c)` succeeds, `isCawonceUsed(senderId, c)`
///        is permanently true and `useCawonce(senderId, c)` reverts on a
///        subsequent call.
///
///      Production never calls useCawonce twice for the same (senderId, cawonce)
///      because the entry path in processActions reverts up-front via the same
///      isCawonceUsed check, but the invariant test pretends a buggier upper
///      layer might double-call and asserts the bitmap detects the collision.
contract CawonceHarness {
    mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
    mapping(uint32 => uint256) public currentCawonceMap;

    /// @notice Same shape as CawActions: revert if already-used; otherwise mark.
    function useCawonce(uint32 senderId, uint256 cawonce) external {
        require(!isCawonceUsed(senderId, cawonce), "Cawonce already used");
        uint256 word = cawonce >> 8;
        uint256 bit = cawonce & 0xff;
        uint256 newWord = usedCawonce[senderId][word] | (1 << bit);
        usedCawonce[senderId][word] = newWord;
        if (newWord == type(uint256).max) {
            currentCawonceMap[senderId] = word + 1;
        }
    }

    function isCawonceUsed(uint32 senderId, uint256 cawonce) public view returns (bool) {
        uint256 word = cawonce >> 8;
        uint256 bit = cawonce & 0xff;
        return (usedCawonce[senderId][word] & (1 << bit)) != 0;
    }

    function nextCawonce(uint32 senderId) public view returns (uint256) {
        uint256 currentMap = currentCawonceMap[senderId];
        uint256 word = usedCawonce[senderId][currentMap];
        if (word == 0) return currentMap * 256;
        uint256 nextSlot;
        for (nextSlot = 0; nextSlot < 256; ) {
            if (((1 << nextSlot) & word) == 0) break;
            unchecked { ++nextSlot; }
        }
        return (currentMap * 256) + nextSlot;
    }
}
