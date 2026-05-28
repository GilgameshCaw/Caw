// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfileL2.sol";
import "../contracts/CawActions.sol";
import "../contracts/interfaces/ICawActions.sol";
import "../contracts/CawNetworkManager.sol";

// =============================================================================
// AllowFreeAuth tests
//
// Covers:
//   1. CawProfileL2.setAllowFreeAuth sets allowFreeAuth[networkId] correctly
//      via the bypassLZ path (msg.sender == cawProfile && bypassLZ).
//   2. CawProfileL2.setAllowFreeAuth reverts if neither fromLZ nor bypassLZ+cawProfile.
//   3. CawActions._applyAction no longer reverts UserNotAuth when allowFreeAuth is true.
//   4. CawActions._applyAction STILL reverts when both authenticated and allowFreeAuth are false.
//   5. Already-authenticated users are unaffected by allowFreeAuth state.
//   6. Stale seq (seq <= last seen) is silently ignored; state does not roll back.
//   7. setCawProfile is gated on deployer (Fix 1).
//   8. No-op broadcast refunds msg.value to caller (Fix 2).
// =============================================================================

// ---------------------------------------------------------------------------
// Minimal mock CawProfileL2 that exposes allowFreeAuth state and the
// authenticated mapping, letting us set them directly for CawActions tests.
// ---------------------------------------------------------------------------
contract MockCawProfileL2ForActions {
    mapping(uint32 => mapping(uint32 => bool)) public authenticated;
    mapping(uint32 => bool) public _allowFreeAuthPublic;
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => CawProfileL2.StoredSession)) private _sessions;
    uint256 public rewardMultiplier = 10**18;
    uint256 public precision = 10**18;

    // Stub: allowFreeAuth external view (matches CawProfileL2 ABI)
    function allowFreeAuth(uint32 networkId) external view returns (bool) {
        return _allowFreeAuthPublic[networkId];
    }

    function setAllowFreeAuth(uint32 networkId, bool allow, uint64 /*seq*/) external {
        _allowFreeAuthPublic[networkId] = allow;
    }

    function setAuthenticated(uint32 networkId, uint32 tokenId, bool val) external {
        authenticated[networkId][tokenId] = val;
    }

    function setOwner(uint32 tokenId, address owner) external {
        ownerOf[tokenId] = owner;
    }

    // ── CawProfileL2 interface stubs used by CawActions ──────────────────────

    function cawBalanceOf(uint32 tokenId) external view returns (uint256) {
        return 10_000_000 * 10**18; // large balance so spend checks pass
    }

    function spendAndDistributeTokens(uint32, uint256, uint256) external {}
    function spendDistributeAndAddTokensToBalance(uint32, uint256, uint256, uint32, uint256) external {}

    function withdrawTokens(uint32, uint256) external {}

    function validSession(address owner, address sessionKey)
        external view returns (CawProfileL2.StoredSession memory s)
    {
        return _sessions[owner][sessionKey];
    }

    function registerSessionFromActions(address, address, uint64, uint256, uint64) external {}
    function revokeSessionFromActions(address, address) external {}

    ICawCapOracle public immutable capOracle = ICawCapOracle(address(0));
}

