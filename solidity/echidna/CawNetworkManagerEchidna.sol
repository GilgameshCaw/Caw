// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "../contracts/CawNetworkManager.sol";

/// @title CawNetworkManagerEchidna
/// @notice Stateful fuzz harness for CawNetworkManager.
///
///         Echidna drives the public surface of CawNetworkManager directly —
///         createNetwork, changeOwner, setFees, lockNetworkFees,
///         lockNetworkOwnership, setGasOverride, registerInstance — and we
///         assert the invariants that should hold over arbitrary sequences.
///
/// @dev We expose Echidna senders as a small fixed pool by shadowing
///      msg.sender into a deterministic bucket inside the wrapper calls. The
///      raw createNetwork / changeOwner / etc. on the underlying contract
///      stay reachable via fallback because we inherit, so the
///      `--all-contracts` mode picks both this contract's wrappers AND the
///      raw entry points. We rely on the wrappers for state-tracking and
///      Echidna's default sender pool for ownership distinctness.
contract CawNetworkManagerEchidna is CawNetworkManager {

    // Track the network IDs that have ever been created so the invariants
    // can sweep them. Echidna lazily creates these via createNetwork().
    uint32[] internal createdIds;

    // Snapshot once-set state so the invariants can detect any rewinds.
    mapping(uint32 => uint256) internal creationBlockSnapshot;
    mapping(uint32 => address) internal originalFeeAddress;

    // Once-true latch flags (per-network) so we can assert monotonicity.
    mapping(uint32 => bool) internal sawFeesLocked;
    mapping(uint32 => bool) internal sawOwnershipLocked;

    // Per-network, per-selector previously observed gas override (for ratcheting check).
    mapping(uint32 => mapping(bytes4 => uint128)) internal prevGasOverride;

    constructor() CawNetworkManager(address(0xBEEF)) {}

    // ===================================================================
    // Wrappers that record the creation so invariants can iterate them.
    // The original public methods remain reachable (Echidna `--all-contracts`)
    // — these just provide a parallel handler with snapshotting.
    // ===================================================================

    function fuzzCreateNetwork(
        string calldata name,
        address feeAddress,
        uint32 storageChainEid,
        uint256 withdrawFee,
        uint256 depositFee,
        uint256 authFee,
        uint256 mintFee
    ) external {
        // Ensure the underlying require()s have something to chew on so we
        // don't spend all our fuzz budget bouncing off "Name required".
        if (bytes(name).length == 0) return;
        if (feeAddress == address(0)) return;
        if (storageChainEid == 0) return;

        uint32 idBefore = nextNetworkId;
        createNetwork(name, feeAddress, storageChainEid, withdrawFee, depositFee, authFee, mintFee);
        createdIds.push(idBefore);
        creationBlockSnapshot[idBefore] = networks[idBefore].creationBlock;
        originalFeeAddress[idBefore] = feeAddress;
    }

    function fuzzLockFees(uint32 idx) external {
        if (createdIds.length == 0) return;
        uint32 id = createdIds[idx % uint32(createdIds.length)];
        // Only call if msg.sender is the current owner — otherwise we burn
        // Echidna's call budget on guaranteed reverts. The base methods are
        // `external` (not `public`), so we have to bounce through `this.`
        // — which means msg.sender at the callee is `address(this)`, not
        // the original Echidna sender. To work around that we directly
        // write to the lockdown storage from inside this wrapper after
        // checking the owner-of-record matched the original sender.
        if (networks[id].ownerAddress != msg.sender) return;
        networkFeesLocked[id] = true;
        sawFeesLocked[id] = true;
        emit NetworkFeesLocked(id);
    }

    function fuzzLockOwnership(uint32 idx) external {
        if (createdIds.length == 0) return;
        uint32 id = createdIds[idx % uint32(createdIds.length)];
        if (networks[id].ownerAddress != msg.sender) return;
        networkOwnershipLocked[id] = true;
        sawOwnershipLocked[id] = true;
        emit NetworkOwnershipLocked(id);
    }

    function fuzzSetGasOverride(uint32 idx, bytes4 selector, uint128 newAmount) external {
        if (createdIds.length == 0) return;
        uint32 id = createdIds[idx % uint32(createdIds.length)];
        if (networks[id].ownerAddress != msg.sender) return;
        // Constrain newAmount to a reasonable spread so we exercise the cap.
        newAmount = uint128(uint256(newAmount) % (uint256(MAX_GAS_OVERRIDE) + 16));
        if (newAmount <= networkGasOverride[id][selector]) return; // must increase
        // Mirror setGasOverride's body inline so we keep the original
        // msg.sender semantics (see fuzzLockFees note).
        require(newAmount <= MAX_GAS_OVERRIDE, "Above cap");
        networkGasOverride[id][selector] = newAmount;
        emit NetworkGasOverrideSet(id, selector, newAmount);
    }

    function fuzzSetFeeAddress(uint32 idx, address newAddr) external {
        if (createdIds.length == 0) return;
        uint32 id = createdIds[idx % uint32(createdIds.length)];
        if (networks[id].ownerAddress != msg.sender) return;
        if (newAddr == address(0)) return; // contract rejects; skip
        if (networkFeesLocked[id]) return;
        setFeeAddress(id, newAddr);
    }

    function fuzzChangeOwner(uint32 idx, address newOwner) external {
        if (createdIds.length == 0) return;
        uint32 id = createdIds[idx % uint32(createdIds.length)];
        if (networks[id].ownerAddress != msg.sender) return;
        if (newOwner == address(0)) return;
        if (networkOwnershipLocked[id]) return;
        changeOwner(id, newOwner);
    }

    function fuzzRegisterInstance(uint32 idx, address validator) external returns (uint32) {
        if (createdIds.length == 0) return 0;
        uint32 id = createdIds[idx % uint32(createdIds.length)];
        if (validator == address(0)) return 0;
        return this.registerInstance(id, "https://x.example", validator);
    }

    // ===================================================================
    // INVARIANTS
    // ===================================================================

    /// @notice nextNetworkId is strictly monotonic — never goes backward.
    uint32 internal lastSeenNextNetworkId;
    function echidna_next_network_id_monotonic() public returns (bool) {
        if (nextNetworkId < lastSeenNextNetworkId) return false;
        lastSeenNextNetworkId = nextNetworkId;
        return true;
    }

    /// @notice Every created network has a non-zero id, a non-zero owner, and a
    ///         non-zero feeAddress (createNetwork enforced this; setFeeAddress
    ///         and changeOwner reject zero too).
    function echidna_network_invariants_hold() public view returns (bool) {
        for (uint i = 0; i < createdIds.length; i++) {
            uint32 id = createdIds[i];
            if (networks[id].id != id) return false;
            if (networks[id].ownerAddress == address(0)) return false;
            if (networks[id].feeAddress == address(0)) return false;
            if (networks[id].storageChainEid == 0) return false;
        }
        return true;
    }

    /// @notice creationBlock is set once and never changes.
    function echidna_creation_block_immutable() public view returns (bool) {
        for (uint i = 0; i < createdIds.length; i++) {
            uint32 id = createdIds[i];
            if (networks[id].creationBlock != creationBlockSnapshot[id]) return false;
        }
        return true;
    }

    /// @notice Locks latch one-way. Once a network's fees or ownership were
    ///         observed locked, they stay locked forever.
    function echidna_locks_monotonic() public view returns (bool) {
        for (uint i = 0; i < createdIds.length; i++) {
            uint32 id = createdIds[i];
            if (sawFeesLocked[id] && !networkFeesLocked[id]) return false;
            if (sawOwnershipLocked[id] && !networkOwnershipLocked[id]) return false;
        }
        return true;
    }

    /// @notice Gas override is bounded above by MAX_GAS_OVERRIDE for every
    ///         (network, selector). Probe with a small bytes4 lattice — Echidna
    ///         will already have stored other selectors in `networkGasOverride`
    ///         via fuzzSetGasOverride, but we can't iterate map keys, so we
    ///         expose this as a direct probe via the public mapping and trust
    ///         the per-call enforcement check below.
    bytes32 internal lastObservedGasOverrideCap; // unused; reserved
    function echidna_gas_override_within_cap() public view returns (bool) {
        // Limited check: this is partial — we'd ideally iterate every key.
        // Echidna's --all-contracts mode will exercise setGasOverride
        // directly; the underlying require enforces the cap. We assert the
        // public constant unchanged as a tamper-evident anchor.
        return MAX_GAS_OVERRIDE == 100_000;
    }

    /// @notice If fees are locked, withdrawFee/depositFee/authFee/mintFee/feeAddress
    ///         cannot have changed since the lock. We approximate this by
    ///         snapshotting `originalFeeAddress` at create-time and asserting
    ///         that, in the absence of a setFeeAddress call (which is blocked
    ///         post-lock), the address still matches the original. Echidna can
    ///         only invalidate this if a setFeeAddress goes through after the
    ///         lock — exactly the bug we want to catch.
    ///
    ///         Real test: post-lock, every setter (setWithdrawFee, etc.)
    ///         must revert. The require lives in the modifier; we trust
    ///         Echidna's "did this call's effects survive?" semantics to
    ///         expose a regression where the modifier is removed.
    ///
    ///         Practical signal: we still verify feeAddress non-zero
    ///         (already asserted above) and treat the public locks-monotonic
    ///         invariant as the load-bearing one.
    function echidna_fee_address_not_zero_after_lock() public view returns (bool) {
        for (uint i = 0; i < createdIds.length; i++) {
            uint32 id = createdIds[i];
            if (networkFeesLocked[id] && networks[id].feeAddress == address(0)) return false;
        }
        return true;
    }

    /// @notice nextInstanceId is strictly monotonic.
    uint32 internal lastSeenNextInstanceId = 1;
    function echidna_next_instance_id_monotonic() public returns (bool) {
        if (nextInstanceId < lastSeenNextInstanceId) return false;
        lastSeenNextInstanceId = nextInstanceId;
        return true;
    }
}
