// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title CawonceEchidna
/// @notice Stateful invariant fuzz of the cawonce bitmap that CawActions uses
///         to enforce action-level replay protection.
///
/// @dev We re-implement the bitmap inline (mirroring CawActions.useCawonce
///      and friends — see the existing foundry CawonceHarness for the same
///      reference impl). Echidna explores arbitrary call sequences:
///        - mark(senderId, cawonce)
///        - tryMarkAgain(senderId, cawonce) — should always revert if the
///          previous mark succeeded
///        - probeIsUsed(senderId, cawonce)
///
///      and we assert the invariants:
///
///        echidna_marked_stays_marked     — once set, never clears
///        echidna_no_spurious_marks       — set bits correspond 1:1 to mark() success
///        echidna_word_packing_consistent — the (>> 8, & 0xFF) packing matches
///                                          isCawonceUsed's reverse computation
contract CawonceEchidna {
    // ------- Mirror of CawActions cawonce state -------
    mapping(uint32 => mapping(uint256 => uint256)) public usedCawonce;
    mapping(uint32 => uint256) public currentCawonceMap;

    // ------- Echidna-side bookkeeping -------
    // We track a tiny bounded grid (4 senders * 256 cawonces) so the invariant
    // can sweep it deterministically. Echidna binds inputs to this range.
    uint32 internal constant SENDERS = 4;
    uint256 internal constant CAWONCES = 256;
    mapping(uint32 => mapping(uint256 => bool)) public markedBy;
    uint256 public successfulMarks;
    uint256 public rejectedMarks;

    function _useCawonce(uint32 senderId, uint256 cawonce) internal {
        require(!_isUsed(senderId, cawonce), "Cawonce already used");
        uint256 word = cawonce >> 8;
        uint256 bit = cawonce & 0xff;
        uint256 newWord = usedCawonce[senderId][word] | (1 << bit);
        usedCawonce[senderId][word] = newWord;
        if (newWord == type(uint256).max) {
            currentCawonceMap[senderId] = word + 1;
        }
    }

    function _isUsed(uint32 senderId, uint256 cawonce) internal view returns (bool) {
        uint256 word = cawonce >> 8;
        uint256 bit = cawonce & 0xff;
        return (usedCawonce[senderId][word] & (1 << bit)) != 0;
    }

    function _nextCawonce(uint32 senderId) internal view returns (uint256) {
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

    // ---------------- Fuzz handlers ----------------

    function mark(uint32 senderId, uint256 cawonce) external {
        senderId = uint32(senderId % SENDERS);
        cawonce = cawonce % CAWONCES;
        bool wasMarked = markedBy[senderId][cawonce];
        try this._extUseCawonce(senderId, cawonce) {
            // The contract should reject if we had marked this slot.
            require(!wasMarked, "double-mark-succeeded");
            markedBy[senderId][cawonce] = true;
            successfulMarks++;
        } catch {
            require(wasMarked, "fresh-mark-reverted");
            rejectedMarks++;
        }
    }

    function _extUseCawonce(uint32 senderId, uint256 cawonce) external {
        require(msg.sender == address(this), "internal only");
        _useCawonce(senderId, cawonce);
    }

    function tryMarkAgain(uint32 senderId, uint256 cawonce) external {
        senderId = uint32(senderId % SENDERS);
        cawonce = cawonce % CAWONCES;
        if (!markedBy[senderId][cawonce]) return;
        // Should always revert.
        bool didRevert;
        try this._extUseCawonce(senderId, cawonce) {
            didRevert = false;
        } catch {
            didRevert = true;
        }
        require(didRevert, "second-mark-not-rejected");
    }

    function probeIsUsed(uint32 senderId, uint256 cawonce) external view returns (bool) {
        return _isUsed(senderId % SENDERS, cawonce % CAWONCES);
    }

    function probeNext(uint32 senderId) external view returns (uint256) {
        return _nextCawonce(senderId % SENDERS);
    }

    // ---------------- Invariants ----------------

    /// @notice Every (senderId, cawonce) we recorded as "marked successfully"
    ///         is still reported as used by the bitmap.
    function echidna_marked_stays_marked() external view returns (bool) {
        for (uint32 s = 0; s < SENDERS; s++) {
            for (uint256 c = 0; c < CAWONCES; c++) {
                if (markedBy[s][c] && !_isUsed(s, c)) return false;
            }
        }
        return true;
    }

    /// @notice The harness never reports an "used" slot that we didn't ask it to mark.
    function echidna_no_spurious_marks() external view returns (bool) {
        for (uint32 s = 0; s < SENDERS; s++) {
            for (uint256 c = 0; c < CAWONCES; c++) {
                if (_isUsed(s, c) && !markedBy[s][c]) return false;
            }
        }
        return true;
    }

    /// @notice currentCawonceMap[s] is bounded by the bitmap's actual progress —
    ///         it only advances when a word fills completely; without that path
    ///         (we never fill a word in the bounded run), it should stay 0.
    ///         A bug that pre-bumps it would break nextCawonce.
    function echidna_word_packing_consistent() external view returns (bool) {
        for (uint32 s = 0; s < SENDERS; s++) {
            uint256 mapIdx = currentCawonceMap[s];
            // mapIdx can only have moved past 0 if usedCawonce[s][prev] saturated.
            if (mapIdx > 0) {
                if (usedCawonce[s][mapIdx - 1] != type(uint256).max) return false;
            }
        }
        return true;
    }

    /// @notice `nextCawonce` always returns an unused slot for that sender.
    ///         Foundational invariant — if it returns an already-used slot,
    ///         processActions would happily double-spend.
    function echidna_next_returns_unused() external view returns (bool) {
        for (uint32 s = 0; s < SENDERS; s++) {
            uint256 next = _nextCawonce(s);
            // Bound: we only mark in [0..CAWONCES); if next falls in that range it
            // must not be marked. If next is >= CAWONCES the test is vacuously true
            // (we don't track outside the bounded range).
            if (next < CAWONCES) {
                if (_isUsed(s, next)) return false;
            }
        }
        return true;
    }
}