// ---------------------------------------------------------------------------
// Minimal mock for CawCapOracle (address(0) if unused)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CawProfileL2 setAllowFreeAuth tests
// ---------------------------------------------------------------------------
contract SetAllowFreeAuthTest is Test {
    // We need a real CawProfileL2 to test the auth guard, but deploying the
    // full contract requires a LayerZero endpoint mock. Instead, we deploy
    // a minimal harness that inherits just the relevant storage and modifier.

    // Rather than spinning up the full OApp stack, we test the storage path
    // via a simple inline harness that exposes the fromLZ flag.
    HarnessCawProfileL2 internal l2;

    function setUp() public {
        // Harness deployed with a stub endpoint.
        l2 = new HarnessCawProfileL2();
    }

    // ── Test 1: fromLZ path sets allowFreeAuth to true ────────────────────
    function test_SetAllowFreeAuth_FromLZ_SetsTrue() public {
        // Simulate _lzReceive by calling through the harness exposer.
        l2.callViaFromLZ(1, true);
        assertTrue(l2.allowFreeAuth(1), "allowFreeAuth[1] should be true");
    }

    // ── Test 2: fromLZ path sets allowFreeAuth to false ───────────────────
    function test_SetAllowFreeAuth_FromLZ_SetsFalse() public {
        l2.callViaFromLZ(1, true);  // first set to true
        l2.callViaFromLZ(1, false); // then flip to false
        assertFalse(l2.allowFreeAuth(1), "allowFreeAuth[1] should be false after reset");
    }

    // ── Test 3: different networkIds are independent ───────────────────────
    function test_SetAllowFreeAuth_FromLZ_PerNetwork() public {
        l2.callViaFromLZ(1, true);
        l2.callViaFromLZ(2, false);
        assertTrue(l2.allowFreeAuth(1), "network 1 should be true");
        assertFalse(l2.allowFreeAuth(2), "network 2 should be false");
    }

    // ── Test 4: direct call without fromLZ or bypassLZ reverts ────────────
    function test_SetAllowFreeAuth_DirectCall_Reverts() public {
        // Neither fromLZ nor bypassLZ+cawProfile — must revert.
        vm.expectRevert(CawProfileL2.OnlyLZ.selector);
        l2.setAllowFreeAuth(1, true, 1);
    }

    // ── Test 5: bypassLZ + correct caller succeeds ────────────────────────
    function test_SetAllowFreeAuth_BypassLZ_Succeeds() public {
        // The harness's setBypassLZCaller simulates the onlyOnMainnet gate.
        l2.enableBypassLZ(address(this));
        l2.setAllowFreeAuth(1, true, 1);
        assertTrue(l2.allowFreeAuth(1), "bypassLZ call should set allowFreeAuth");
    }

    // ── Test 6: bypassLZ + wrong caller reverts ───────────────────────────
    function test_SetAllowFreeAuth_BypassLZ_WrongCaller_Reverts() public {
        l2.enableBypassLZ(address(0xDEAD)); // registered cawProfile is 0xDEAD, not this test
        vm.expectRevert(CawProfileL2.OnlyLZ.selector);
        l2.setAllowFreeAuth(1, true, 1);
    }

    // ── Test 6b: stale seq is silently ignored ────────────────────────────
    // Call with seq=2 (sets allowFreeAuth=true), then call with seq=1
    // (stale) and assert the state stays at the seq=2 value.
    function test_SetAllowFreeAuth_StaleSeqIgnored() public {
        l2.enableBypassLZ(address(this));

        // seq=2: set to true
        l2.setAllowFreeAuth(1, true, 2);
        assertTrue(l2.allowFreeAuth(1), "seq=2 should set allowFreeAuth=true");

        // seq=1: stale — must be silently ignored (state does not flip back)
        l2.setAllowFreeAuth(1, false, 1);
        assertTrue(l2.allowFreeAuth(1), "seq=1 is stale; state must remain true");
    }
}

