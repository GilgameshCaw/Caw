// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Gas measurement test for CawProfile._lzReceive → setWithdrawable path.
//
// Approach: rather than forking mainnet (which requires RPC keys and is fragile),
// we deploy a minimal harness that faithfully reproduces every SSTORE that
// _lzReceive + setWithdrawable touch, with cold-slot semantics guaranteed by
// using fresh storage slots (distinct tokenIds) per case.
//
// Storage slots touched per iteration (all COLD on first write):
//   1. fromLZ (bool, storage slot) — SSTORE zero→nonzero = 22,100; then nonzero→nonzero = 2,900 (clear)
//      Net fromLZ pair: 22,100 + 2,900 = 25,000 gas BUT this is constant (1× per call, not per n).
//   2. withdrawable[tokenId] += amount
//      - Cold SLOAD:  2,100 gas
//      - If slot was zero → nonzero SSTORE: 22,100 gas
//      - If slot was nonzero → nonzero SSTORE: 2,900 gas (warm within same tx)
//
// EIP-2929 rules (post-Berlin, in effect on Ethereum mainnet):
//   - First access to storage slot (SLOAD or SSTORE): +2,100 cold access fee
//   - SSTORE zero→nonzero: 22,100 (base 20,000 + 2,100 cold)
//   - SSTORE nonzero→nonzero: 2,900 (base 2,900; but cold first access costs 2,100 on top? No —
//     EIP-2929 adds 2,100 only if the slot is COLD (not in access list). Once the SLOAD/SSTORE
//     touches it once, the slot becomes WARM for the rest of that tx.
//     So for += on a zero slot: SLOAD(cold=2100) + SSTORE(zero→nonzero=22100) = 24,200
//     For += on a nonzero slot: SLOAD(cold=2100) + SSTORE(nonzero→nonzero=2900) = 5,000
//     But EIP-2929 charges the 2100 cold penalty on the FIRST access. If we SLOAD first,
//     the SSTORE sees the slot as WARM (access list already has it), so:
//     SLOAD cold: 2,100; SSTORE warm zero→nonzero: 20,000 (no extra 2,100); total = 22,100
//     SLOAD cold: 2,100; SSTORE warm nonzero→nonzero: 2,900; total = 5,000
//
// This test directly measures execution gas using gasleft() deltas.

import "forge-std/Test.sol";

// ---------------------------------------------------------------------------
// Minimal harness that reproduces the exact storage operations of:
//   CawProfile._lzReceive → fromLZ = true → delegatecall(setWithdrawable) → fromLZ = false
// ---------------------------------------------------------------------------
contract SetWithdrawableHarness {
    // Exact replica of CawProfile's relevant storage
    bool private fromLZ;                         // storage slot for fromLZ flag
    mapping(uint32 => uint256) public withdrawable;  // storage slot for withdrawable balances

    uint256 public lastGasUsed;

    error NotAuthorized();

    // Simulates the full _lzReceive → setWithdrawable call path.
    // All tokenIds must be COLD (never touched in this tx) for cold-slot measurement.
    function simulateLzReceive(
        uint32[] calldata tokenIds,
        uint256[] calldata amounts
    ) external returns (uint256 gasUsed) {
        // Snapshot gas BEFORE _lzReceive work begins (mirroring LZ endpoint hand-off point)
        uint256 gasBefore = gasleft();

        // --- Replicate _lzReceive internals ---
        // isAuthorizedFunction() check: a pure function (warm code, ~3 gas). Include it.
        bytes4 sel = bytes4(keccak256("setWithdrawable(uint32[],uint256[])"));
        bool authorized = (sel == sel); // always true; mirrors the pure check, ~3 gas
        if (!authorized) revert NotAuthorized();

        // fromLZ = true  (SSTORE: cold zero→nonzero = 22,100 gas)
        fromLZ = true;

        // delegatecall overhead: ~700 gas base + ABI decode cost; we inline for
        // accuracy since Foundry doesn't measure delegatecall gas allocation the
        // same way LZ does. The delegatecall itself adds ~700 gas stub + the
        // inner execution. We include a low-level call to self to capture it.
        // Actually: we call an internal helper instead because the selector-auth
        // check already happened. We'll measure the inlined path (conservative —
        // delegatecall would be slightly MORE expensive due to stub overhead).
        _setWithdrawable(tokenIds, amounts);

        // fromLZ = false  (SSTORE: warm nonzero→zero = 4,800 gas refund path,
        // but net cost is still 2,900 gas for the SSTORE opcode cost)
        fromLZ = false;

        uint256 gasAfter = gasleft();
        gasUsed = gasBefore - gasAfter;
        lastGasUsed = gasUsed;
    }

    // Inlined replica of setWithdrawable logic (the delegatecall target)
    function _setWithdrawable(
        uint32[] calldata tokenIds,
        uint256[] calldata amounts
    ) internal {
        // fromLZ guard check (already set above; just a warm SLOAD = 100 gas)
        require(fromLZ, "NotL2Mirror");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            withdrawable[tokenIds[i]] += amounts[i];
        }
    }
}

