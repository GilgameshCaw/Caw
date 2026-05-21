// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

/// @title StorageLayoutSnapshot
/// @notice Regression test: asserts that storage layouts of critical V2 contracts
///         have not changed relative to the checked-in goldens at
///         `test-foundry/golden/storage-layout-<Contract>.json`.
///
/// @dev Implementation uses vm.ffi to call `node scripts/check-storage-layout.js`
///      which in turn calls `forge inspect <Contract> storageLayout --json`,
///      normalises the output (drops astId, sorts by slot/offset), and compares
///      byte-for-byte with the checked-in golden file.
///
///      On first run (golden missing): the Node script generates the golden and
///      exits 0 — test passes, golden is now on disk.
///
///      On subsequent runs: any reorder/insert/rename of storage variables fails
///      the test loudly with a diff to stdout.
///
///      Requires: `ffi = true` in foundry.toml (already set).
///      Requires: `node` in PATH and the project's `package.json` dependencies
///                installed (forge inspect needs the contracts to compile).
contract StorageLayoutSnapshotTest is Test {
    // Ordered list of contracts to check. Update this list if new critical
    // contracts are added post-deploy. Do NOT remove existing entries.
    string[] internal CONTRACTS;

    function setUp() public {
        CONTRACTS.push("CawProfile");
        CONTRACTS.push("CawProfileL2");
        CONTRACTS.push("CawActions");
        CONTRACTS.push("CawActionsArchive");
        CONTRACTS.push("CawProfileMarketplace");
        CONTRACTS.push("CawCapOracle");
        CONTRACTS.push("CawNetworkManager");
        CONTRACTS.push("CawChallengeRelay");
    }

    /// @notice Run storage-layout check for all critical contracts.
    ///         Fails if any contract's layout differs from its golden file.
    function test_storageLayoutUnchanged() public {
        string[] memory cmd = new string[](3);
        cmd[0] = "node";
        cmd[1] = "scripts/check-storage-layout.js";
        cmd[2] = "--check-all";

        // vm.ffi runs from the foundry project root (solidity/).
        // The script writes "OK: <name>" per contract on success, or
        // "MISMATCH: <name>\n--- golden ---\n...\n--- current ---\n..."
        // on failure. We assert the output contains no MISMATCH.
        bytes memory result = vm.ffi(cmd);
        string memory out = string(result);
        emit log_string(out);
        assertFalse(
            _contains(out, "MISMATCH"),
            "Storage layout mismatch detected - see test output for diff"
        );
    }

    /// @notice Individual per-contract tests for granular failure attribution.
    ///         Named test_layout_<Contract> so forge --match-test can target them.
    function test_layout_CawProfile() public { _checkOne("CawProfile"); }
    function test_layout_CawProfileL2() public { _checkOne("CawProfileL2"); }
    function test_layout_CawActions() public { _checkOne("CawActions"); }
    function test_layout_CawActionsArchive() public { _checkOne("CawActionsArchive"); }
    function test_layout_CawProfileMarketplace() public { _checkOne("CawProfileMarketplace"); }
    function test_layout_CawCapOracle() public { _checkOne("CawCapOracle"); }
    function test_layout_CawNetworkManager() public { _checkOne("CawNetworkManager"); }
    function test_layout_CawChallengeRelay() public { _checkOne("CawChallengeRelay"); }

    function _checkOne(string memory contractName) internal {
        string[] memory cmd = new string[](3);
        cmd[0] = "node";
        cmd[1] = "scripts/check-storage-layout.js";
        cmd[2] = contractName;

        bytes memory result = vm.ffi(cmd);
        string memory out = string(result);
        emit log_named_string("layout", out);
        assertFalse(
            _contains(out, "MISMATCH"),
            string(abi.encodePacked("Storage layout mismatch for ", contractName))
        );
    }

    /// @dev Simple substring search (no stdlib needed).
    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) { found = false; break; }
            }
            if (found) return true;
        }
        return false;
    }
}