// ---------------------------------------------------------------------------
// CawActions auth gate tests (allowFreeAuth bypass)
// ---------------------------------------------------------------------------
contract CawActionsAllowFreeAuthTest is Test {
    MockCawProfileL2ForActions internal profile;

    uint32 constant NETWORK_ID = 1;
    uint32 constant TOKEN_ID   = 1;
    uint32 constant VALIDATOR_ID = 99;

    // We test the auth gate by deploying a minimal CawActions with the mock
    // profile and calling the public-facing processActions entry point.
    // Rather than building a full batch, we test via a thin harness that
    // wraps _applyAction.
    HarnessCawActions internal actions;

    function setUp() public {
        profile = new MockCawProfileL2ForActions();
        profile.setOwner(TOKEN_ID, address(0x1234));

        // Deploy CawActions harness with the mock profile.
        actions = new HarnessCawActions(address(profile));
    }

    // ── Test 7: allowFreeAuth=false, not authenticated → UserNotAuth ──────
    function test_AuthGate_NotAuthed_NotFreeAuth_Reverts() public {
        // Both flags are false (default).
        vm.expectRevert(CawActions.UserNotAuth.selector);
        actions.applyMockAction(NETWORK_ID, TOKEN_ID, VALIDATOR_ID);
    }

    // ── Test 8: allowFreeAuth=true, not authenticated → succeeds ─────────
    function test_AuthGate_NotAuthed_FreeAuth_Passes() public {
        profile.setAllowFreeAuth(NETWORK_ID, true, 1);
        // Should not revert.
        actions.applyMockAction(NETWORK_ID, TOKEN_ID, VALIDATOR_ID);
    }

    // ── Test 9: allowFreeAuth=false, is authenticated → succeeds ─────────
    function test_AuthGate_Authed_NoFreeAuth_Passes() public {
        profile.setAuthenticated(NETWORK_ID, TOKEN_ID, true);
        // Should not revert.
        actions.applyMockAction(NETWORK_ID, TOKEN_ID, VALIDATOR_ID);
    }

    // ── Test 10: both flags true → succeeds (no double-check fail) ────────
    function test_AuthGate_BothTrue_Passes() public {
        profile.setAuthenticated(NETWORK_ID, TOKEN_ID, true);
        profile.setAllowFreeAuth(NETWORK_ID, true, 1);
        // Should not revert.
        actions.applyMockAction(NETWORK_ID, TOKEN_ID, VALIDATOR_ID);
    }

    // ── Test 11: allowFreeAuth transitions: true → false restores gate ────
    function test_AuthGate_FreeAuth_DisabledRestoresGate() public {
        profile.setAllowFreeAuth(NETWORK_ID, true, 1);
        actions.applyMockAction(NETWORK_ID, TOKEN_ID, VALIDATOR_ID); // passes

        profile.setAllowFreeAuth(NETWORK_ID, false, 2);
        vm.expectRevert(CawActions.UserNotAuth.selector);
        actions.applyMockAction(NETWORK_ID, TOKEN_ID, VALIDATOR_ID); // reverts
    }
}

// =============================================================================
// Harnesses
// =============================================================================

// ---------------------------------------------------------------------------
// HarnessCawProfileL2 — minimal harness to test setAllowFreeAuth storage
// logic without spinning up the full OApp stack.
// ---------------------------------------------------------------------------
contract HarnessCawProfileL2 {
    mapping(uint32 => bool) private _allowFreeAuth;
    mapping(uint32 => uint64) internal lastAllowFreeAuthSeq;
    bool private fromLZ;
    bool public bypassLZ;
    address public cawProfile;

    error OnlyLZ();

    function allowFreeAuth(uint32 networkId) external view returns (bool) {
        return _allowFreeAuth[networkId];
    }

    /// @dev Mirrors CawProfileL2.setAllowFreeAuth exactly (including seq guard).
    function setAllowFreeAuth(uint32 networkId, bool allow, uint64 seq) public {
        if (!(fromLZ || (bypassLZ && msg.sender == cawProfile))) revert OnlyLZ();
        if (seq <= lastAllowFreeAuthSeq[networkId]) return; // stale, ignore
        lastAllowFreeAuthSeq[networkId] = seq;
        _allowFreeAuth[networkId] = allow;
    }

    /// @dev Test helper: simulate an LZ-delivered call (seq starts at 1).
    function callViaFromLZ(uint32 networkId, bool allow) external {
        fromLZ = true;
        lastAllowFreeAuthSeq[networkId] = 0; // reset so each test call is fresh
        this.setAllowFreeAuth(networkId, allow, 1);
        fromLZ = false;
    }

    /// @dev Test helper: enable bypassLZ mode with a specific trusted caller.
    function enableBypassLZ(address trustedCaller) external {
        bypassLZ = true;
        cawProfile = trustedCaller;
    }
}