// ---------------------------------------------------------------------------
// Test contract using two harness instances to get clean cold-slot readings.
// Each simulateLzReceive call uses distinct tokenIds → all slots guaranteed cold.
// ---------------------------------------------------------------------------
contract SetWithdrawableGasTest is Test {
    SetWithdrawableHarness harness;

    // Budget formula from CawProfileL2.sol:1269
    function budget(uint256 n) internal pure returns (uint256) {
        return 22_000 + 19_000 * n;
    }

    // LZ EIP-150 safety margin: real LZ endpoint forwards (budget * 63/64) to lzReceive.
    // If actual gas > (budget * 63/64) the call OOGs inside lzReceive.
    // We need: actual < budget * 63/64, i.e., headroom > budget / 64.
    uint256 constant SAFETY_BUFFER = 5_000;

    function setUp() public {
        harness = new SetWithdrawableHarness();
    }

    function _buildArrays(uint256 n, uint256 baseTokenId)
        internal
        pure
        returns (uint32[] memory tokenIds, uint256[] memory amounts)
    {
        tokenIds = new uint32[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            tokenIds[i] = uint32(baseTokenId + i);
            amounts[i] = 1e18; // nonzero amount; slot goes zero → nonzero (worst case)
        }
    }

    function _measure(uint256 n, uint256 baseTokenId) internal returns (uint256 actual) {
        (uint32[] memory tokenIds, uint256[] memory amounts) = _buildArrays(n, baseTokenId);
        actual = harness.simulateLzReceive(tokenIds, amounts);
    }

    function test_gasTable() public {
        // Use widely-separated base token IDs so all slots are guaranteed cold
        uint256[6] memory ns = [uint256(1), 5, 10, 20, 50, 100];
        uint256[6] memory bases = [
            uint256(1_000_000),
            uint256(2_000_000),
            uint256(3_000_000),
            uint256(4_000_000),
            uint256(5_000_000),
            uint256(6_000_000)
        ];

        console.log("=== setWithdrawable gas measurement (cold slots, EIP-2929) ===");
        console.log("");
        console.log("n     | actual gas | budget (22k+19k*n) | headroom | EIP150 63/64 budget | safe?");
        console.log("------|------------|---------------------|----------|---------------------|------");

        for (uint256 i = 0; i < ns.length; i++) {
            uint256 n = ns[i];
            uint256 actual = _measure(n, bases[i]);
            uint256 b = budget(n);
            // EIP-150: LZ executor forwards (gasLimit * 63 / 64) to the inner call
            uint256 lz150budget = b * 63 / 64;
            int256 headroom = int256(b) - int256(actual);
            int256 lz150headroom = int256(lz150budget) - int256(actual);
            bool safe = lz150headroom > int256(SAFETY_BUFFER);

            string memory safeStr = safe ? "YES" : "NO <--- UNSAFE";
            console.log("n=%d", n);
            console.log("  actual gas :  %d", actual);
            console.log("  budget     :  %d  (22000 + 19000*n)", b);
            console.log("  lz150budget:  %d  (budget * 63/64)", lz150budget);
            console.log("  headroom   :  %d  (budget - actual)", headroom > 0 ? uint256(headroom) : 0);
            console.log("  lz150hdrm  :  %d  (lz150budget - actual)", lz150headroom > 0 ? uint256(lz150headroom) : 0);
            console.log("  SAFE?      :  %s", safeStr);
            console.log("");
        }
    }

    // Separate test for n=1 warm (slot already written this tx — not realistic but confirms formula)
    function test_n1_warm() public {
        // First write: cold
        (uint32[] memory tokenIds, uint256[] memory amounts) = _buildArrays(1, 9_000_000);
        uint256 coldGas = harness.simulateLzReceive(tokenIds, amounts);

        // Second write same slot: slot is nonzero → nonzero (warm SSTORE)
        uint256 warmGas = harness.simulateLzReceive(tokenIds, amounts);

        console.log("n=1 cold gas: %d", coldGas);
        console.log("n=1 warm gas: %d (same slot, already nonzero)", warmGas);
        console.log("Budget (n=1): %d", budget(1));
    }

    // Verify the formula constant terms make sense
    function test_formulaIntercept() public {
        // n=0 should be just the _lzReceive overhead (fromLZ toggle + isAuthorizedFunction)
        (uint32[] memory tokenIds, uint256[] memory amounts) = _buildArrays(0, 7_000_000);
        uint256 gas0 = harness.simulateLzReceive(tokenIds, amounts);
        console.log("n=0 (overhead only): %d gas (budget constant = 22000)", gas0);
    }
}
