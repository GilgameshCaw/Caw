// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// =============================================================================
// VaultConservation.t.sol — Foundry invariant test
//
// Property: CawProfile.totalCaw == ghost_realDeposited - ghost_realWithdrawn
//           after EVERY deposit/withdraw operation. The vault must also be
//           solvent: CAW.balanceOf(cawProfile) >= cawProfile.totalCaw().
//           L2 mirror must track L1: cawProfileL2.totalCaw() == cawProfile.totalCaw().
//
// Setup: full bypassLZ co-deployment (CawProfile ↔ CawProfileL2 on the same
//        Foundry chain). Uses MintableCaw as the ERC-20. Real CawNetworkManager,
//        real CawProfile, real CawProfileL2 — no mocks for the core vault logic.
//
// Withdrawal simulation: vm.store writes withdrawable[tokenId] to model the
//        real L2→L1 LZ path that CawActions uses, then withdrawTo is called
//        by the token owner.
// =============================================================================

import "forge-std/Test.sol";
import "../contracts/CawProfile.sol";
import "../contracts/CawProfileL2.sol";
import "../contracts/MintableCaw.sol";
import "../contracts/CawNetworkManager.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

// ---------------------------------------------------------------------------
// Inline stubs
// ---------------------------------------------------------------------------

contract StubBuyAndBurn_VC {
    receive() external payable {}
    function swapAndSplit(uint256 /*minCawOut*/, address /*recipient*/)
        external payable returns (uint256)
    { return 0; }
}

contract StubCawProfileURI_VC {
    function generate(string memory) external pure returns (string memory) { return ""; }
}

// ---------------------------------------------------------------------------
// Handler — inherits Test so vm.* and bound() are available.
// ---------------------------------------------------------------------------
contract VaultConservationHandler is Test {
    CawProfile        public cawProfile;
    CawProfileL2      public cawProfileL2;
    MintableCaw       public cawToken;

    address[5] public actors;
    uint32[5]  public tokenIds;
    uint32     public networkId;

    uint256 public ghost_realDeposited;
    uint256 public ghost_realWithdrawn;

    // Pre-computed storage slot parameters for vm.store
    uint256 public withdrawableMapSlot;
    uint256 public totalCawSlot;
    uint256 public l2TotalCawSlot;

    uint32 constant MAINNET_LZ_ID = 1;
    uint256 constant MAX_AMOUNT = 1_000_000 ether;

    constructor(
        CawProfile    _cawProfile,
        CawProfileL2  _cawProfileL2,
        MintableCaw   _cawToken,
        address[5] memory _actors,
        uint32[5]  memory _tokenIds,
        uint32 _networkId,
        uint256 _withdrawableMapSlot,
        uint256 _totalCawSlot,
        uint256 _l2TotalCawSlot
    ) {
        cawProfile          = _cawProfile;
        cawProfileL2        = _cawProfileL2;
        cawToken            = _cawToken;
        actors              = _actors;
        tokenIds            = _tokenIds;
        networkId           = _networkId;
        withdrawableMapSlot = _withdrawableMapSlot;
        totalCawSlot        = _totalCawSlot;
        l2TotalCawSlot      = _l2TotalCawSlot;
    }

    function handler_deposit(uint256 actorSeed, uint256 amountSeed) external {
        uint256 idx    = bound(actorSeed, 0, 4);
        address actor  = actors[idx];
        uint32  tid    = tokenIds[idx];

        uint256 available = cawToken.balanceOf(actor);
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 1, available > MAX_AMOUNT ? MAX_AMOUNT : available);

        vm.startPrank(actor);
        cawToken.approve(address(cawProfile), amount);
        cawProfile.depositFor(networkId, tid, amount, MAINNET_LZ_ID, 0);
        vm.stopPrank();

        ghost_realDeposited += amount;
    }

    /// @notice Simulate L2→L1 withdrawable credit + withdraw for a random actor.
    function handler_withdraw(uint256 actorSeed, uint256 amountSeed) external {
        uint256 idx   = bound(actorSeed, 0, 4);
        address actor = actors[idx];
        uint32  tid   = tokenIds[idx];

        uint256 vaultBalance = cawToken.balanceOf(address(cawProfile));
        if (vaultBalance == 0) return;
        uint256 creditAmount = bound(amountSeed, 1, vaultBalance > MAX_AMOUNT ? MAX_AMOUNT : vaultBalance);

        uint256 existing     = cawProfile.withdrawable(tid);
        uint256 newAmount    = existing + creditAmount;

        // Write withdrawable[tid] directly (models the LZ setWithdrawable call)
        bytes32 slot = keccak256(abi.encode(uint256(tid), withdrawableMapSlot));
        vm.store(address(cawProfile), slot, bytes32(newAmount));

        // Ensure totalCaw >= newAmount before withdrawTo decrements it
        uint256 l1TotalCaw = cawProfile.totalCaw();
        if (l1TotalCaw < newAmount) {
            uint256 bump = newAmount - l1TotalCaw;
            vm.store(address(cawProfile), bytes32(totalCawSlot), bytes32(newAmount));
            cawToken.mint(address(cawProfile), bump);
            ghost_realDeposited += bump; // synthetic injection, tracked as deposit
        }

        // Ensure vault holds enough CAW
        uint256 l1Balance = cawToken.balanceOf(address(cawProfile));
        if (l1Balance < newAmount) {
            uint256 topUp = newAmount - l1Balance;
            cawToken.mint(address(cawProfile), topUp);
            ghost_realDeposited += topUp;
        }

        // Mirror the L2 totalCaw decrement. In the real protocol, CawActions
        // decrements L2 totalCaw BEFORE setWithdrawable sends the LZ message to L1.
        // Without this the l2MirrorMatchesL1 invariant would always fail
        // because the test harness never calls L2.spendAndDistribute.
        uint256 l2TotalCaw = cawProfileL2.totalCaw();
        if (l2TotalCaw >= newAmount) {
            vm.store(address(cawProfileL2), bytes32(l2TotalCawSlot), bytes32(l2TotalCaw - newAmount));
        }

        vm.prank(actor);
        cawProfile.withdrawTo(networkId, tid, actor, 0);

        ghost_realWithdrawn += newAmount;
    }

    function handler_replenish(uint256 actorSeed) external {
        uint256 idx = bound(actorSeed, 0, 4);
        cawToken.mint(actors[idx], 1_000_000 ether);
    }
}