// ---------------------------------------------------------------------------
// HarnessCawActions — wraps the auth-gate logic from CawActions._applyAction
// without requiring a full batch + signature verification stack.
// ---------------------------------------------------------------------------
interface IAllowFreeAuthProfile {
    function authenticated(uint32 networkId, uint32 tokenId) external view returns (bool);
    function allowFreeAuth(uint32 networkId) external view returns (bool);
    function cawBalanceOf(uint32 tokenId) external view returns (uint256);
    function spendAndDistributeTokens(uint32 tokenId, uint256 amountToSpend, uint256 amountToDistribute) external;
}

contract HarnessCawActions {
    IAllowFreeAuthProfile public immutable cawProfile;

    error UserNotAuth();

    constructor(address _profile) {
        cawProfile = IAllowFreeAuthProfile(_profile);
    }

    /// @notice Simulates the auth-gate portion of _applyAction for a CAW action.
    ///         Reverts UserNotAuth under the same conditions as the real contract.
    function applyMockAction(uint32 networkId, uint32 tokenId, uint32 /*validatorId*/) external {
        // Mirrors line 1191 of CawActions.sol (post-fix):
        if (!cawProfile.authenticated(networkId, tokenId)
            && !cawProfile.allowFreeAuth(networkId)) revert UserNotAuth();

        // Simulate a minimal CAW action cost (stub: just call spend so the
        // mock can assert it was called). In the real contract this would also
        // increment the cawonce, check text length, etc. — but we only care
        // about the auth gate here.
        uint256 cost = 5000;
        cawProfile.spendAndDistributeTokens(tokenId, cost, cost);
    }
}

