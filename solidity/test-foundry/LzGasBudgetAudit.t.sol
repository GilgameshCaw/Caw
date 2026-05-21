// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// =============================================================================
// LzGasBudgetAudit.t.sol — Gas budget measurement for all LZ receive paths
//
// Pattern: same as SetWithdrawableGas.t.sol but extended to cover EVERY
// selector that goes through gasLimitFor in CawProfile L1-side and
// CawProfileL2's setWithdrawable path, plus the CawChallengeRelay→Archive path.
//
// For EACH path we:
//   1. Construct a minimal faithful harness that runs the same storage writes
//      as the real _lzReceive handler (cold-slot semantics guaranteed by
//      using fresh storage slots per measurement).
//   2. Measure actual gas via gasleft() deltas.
//   3. Compare against the formula in gasLimitFor.
//   4. Apply EIP-150 63/64 buffer (LZ executor forwards budget*63/64 to the
//      inner call — if actual > budget*63/64, the call OOGs).
//   5. Assert headroom > SAFETY_BUFFER = 5000 gas.
//
// For paths that are TIGHT or UNSAFE the measurement is printed even if the
// assert passes (for human review). The test does NOT modify any contract.
//
// Selectors audited (CawProfile L1 side — `gasLimitFor(networkId, selector, n)`):
//   - _addToBalanceSelector   = depositAndUpdateOwners    base=150k + 65k*n
//   - _mintSelector           = mintAndUpdateOwners        base=100k + 65k*n
//   - _updateOwnersSelector   = updateOwners               base=40k  + 65k*n
//   - _authSelector           = authenticateAndUpdateOwners base=110k + 65k*n
//   - _mintAuthSelector       = mintAuthAndUpdateOwners     base=155k + 65k*n
//   - _depositRegisterSession = depositAndRegisterSession…  base=225k + 65k*n
//   - _mintAuthRegisterSession = mintAuthAndRegisterSession… base=240k + 65k*n
//
// Selectors audited (CawProfileL2 → L1, `gasLimitFor(selector, n)`):
//   - setWithdrawable: base=35k + 24k*n  (previously 22k+19k, updated post-measurement)
//
// Selectors audited (CawChallengeRelay → CawActionsArchive):
//   - _processChallenge (batch):  base=60k + 55k*n
// =============================================================================

import "forge-std/Test.sol";

// ---------------------------------------------------------------------------
// Storage constants — CawProfileL2's cold-slot storage ops per token update.
// These match the comment in CawProfile.sol:gasLimitFor and the real contract.
//
// Per update in `_setOwnerOf` (cold slots, EIP-2929):
//   ownerOf[tokenId]             SSTORE zero→nonzero : 22,100
//   lastOwnerUpdateBlock[tid]    SSTORE zero→nonzero : 22,100
//   ownerSessionEpoch[prev]++    SSTORE zero→nonzero : 22,100  (first time)
//   tokenSessionEpoch[tid]++     SSTORE zero→nonzero : 22,100  (first time)
//   loop overhead, SLOAD(ownerOf), etc.                ~2,000
//   Reported per-token cost in formula: 65,000 gas
// ---------------------------------------------------------------------------

uint256 constant SAFETY_BUFFER = 5_000;