// ---------------------------------------------------------------------------
// Invariant test
// ---------------------------------------------------------------------------
contract VaultConservationTest is Test {
    using stdStorage for StdStorage;

    CawProfile           cawProfile;
    CawProfileL2         cawProfileL2;
    MintableCaw          cawToken;
    CawNetworkManager    networkManager;
    StubBuyAndBurn_VC    buyAndBurn;
    StubCawProfileURI_VC uriGen;

    VaultConservationHandler handler;

    uint32 constant MAINNET_LZ_ID = 1;
    uint32 constant NETWORK_ID    = 1;

    address[5] actors;
    uint32[5]  tokenIds;

    function setUp() public {
        cawToken   = new MintableCaw();
        buyAndBurn = new StubBuyAndBurn_VC();
        uriGen     = new StubCawProfileURI_VC();

        MockLayerZeroEndpoint lzL1 = new MockLayerZeroEndpoint(MAINNET_LZ_ID);
        MockLayerZeroEndpoint lzL2 = new MockLayerZeroEndpoint(2);

        networkManager = new CawNetworkManager(address(buyAndBurn));

        cawProfileL2 = new CawProfileL2(MAINNET_LZ_ID, address(lzL2), address(0));

        cawProfile = new CawProfile(
            address(cawToken), address(uriGen), address(buyAndBurn),
            address(networkManager), address(lzL1), MAINNET_LZ_ID, address(0)
        );

        cawProfile.setL2Peer(MAINNET_LZ_ID, address(cawProfileL2));
        cawProfileL2.setL1Peer(MAINNET_LZ_ID, payable(address(cawProfile)), true);
        cawProfile.setMinter(address(this));

        // storageChainEid must be > 0; use 2 (same as L2 LZ ID)
        networkManager.createNetwork("TestNet", address(this), 2, 0, 0, 0, 0, 0);

        for (uint256 i = 0; i < 5; i++) {
            actors[i]   = vm.addr(i + 1);
            tokenIds[i] = uint32(i + 1);
            cawToken.mint(actors[i], 10_000_000 ether);
            cawProfile.mint(
                NETWORK_ID, actors[i],
                string(abi.encodePacked("user", vm.toString(i + 1))),
                tokenIds[i], 0
            );
        }

        // Resolve storage slots using stdstore
        uint256 withdrawableMapSlot = _findMappingBaseSlot(
            address(cawProfile), "withdrawable(uint32)", uint32(99999)
        );
        uint256 totalCawSlot = stdstore
            .target(address(cawProfile))
            .sig("totalCaw()")
            .find();
        uint256 l2TotalCawSlot = stdstore
            .target(address(cawProfileL2))
            .sig("totalCaw()")
            .find();

        handler = new VaultConservationHandler(
            cawProfile, cawProfileL2, cawToken,
            actors, tokenIds, NETWORK_ID,
            withdrawableMapSlot, totalCawSlot, l2TotalCawSlot
        );

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.handler_deposit.selector;
        selectors[1] = handler.handler_withdraw.selector;
        selectors[2] = handler.handler_replenish.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Find the map base slot for a uint32-keyed mapping by solving the
    ///      keccak pre-image: concreteSlot = keccak256(abi.encode(key, mapSlot)).
    ///      We use stdstore to get the concrete slot for a sentinel key, then
    ///      probe base slots 0..63 to find which one yields that concrete slot.
    function _findMappingBaseSlot(
        address target_, string memory sigStr, uint32 sentinelKey
    ) internal returns (uint256) {
        uint256 concreteSlot = stdstore
            .target(target_)
            .sig(sigStr)
            .with_key(uint256(sentinelKey))
            .find();
        for (uint256 s = 0; s < 64; s++) {
            if (uint256(keccak256(abi.encode(uint256(sentinelKey), s))) == concreteSlot) {
                return s;
            }
        }
        revert("_findMappingBaseSlot: not found in 0..63");
    }

    function invariant_vaultConservation() public view {
        uint256 expected = handler.ghost_realDeposited() - handler.ghost_realWithdrawn();
        assertEq(
            cawProfile.totalCaw(),
            expected,
            "VaultConservation: totalCaw != deposited - withdrawn"
        );
    }

    function invariant_vaultSolvency() public view {
        assertGe(
            cawToken.balanceOf(address(cawProfile)),
            cawProfile.totalCaw(),
            "Solvency: vault CAW balance < totalCaw"
        );
    }

    function invariant_l2MirrorMatchesL1() public view {
        assertEq(
            cawProfileL2.totalCaw(),
            cawProfile.totalCaw(),
            "L2Mirror: cawProfileL2.totalCaw != cawProfile.totalCaw"
        );
    }

    function invariant_rewardMultiplierNonDecreasing() public view {
        assertGe(
            cawProfileL2.rewardMultiplier(),
            1e18,
            "rewardMultiplier fell below initial value"
        );
    }
}