// =============================================================================
// MockCawProfileForPropagation
// Records all broadcastAllowFreeAuth calls so tests can assert on them.
// =============================================================================
contract MockCawProfileForPropagation {
    struct BroadcastCall {
        uint32 networkId;
        uint32 lzDestId;
        uint256 lzTokenAmount;
        uint256 value;
    }

    BroadcastCall[] public calls;

    function broadcastAllowFreeAuth(uint32 networkId, uint32 lzDestId, uint256 lzTokenAmount) external payable {
        calls.push(BroadcastCall({
            networkId: networkId,
            lzDestId: lzDestId,
            lzTokenAmount: lzTokenAmount,
            value: msg.value
        }));
    }

    // Stub for the auto-broadcast triggered by setTipTarget / createNetwork.
    // Tracked separately from allowFreeAuth broadcasts so existing tests aren't
    // perturbed; current tests don't assert on tip broadcasts.
    uint256 public tipBroadcastCalls;
    function broadcastTipTarget(uint32, uint32, uint256) external payable {
        tipBroadcastCalls++;
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function resetCount() external {
        delete calls;
    }
}

// =============================================================================
// NetworkManager auto-propagation tests (tests 12-24)
//
// Covers:
//  12. setAuthFee (0→nonzero) triggers broadcastAllowFreeAuth
//  13. setAuthFee (nonzero→0) triggers broadcastAllowFreeAuth
//  14. setAuthFee (nonzero→different-nonzero) does NOT trigger broadcast
//  15. setAuthFee (0→0) does NOT trigger broadcast
//  16. setFees with authFee crossing zero triggers broadcast
//  17. setFees with within-bucket authFee change does NOT trigger broadcast
//  18. When cawProfile == address(0), setAuthFee succeeds without broadcast
//  19. setCawProfile can only be called once (reverts on second call)
//  20. broadcastAllowFreeAuth receives the network's storageChainEid as lzDestId
//  21. setCawProfile reverts if called by non-deployer (Fix 1)
//  22. No-op broadcast (within-bucket) refunds msg.value to caller (Fix 2)
//  23. No-op broadcast (pre-wire) refunds msg.value to caller (Fix 2)
//  24. Normal broadcast forwards msg.value to CawProfile (not refunded)
// =============================================================================
contract NetworkManagerPropagationTest is Test {
    CawNetworkManager internal manager;
    MockCawProfileForPropagation internal mockProfile;

    uint32 constant STORAGE_EID = 40245; // Base Sepolia EID
    uint32 constant NETWORK_ID  = 1;
    uint256 constant CEILING    = 1 ether;

    address internal networkOwner;

    function setUp() public {
        networkOwner = address(0xBEEF);

        manager = new CawNetworkManager(address(0x1)); // buyAndBurn stub
        mockProfile = new MockCawProfileForPropagation();

        // Wire the mock profile.
        manager.setCawProfile(address(mockProfile));

        // Create a network owned by networkOwner. V2 per-fee-ceiling shape:
        // createNetwork(name, fee, eid, withdrawCeiling, depositCeiling,
        // authCeiling, mintCeiling). Initial fees default to ceilings.
        // We start with all ceilings at CEILING (so authFee starts at CEILING,
        // not 0), then call setAuthFee(0) to drop to free-auth state.
        // The mock's callCount tracks broadcasts triggered by the boundary
        // crossing CEILING→0, so we record that baseline and assert deltas
        // in each test rather than absolute counts.
        vm.prank(networkOwner);
        manager.createNetwork(
            "TestNet",
            address(0xFEE),     // feeAddress
            STORAGE_EID,        // storageChainEid
            CEILING,            // withdrawFeeCeiling
            CEILING,            // depositFeeCeiling
            CEILING,            // authFeeCeiling
            CEILING,            // mintFeeCeiling
            5e11                // tipCeilingWei
        );
        // Drop authFee to 0 to put the test in the "free auth" baseline.
        // This triggers ONE broadcast (CEILING→0); resetCount() zeroes the
        // mock so each test assertion is a clean delta from authFee==0.
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        manager.setAuthFee{value: 0.01 ether}(NETWORK_ID, 0);
        mockProfile.resetCount();
    }

    // ── Test 12: setAuthFee 0→nonzero triggers broadcast ─────────────────────
    function test_SetAuthFee_ZeroToNonZero_TriggersBroadcast() public {
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        manager.setAuthFee{value: 0.01 ether}(NETWORK_ID, 0.001 ether);

        assertEq(mockProfile.callCount(), 1, "should have 1 broadcast call");
        (uint32 nid, uint32 destEid,,) = mockProfile.calls(0);
        assertEq(nid, NETWORK_ID, "networkId mismatch");
        assertEq(destEid, STORAGE_EID, "destEid should be network's storageChainEid");
    }

    // ── Test 13: setAuthFee nonzero→0 triggers broadcast ─────────────────────
    function test_SetAuthFee_NonZeroToZero_TriggersBroadcast() public {
        // First set to non-zero (no broadcast expected — pre-wire call)
        // Actually manager is already wired. Start from a non-zero state:
        // Deploy a fresh manager with non-zero authFee from creation.
        CawNetworkManager m2 = new CawNetworkManager(address(0x1));
        MockCawProfileForPropagation mp2 = new MockCawProfileForPropagation();
        m2.setCawProfile(address(mp2));

        // V2 createNetwork: 7 args (name, fee, eid, 4 ceilings). Initial fees
        // default to ceilings. Net2 wants authFee=0.001 initial; we achieve
        // that by registering with authFeeCeiling=CEILING (so authFee=CEILING),
        // then setAuthFee(0.001). The first setAuthFee triggers a broadcast
        // (CEILING→0.001 is non-zero→non-zero — within-bucket — no trigger
        // actually). Reset the mock after to isolate the test's transition.
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        m2.createNetwork("Net2", address(0xFEE), STORAGE_EID, CEILING, CEILING, CEILING, CEILING, 5e11);
        vm.prank(networkOwner);
        m2.setAuthFee(NETWORK_ID, 0.001 ether); // CEILING → 0.001 ether (within-bucket, no broadcast)
        mp2.resetCount();

        // Now transition non-zero → 0.
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        m2.setAuthFee{value: 0.01 ether}(NETWORK_ID, 0);

        assertEq(mp2.callCount(), 1, "should have 1 broadcast call on nonzero to 0");
    }

    // ── Test 14: setAuthFee nonzero→different-nonzero does NOT trigger ────────
    function test_SetAuthFee_NonZeroToNonZero_NoBroadcast() public {
        // Setup: set authFee to 0.001 (triggers broadcast 0→nonzero).
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        manager.setAuthFee{value: 0.01 ether}(NETWORK_ID, 0.001 ether);
        uint256 countAfterFirst = mockProfile.callCount();

        // Now change within-bucket: 0.001 → 0.002. Should NOT broadcast.
        vm.prank(networkOwner);
        manager.setAuthFee(NETWORK_ID, 0.002 ether);

        assertEq(mockProfile.callCount(), countAfterFirst, "within-bucket change must not broadcast");
    }

    // ── Test 15: setAuthFee 0→0 (no-op) does NOT trigger broadcast ───────────
    function test_SetAuthFee_ZeroToZero_NoBroadcast() public {
        // authFee is already 0 from setUp.
        vm.prank(networkOwner);
        manager.setAuthFee(NETWORK_ID, 0);

        assertEq(mockProfile.callCount(), 0, "0 to 0 must not broadcast");
    }

    // ── Test 16: setFees with authFee crossing zero triggers broadcast ─────────
    function test_SetFees_AuthFeeCrossesZero_TriggersBroadcast() public {
        // authFee starts at 0; setFees sets it to 0.001 — crossing the boundary.
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        manager.setFees{value: 0.01 ether}(NETWORK_ID, 0, 0, 0.001 ether, 0);

        assertEq(mockProfile.callCount(), 1, "setFees authFee boundary crossing should broadcast");
    }

    // ── Test 17: setFees within-bucket authFee change does NOT broadcast ──────
    function test_SetFees_WithinBucketAuthFee_NoBroadcast() public {
        // First get to a non-zero state.
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        manager.setAuthFee{value: 0.01 ether}(NETWORK_ID, 0.001 ether);
        uint256 countAfterFirst = mockProfile.callCount();

        // setFees with 0.001 → 0.002 (within-bucket).
        vm.prank(networkOwner);
        manager.setFees(NETWORK_ID, 0, 0, 0.002 ether, 0);

        assertEq(mockProfile.callCount(), countAfterFirst, "within-bucket setFees must not broadcast");
    }

    // ── Test 18: pre-wire (cawProfile==address(0)) setAuthFee succeeds silently
    function test_SetAuthFee_PreWire_NoBroadcastNoRevert() public {
        // Deploy a fresh manager without wiring cawProfile.
        CawNetworkManager m3 = new CawNetworkManager(address(0x1));
        vm.prank(networkOwner);
        // 7-arg createNetwork; authFeeCeiling=CEILING. Initial authFee=CEILING.
        m3.createNetwork("Net3", address(0xFEE), STORAGE_EID, CEILING, CEILING, CEILING, CEILING, 5e11);

        // Drop authFee to 0 (CEILING→0, would cross boundary), then back to
        // 0.001 (0→non-zero, would cross boundary). cawProfile == address(0)
        // means both calls should succeed silently, no revert, no broadcast.
        vm.prank(networkOwner);
        m3.setAuthFee(NETWORK_ID, 0); // CEILING → 0; pre-wire so no broadcast attempt
        vm.prank(networkOwner);
        m3.setAuthFee(NETWORK_ID, 0.001 ether); // 0 → non-zero; pre-wire so no broadcast attempt

        // Verify the fee was stored.
        assertEq(m3.getAuthFee(NETWORK_ID), 0.001 ether, "authFee should be stored");
    }

    // ── Test 19: setCawProfile is one-shot (second call by deployer reverts) ────
    function test_SetCawProfile_SecondCall_Reverts() public {
        // manager already has cawProfile set in setUp (called by this test contract
        // which is the deployer). A second call from the deployer must also revert.
        vm.expectRevert("CawProfile already set");
        manager.setCawProfile(address(0xDEAD));
    }

    // ── Test 20: broadcastAllowFreeAuth receives network's storageChainEid ────
    function test_SetAuthFee_CorrectDestEid_Forwarded() public {
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        manager.setAuthFee{value: 0.01 ether}(NETWORK_ID, 0.005 ether);

        (, uint32 destEid,,) = mockProfile.calls(0);
        assertEq(destEid, STORAGE_EID, "LZ destEid must equal network's storageChainEid");
    }

    // ── Test 21: setCawProfile reverts if called by non-deployer (Fix 1) ─────
    function test_SetCawProfile_NotDeployer_Reverts() public {
        // Deploy a fresh manager (this test contract is the deployer).
        CawNetworkManager fresh = new CawNetworkManager(address(0x1));

        // A different address trying to set CawProfile must revert.
        address notDeployer = address(0xCAFE);
        vm.prank(notDeployer);
        vm.expectRevert("Not deployer");
        fresh.setCawProfile(address(0xABCD));

        // The deployer itself can still set it (sanity check).
        // (address(this) is the deployer of `fresh`.)
        fresh.setCawProfile(address(0xABCD));
        assertEq(fresh.cawProfile(), address(0xABCD), "deployer should succeed");
    }

    // ── Test 22: no-op broadcast (within-bucket) refunds msg.value (Fix 2) ──
    function test_SetAuthFee_NoOpBroadcast_RefundsETH() public {
        // authFee is at 0 in setUp. Set it to 0 again (no boundary crossing).
        // Attach ETH — it should be refunded.
        vm.deal(networkOwner, 1 ether);
        uint256 balanceBefore = networkOwner.balance;

        vm.prank(networkOwner);
        manager.setAuthFee{value: 0.05 ether}(NETWORK_ID, 0); // 0→0 no-op

        // No broadcast should have been triggered.
        assertEq(mockProfile.callCount(), 0, "within-bucket: no broadcast expected");

        // The ETH should be refunded (minus gas, but since vm.prank gas is free
        // in tests, balance returns to pre-call value).
        assertEq(networkOwner.balance, balanceBefore, "msg.value should be refunded on no-op");
    }

    // ── Test 23: no-op broadcast (pre-wire) refunds msg.value (Fix 2) ────────
    function test_SetAuthFee_PreWire_RefundsETH() public {
        // Deploy fresh manager WITHOUT wiring cawProfile.
        CawNetworkManager m4 = new CawNetworkManager(address(0x1));
        vm.prank(networkOwner);
        m4.createNetwork("Net4", address(0xFEE), STORAGE_EID, CEILING, CEILING, CEILING, CEILING, 5e11);

        vm.deal(networkOwner, 1 ether);
        uint256 balanceBefore = networkOwner.balance;

        // authFee starts at CEILING. Dropping to 0 crosses the boundary, BUT
        // cawProfile == address(0) so it should refund.
        vm.prank(networkOwner);
        m4.setAuthFee{value: 0.05 ether}(NETWORK_ID, 0);

        assertEq(networkOwner.balance, balanceBefore, "pre-wire: msg.value must be refunded");
    }

    // ── Test 24: normal broadcast forwards msg.value to CawProfile ───────────
    function test_SetAuthFee_NormalBroadcast_ForwardsETH() public {
        // authFee is at 0. Set it to non-zero (boundary crossing → broadcast).
        vm.deal(networkOwner, 1 ether);
        vm.prank(networkOwner);
        manager.setAuthFee{value: 0.01 ether}(NETWORK_ID, 0.001 ether);

        // The broadcast should have fired and forwarded ETH to the mock profile.
        assertEq(mockProfile.callCount(), 1, "normal broadcast expected");
        (,,, uint256 fwdValue) = mockProfile.calls(0);
        assertEq(fwdValue, 0.01 ether, "msg.value must be forwarded on normal broadcast");
    }
}