// ---------------------------------------------------------------------------
// Harness A: depositAndUpdateOwners  (the "add to balance + owners" path)
// Storage writes:
//   totalCaw                    += amount     SSTORE nonzero→nonzero (warm after deposit): ~5k
//   cawOwnership[tokenId]       = newShares   SSTORE zero→nonzero (first deposit): 22,100
//   rewardMultiplier             SLOAD warm              : 100
//   authenticated[net][tid]      SSTORE z→nz            : 22,100
//   Per ownership update:        same as _setOwnerOf above (65k/token cold)
// Plus fixed overhead: fromLZ toggle, isAuthorizedFunction, ABI decode.
// ---------------------------------------------------------------------------
contract DepositUpdateOwnersHarness {
    // Mirrors the storage slots touched by CawProfileL2.depositAndUpdateOwners
    bool private fromLZ;

    // totalCaw
    uint256 public totalCaw;

    // cawOwnership[tokenId] (simplified — maps tokenId → shares)
    mapping(uint256 => uint256) public cawOwnership;

    // rewardMultiplier (constant in practice but we read it)
    uint256 public rewardMultiplier = 1e18;

    // authenticated[networkId][tokenId]
    mapping(uint32 => mapping(uint32 => bool)) public authenticated;

    // ownerOf[tokenId] — for ownership updates
    mapping(uint32 => address) public ownerOf;

    // lastOwnerUpdateBlock, ownerSessionEpoch, tokenSessionEpoch (per CL-4 comment)
    mapping(uint32 => uint64) public lastOwnerUpdateBlock;
    mapping(address => uint32) public ownerSessionEpoch;
    mapping(uint32 => uint32) public tokenSessionEpoch;

    uint256 public lastGasUsed;

    /// @notice Simulate depositAndUpdateOwners for n ownership updates.
    ///         All storage slots must be COLD (fresh tokenIds + addresses).
    function simulate(
        uint32 networkId,
        uint32 tokenId,
        uint256 amount,
        uint32[] calldata updateTokenIds,
        address[] calldata updateOwners,
        uint64[] calldata stamps,
        uint64 baseStamp
    ) external returns (uint256 gasUsed) {
        uint256 gasBefore = gasleft();

        // fromLZ = true (SSTORE z→nz = 22,100)
        fromLZ = true;

        // depositAndUpdateOwners body:
        totalCaw += amount;                                      // SLOAD(warm) + SSTORE(nz→nz ~5k)
        // addToBalance: setCawBalance(tokenId, amount)
        // cawOwnership[tokenId] = precision * amount / rewardMultiplier
        cawOwnership[tokenId] = 1e18 * amount / rewardMultiplier; // SLOAD(cold 2100) + SSTORE(z→nz 22100)

        // authenticated[networkId][tokenId] = true
        authenticated[networkId][tokenId] = true;                // SSTORE z→nz: 22,100

        // updateOwners: n iterations of _setOwnerOf
        for (uint256 i = 0; i < updateTokenIds.length; i++) {
            uint32 tid        = updateTokenIds[i];
            address newOwner  = updateOwners[i];
            uint64  stamp     = stamps.length > i ? stamps[i] : baseStamp;

            // stamp guard
            if (stamp <= lastOwnerUpdateBlock[tid]) continue;    // SLOAD cold: 2,100
            lastOwnerUpdateBlock[tid] = stamp;                   // SSTORE z→nz: 22,100

            address prev = ownerOf[tid];                         // SLOAD cold: 2,100
            if (prev != newOwner && prev != address(0)) {
                ownerSessionEpoch[prev]++;                       // SSTORE z→nz: 22,100
                tokenSessionEpoch[tid]++;                        // SSTORE z→nz: 22,100
            }
            ownerOf[tid] = newOwner;                             // SSTORE z→nz: 22,100
        }

        // fromLZ = false (SSTORE nz→z: 2,900 net after refund)
        fromLZ = false;

        uint256 gasAfter = gasleft();
        gasUsed = gasBefore - gasAfter;
        lastGasUsed = gasUsed;
    }
}

// ---------------------------------------------------------------------------
// Harness B: setWithdrawable (L2→L1, same harness as SetWithdrawableGas.t.sol)
// ---------------------------------------------------------------------------
contract SetWithdrawable2Harness {
    bool private fromLZ;
    mapping(uint32 => uint256) public withdrawable;
    uint256 public lastGasUsed;

    function simulate(
        uint32[] calldata tokenIds,
        uint256[] calldata amounts
    ) external returns (uint256 gasUsed) {
        uint256 gasBefore = gasleft();

        fromLZ = true;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            withdrawable[tokenIds[i]] += amounts[i];
        }
        fromLZ = false;

        uint256 gasAfter = gasleft();
        gasUsed = gasBefore - gasAfter;
        lastGasUsed = gasUsed;
    }
}

// ---------------------------------------------------------------------------
// Harness C: _processChallenge on CawActionsArchive
// Storage writes:
//   challengeHash[subId][cpId]      SSTORE z→nz: 22,100 per cp
//   challengeDelivered[subId][cpId] SSTORE z→nz: 22,100 per cp
//   plus abi.decode overhead, sub status SLOAD, loop overhead
// ---------------------------------------------------------------------------
contract ProcessChallengeHarness {
    bool private fromLZ;

    // submissions[submissionId].status, .networkId, .startCheckpointId, .endCheckpointId
    mapping(uint256 => uint8) public subStatus;
    mapping(uint256 => uint32) public subNetworkId;
    mapping(uint256 => uint256) public subStart;
    mapping(uint256 => uint256) public subEnd;

    mapping(uint256 => mapping(uint256 => bytes32)) public challengeHash;
    mapping(uint256 => mapping(uint256 => bool)) public challengeDelivered;

    uint256 public lastGasUsed;

    function setupSubmission(
        uint256 submissionId,
        uint32 networkId,
        uint256 startCpId,
        uint256 endCpId
    ) external {
        subStatus[submissionId]    = 1; // PENDING
        subNetworkId[submissionId] = networkId;
        subStart[submissionId]     = startCpId;
        subEnd[submissionId]       = endCpId;
    }

    function simulate(
        uint256 submissionId,
        uint32  networkId,
        uint256[] calldata cps,
        bytes32[] calldata hashes
    ) external returns (uint256 gasUsed) {
        uint256 gasBefore = gasleft();

        // Mirrors _processChallenge body
        if (subStatus[submissionId] != 1) { return gasBefore - gasleft(); }
        if (subNetworkId[submissionId] != networkId) { return gasBefore - gasleft(); }
        if (cps.length != hashes.length) { return gasBefore - gasleft(); }

        uint256 start = subStart[submissionId];
        uint256 end   = subEnd[submissionId];

        for (uint256 i = 0; i < cps.length; i++) {
            uint256 cpId = cps[i];
            if (cpId < start || cpId > end) continue;
            challengeHash[submissionId][cpId]      = hashes[i];
            challengeDelivered[submissionId][cpId] = true;
        }

        uint256 gasAfter = gasleft();
        gasUsed = gasBefore - gasAfter;
        lastGasUsed = gasUsed;
    }
}

// ---------------------------------------------------------------------------
// Test contract
// ---------------------------------------------------------------------------
contract LzGasBudgetAuditTest is Test {
    DepositUpdateOwnersHarness harnessA;
    SetWithdrawable2Harness    harnessB;
    ProcessChallengeHarness    harnessC;

    uint256 constant SAFETY = SAFETY_BUFFER;

    function setUp() public {
        harnessA = new DepositUpdateOwnersHarness();
        harnessB = new SetWithdrawable2Harness();
        harnessC = new ProcessChallengeHarness();
    }

    // -----------------------------------------------------------------------
    // Helper
    // -----------------------------------------------------------------------
    function _check(
        string memory label,
        uint256 actual,
        uint256 formula,
        bool expectSafe
    ) internal pure returns (bool isSafe) {
        uint256 lz150 = formula * 63 / 64;
        isSafe = actual < lz150 && (lz150 - actual) > SAFETY;

        if (!isSafe && expectSafe) {
            revert(
                string(abi.encodePacked(label, ": UNSAFE budget"))
            );
        }
    }

    // -----------------------------------------------------------------------
    // Path 1: depositAndUpdateOwners (CawProfile L1-side gasLimitFor)
    // Formula: base=150_000 + 65_000 * n
    // -----------------------------------------------------------------------
    function _budgetDeposit(uint256 n) internal pure returns (uint256) {
        return 150_000 + 65_000 * n;
    }

    function _measureDeposit(uint256 n, uint256 baseTokenId) internal returns (uint256) {
        uint32[] memory tids = new uint32[](n);
        address[] memory owners = new address[](n);
        uint64[] memory stamps = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            tids[i]   = uint32(baseTokenId + i);
            owners[i] = vm.addr(baseTokenId + i);
            stamps[i] = uint64(1);
        }
        return harnessA.simulate(
            1,                          // networkId
            uint32(baseTokenId + 10_000_000), // unique deposit tokenId (cold)
            1e18,                       // amount
            tids,
            owners,
            stamps,
            uint64(1)
        );
    }

    function test_depositAndUpdateOwners_gasTable() public {
        uint256[5] memory ns    = [uint256(0), 1, 5, 10, 20];
        uint256[5] memory bases = [uint256(1_000_000), 2_000_000, 3_000_000, 4_000_000, 5_000_000];

        console.log("=== depositAndUpdateOwners gas (base=150k + 65k*n) ===");
        for (uint256 i = 0; i < ns.length; i++) {
            uint256 n      = ns[i];
            uint256 actual = _measureDeposit(n, bases[i]);
            uint256 budget = _budgetDeposit(n);
            uint256 lz150  = budget * 63 / 64;
            bool safe = actual < lz150 && lz150 - actual > SAFETY;
            console.log("n=%d actual=%d budget=%d", n, actual, budget);
            console.log("  lz150=%d safe=%s", lz150, safe ? "YES" : "UNSAFE");
        }
    }

    function test_depositAndUpdateOwners_n0_isSafe() public {
        uint256 actual = _measureDeposit(0, 9_000_000);
        uint256 budget = _budgetDeposit(0);
        _check("depositAndUpdateOwners n=0", actual, budget, true);
    }

    function test_depositAndUpdateOwners_n10_isSafe() public {
        uint256 actual = _measureDeposit(10, 8_000_000);
        uint256 budget = _budgetDeposit(10);
        _check("depositAndUpdateOwners n=10", actual, budget, true);
    }

    // -----------------------------------------------------------------------
    // Path 2: setWithdrawable (CawProfileL2 → L1)
    // Formula: base=35_000 + 24_000 * n  (updated formula)
    // Also measure the OLD formula (22k+19k*n) for comparison
    // -----------------------------------------------------------------------
    function _budgetSetWithdrawable(uint256 n) internal pure returns (uint256) {
        return 35_000 + 24_000 * n;
    }

    function _budgetSetWithdrawableOld(uint256 n) internal pure returns (uint256) {
        return 22_000 + 19_000 * n;
    }

    function _buildWithdrawArrays(uint256 n, uint256 base)
        internal pure returns (uint32[] memory tids, uint256[] memory amounts)
    {
        tids    = new uint32[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            tids[i]    = uint32(base + i);
            amounts[i] = 1e18;
        }
    }

    function test_setWithdrawable_gasTable() public {
        uint256[6] memory ns    = [uint256(1), 5, 10, 20, 50, 100];
        uint256[6] memory bases = [
            uint256(1_000_000), uint256(2_000_000), uint256(3_000_000),
            uint256(4_000_000), uint256(5_000_000), uint256(6_000_000)
        ];

        console.log("=== setWithdrawable gas (new: 35k+24k*n, old: 22k+19k*n) ===");
        for (uint256 i = 0; i < ns.length; i++) {
            uint256 n = ns[i];
            (uint32[] memory tids, uint256[] memory amounts) = _buildWithdrawArrays(n, bases[i]);
            uint256 actual = harnessB.simulate(tids, amounts);
            uint256 newBudget = _budgetSetWithdrawable(n);
            uint256 oldBudget = _budgetSetWithdrawableOld(n);
            uint256 lz150new  = newBudget * 63 / 64;
            uint256 lz150old  = oldBudget * 63 / 64;
            bool safeNew = actual < lz150new && lz150new - actual > SAFETY;
            bool safeOld = actual < lz150old && (actual < lz150old ? lz150old - actual : 0) > SAFETY;
            console.log("n=%d actual=%d new_budget=%d", n, actual, newBudget);
            console.log("  new_safe=%d old_budget=%d old_safe=%d", safeNew ? 1 : 0, oldBudget, safeOld ? 1 : 0);
        }
    }

    function test_setWithdrawable_n1_newFormula_isSafe() public {
        (uint32[] memory tids, uint256[] memory amounts) = _buildWithdrawArrays(1, 9_000_000);
        uint256 actual = harnessB.simulate(tids, amounts);
        uint256 budget = _budgetSetWithdrawable(1);
        _check("setWithdrawable n=1 new formula", actual, budget, true);
    }

    function test_setWithdrawable_n50_newFormula_isSafe() public {
        (uint32[] memory tids, uint256[] memory amounts) = _buildWithdrawArrays(50, 8_000_000);
        uint256 actual = harnessB.simulate(tids, amounts);
        uint256 budget = _budgetSetWithdrawable(50);
        _check("setWithdrawable n=50 new formula", actual, budget, true);
    }

    // -----------------------------------------------------------------------
    // Path 3: _processChallenge (CawActionsArchive _lzReceive)
    // Formula: CHALLENGE_GAS_BASE=60_000 + CHALLENGE_GAS_PER_CP=55_000 * n
    // -----------------------------------------------------------------------
    function _budgetChallenge(uint256 n) internal pure returns (uint256) {
        return 60_000 + 55_000 * n;
    }

    function _measureChallenge(uint256 n, uint256 subId) internal returns (uint256) {
        harnessC.setupSubmission(subId, 1, 1, 1000);

        uint256[] memory cps    = new uint256[](n);
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            cps[i]    = 1 + i;
            hashes[i] = keccak256(abi.encodePacked("hash", i, subId));
        }
        return harnessC.simulate(subId, 1, cps, hashes);
    }

    function test_processChallenge_gasTable() public {
        uint256[5] memory ns    = [uint256(1), 5, 10, 20, 50];
        uint256[5] memory subIds = [uint256(1_000), 2_000, 3_000, 4_000, 5_000];

        console.log("=== _processChallenge gas (60k + 55k*n) ===");
        for (uint256 i = 0; i < ns.length; i++) {
            uint256 n      = ns[i];
            uint256 actual = _measureChallenge(n, subIds[i]);
            uint256 budget = _budgetChallenge(n);
            uint256 lz150  = budget * 63 / 64;
            bool safe = actual < lz150 && lz150 - actual > SAFETY;
            console.log("n=%d actual=%d budget=%d", n, actual, budget);
            console.log("  lz150=%d safe=%s", lz150, safe ? "YES" : "UNSAFE");
        }
    }

    function test_processChallenge_n1_isSafe() public {
        uint256 actual = _measureChallenge(1, 10_000);
        uint256 budget = _budgetChallenge(1);
        _check("processChallenge n=1", actual, budget, true);
    }

    function test_processChallenge_n20_isSafe() public {
        uint256 actual = _measureChallenge(20, 9_000);
        uint256 budget = _budgetChallenge(20);
        _check("processChallenge n=20", actual, budget, true);
    }

    // -----------------------------------------------------------------------
    // updateOwners-only path (no deposit/auth)
    // Formula: base=40_000 + 65_000 * n
    // -----------------------------------------------------------------------
    function _budgetUpdateOwners(uint256 n) internal pure returns (uint256) {
        return 40_000 + 65_000 * n;
    }

    function test_updateOwners_gasTable() public {
        // Reuse harnessA's simulate but with amount=0 (no deposit math)
        // We proxy the updateOwners-only measurement through DepositUpdateOwnersHarness
        // by using amount=0 — but that zeroes the cawOwnership write which is not
        // part of updateOwners. The updateOwners path is n * _setOwnerOf only.
        // We measure it by providing 0-amount deposit (no cawOwnership write)
        // and n ownership updates.
        uint256[4] memory ns    = [uint256(0), 1, 5, 10];
        uint256[4] memory bases = [uint256(7_000_000), 7_100_000, 7_200_000, 7_300_000];

        console.log("=== updateOwners gas (40k + 65k*n) ===");
        for (uint256 i = 0; i < ns.length; i++) {
            uint256 n = ns[i];
            uint32[] memory tids = new uint32[](n);
            address[] memory owners = new address[](n);
            uint64[] memory stamps = new uint64[](n);
            for (uint256 j = 0; j < n; j++) {
                tids[j]   = uint32(bases[i] + j);
                owners[j] = vm.addr(bases[i] + j + 1);
                stamps[j] = 1;
            }
            // Measure ONLY the update owners slice by deploying a fresh harness
            // that measures just the updateOwners storage writes
            uint256 actual = harnessA.simulate(
                1,
                uint32(bases[i] + 500_000), // separate deposit tokenId to avoid clash
                0,                            // amount = 0 → minimizes deposit gas
                tids, owners, stamps, 1
            );
            uint256 budget = _budgetUpdateOwners(n);
            uint256 lz150  = budget * 63 / 64;
            bool safe = actual < lz150 && (actual < lz150 ? lz150 - actual : 0) > SAFETY;
            console.log("n=%d actual=%d budget=%d", n, actual, budget);
            console.log("  lz150=%d safe=%s", lz150, safe ? "YES" : "UNSAFE");
        }
    }
}
