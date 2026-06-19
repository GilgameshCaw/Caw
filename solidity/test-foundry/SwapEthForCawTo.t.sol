// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfileMinter.sol";

// =============================================================================
// SwapEthForCawTo.t.sol
// =============================================================================
//
// Tests for CawProfileMinter.swapEthForCawTo(address recipient, uint256 minCawOut).
//
// This function:
//   - Swaps the FULL msg.value of ETH → CAW via Uniswap V2 router
//   - Sends the CAW output directly to `recipient` (not to the Minter)
//   - Does NOT deposit to a profile or fire LayerZero
//   - Sweeps any residual ETH back to msg.sender (sweepResidualEth modifier)
//
// Use case: passkey-wallet "pay with ETH" top-up
//   Step 1 (this fn): relayer submits swapEthForCawTo(userEOA, minCawOut)
//                     → CAW lands in user's own EOA
//   Step 2 (separate): relayer submits depositFor(...)
//                     → CAW moves from user's EOA to profile balance
//
// =============================================================================

// =============================================================================
// Mocks
// =============================================================================

/// @dev Minimal ERC-20 (CAW stand-in). Supports balanceOf / approve / transfer /
///      transferFrom. No actual business logic — just tracks balances.
contract SWAPMockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: balance");
        require(allowance[from][msg.sender] >= amount, "ERC20: allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Uniswap V2 router mock that actually transfers CAW to the recipient.
///      The swap ratio is 1 ETH → SWAP_RATE CAW (fixed, deterministic).
///      WETH is a dummy address — only the WETH() getter is needed by the Minter
///      constructor; path[0] is never executed.
///
///      RESIDUAL ETH: the router accepts exactly `ethAmount` (msg.value) and
///      keeps it (simulating the real AMM pool). The Minter's sweepResidualEth
///      modifier has nothing to sweep in the normal case. To test the residual
///      path we use a separate mock (SWAPMockRouterWithResidue) that forwards
///      1 wei back to msg.sender, simulating a rounding artefact.
contract SWAPMockRouter {
    address public immutable WETH;
    SWAPMockERC20 public immutable caw;

    /// @dev Fixed exchange rate: 1 ETH = SWAP_RATE CAW (in 18-decimal units).
    uint256 public constant SWAP_RATE = 1_000;

    constructor(address _weth, address _caw) {
        WETH = _weth;
        caw = SWAPMockERC20(_caw);
    }

    /// @dev Simulate swapExactETHForTokens: consume msg.value, mint SWAP_RATE * ethIn
    ///      CAW to `to`. Reverts if computed output < amountOutMin (slippage check).
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata /*path*/,
        address to,
        uint256 /*deadline*/
    ) external payable returns (uint256[] memory amounts) {
        uint256 ethIn = msg.value;
        uint256 cawOut = ethIn * SWAP_RATE;
        require(cawOut >= amountOutMin, "MockRouter: slippage");
        caw.mint(to, cawOut);
        amounts = new uint256[](2);
        amounts[0] = ethIn;
        amounts[1] = cawOut;
    }

    receive() external payable {}
}

/// @dev Router variant that returns 1 wei residual to the Minter after the swap.
///      Used to verify that sweepResidualEth returns it to the original caller.
contract SWAPMockRouterWithResidue {
    address public immutable WETH;
    SWAPMockERC20 public immutable caw;
    uint256 public constant SWAP_RATE = 1_000;

    constructor(address _weth, address _caw) {
        WETH = _weth;
        caw = SWAPMockERC20(_caw);
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata /*path*/,
        address to,
        uint256 /*deadline*/
    ) external payable returns (uint256[] memory amounts) {
        uint256 ethIn = msg.value;
        // Keep ethIn - 1 wei, send 1 wei residual back to the Minter (msg.sender).
        uint256 residual = 1;
        uint256 effectiveEth = ethIn - residual;
        uint256 cawOut = effectiveEth * SWAP_RATE;
        require(cawOut >= amountOutMin, "MockRouter: slippage");
        caw.mint(to, cawOut);
        // Return residual to the Minter so sweepResidualEth can detect it.
        (bool ok,) = payable(msg.sender).call{value: residual}("");
        require(ok, "MockRouter: residual transfer failed");
        amounts = new uint256[](2);
        amounts[0] = effectiveEth;
        amounts[1] = cawOut;
    }

    receive() external payable {}
}

/// @dev Minimal CawProfile mock. Only needed because CawProfileMinter's
///      constructor takes _cawProfiles and calls nextId() on it. This stub
///      satisfies the IMint interface surface that the Minter constructor uses.
///      swapEthForCawTo does NOT call into the profile, so this is truly minimal.
contract SWAPMockProfile {
    uint32 private _nextId = 1;
    mapping(uint256 => address) private _owner;
    address public networkManager;

    struct NoopNM {
        uint8 dummy; // just to hold a reference; functions via interface
    }

    constructor() {
        // Deploy a no-op network manager so the Minter constructor's
        // ICawNetworkManagerSponsorExempt calls don't revert.
        networkManager = address(new SWAPMockNM());
    }

    function nextId() external returns (uint32) { return _nextId; }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _owner[tokenId];
    }

    function setLzRefundTo(address payable) external {}

    // Stub out the rest of the IMint surface (never called by swapEthForCawTo).
    function mint(uint32, address, string memory, uint32, uint256) external payable {}
    function mintAndAuth(uint32, address, string memory, uint32, uint32, uint256, bytes calldata) external payable {}
    function mintAndDeposit(uint32, address, string memory, uint32, uint256, uint32, uint256, bytes calldata, uint32, uint256) external payable {}
    function depositFor(uint32, uint32, uint256, uint32, uint256) external payable {}
    function authenticateForMinter(uint32, uint32, uint32, address, uint256) external payable {}
}

contract SWAPMockNM {
    function isAuthorizedSponsor(uint32, address) external pure returns (bool) { return false; }
    function flagDepositFeeExempt(uint32) external {}
    function clearDepositFeeExempt() external {}
}

// =============================================================================
// SwapEthForCawToTest
// =============================================================================

contract SwapEthForCawToTest is Test {

    SWAPMockERC20   internal caw;
    SWAPMockRouter  internal router;
    SWAPMockProfile internal profile;
    CawProfileMinter internal minter;

    address internal alice;
    address internal bob;

    // Dummy PathwayExpander — just needs to be non-zero for the constructor guard.
    address internal constant PATHWAY_EXPANDER = address(0x1234);

    function setUp() public {
        alice = makeAddr("alice");
        bob   = makeAddr("bob");
        vm.deal(alice, 10 ether);
        vm.deal(address(this), 10 ether);

        caw     = new SWAPMockERC20();
        router  = new SWAPMockRouter(address(0xdead) /* WETH stub */, address(caw));
        profile = new SWAPMockProfile();

        minter = new CawProfileMinter(
            address(caw),
            address(profile),
            address(router),
            PATHWAY_EXPANDER
        );
    }

    // =========================================================================
    // Happy path: CAW lands in recipient, msg.value fully consumed
    // =========================================================================

    /// @notice Full swap: 1 ETH in → SWAP_RATE CAW out → CAW lands in `bob`.
    function test_swapEthForCawTo_happyPath() public {
        uint256 ethIn   = 1 ether;
        uint256 minCaw  = 900; // well below the 1000 SWAP_RATE output
        uint256 expectedCaw = ethIn * router.SWAP_RATE();

        uint256 bobCawBefore  = caw.balanceOf(bob);
        uint256 aliceEthBefore = alice.balance;

        vm.prank(alice);
        minter.swapEthForCawTo{value: ethIn}(bob, minCaw);

        // CAW went to bob (the designated recipient).
        assertEq(
            caw.balanceOf(bob) - bobCawBefore,
            expectedCaw,
            "Bob should receive SWAP_RATE * ethIn CAW"
        );

        // CAW did NOT land in the Minter (it bypasses address(this)).
        assertEq(caw.balanceOf(address(minter)), 0, "Minter should hold no CAW");

        // Alice paid exactly ethIn (no ETH residual in this path).
        assertEq(aliceEthBefore - alice.balance, ethIn, "Alice should have spent exactly ethIn");
    }

    // =========================================================================
    // Slippage floor enforced: minCawOut > actual output → revert
    // =========================================================================

    function test_swapEthForCawTo_slippageReverts() public {
        uint256 ethIn  = 1 ether;
        uint256 minCaw = ethIn * router.SWAP_RATE() + 1; // one more than possible

        vm.prank(alice);
        vm.expectRevert("MockRouter: slippage");
        minter.swapEthForCawTo{value: ethIn}(bob, minCaw);
    }

    // =========================================================================
    // Zero ETH → revert "No ETH"
    // =========================================================================

    function test_swapEthForCawTo_zeroEth_reverts() public {
        vm.prank(alice);
        vm.expectRevert("No ETH");
        minter.swapEthForCawTo{value: 0}(bob, 0);
    }

    // =========================================================================
    // Zero recipient → revert "Bad recipient"
    // =========================================================================

    function test_swapEthForCawTo_zeroRecipient_reverts() public {
        vm.prank(alice);
        vm.expectRevert("Bad recipient");
        minter.swapEthForCawTo{value: 1 ether}(address(0), 0);
    }

    // =========================================================================
    // Residual ETH swept back to msg.sender
    // =========================================================================

    /// @dev Deploy a fresh Minter backed by SWAPMockRouterWithResidue, which
    ///      returns 1 wei to the Minter after the swap. The sweepResidualEth
    ///      modifier must then forward that 1 wei back to the original caller.
    function test_swapEthForCawTo_residualEthSweptToCaller() public {
        SWAPMockRouterWithResidue residueRouter =
            new SWAPMockRouterWithResidue(address(0xdead), address(caw));
        CawProfileMinter minterWithResidue = new CawProfileMinter(
            address(caw),
            address(profile),
            address(residueRouter),
            PATHWAY_EXPANDER
        );

        uint256 ethIn  = 1 ether;
        uint256 minCaw = 0;

        uint256 aliceEthBefore = alice.balance;

        vm.prank(alice);
        minterWithResidue.swapEthForCawTo{value: ethIn}(bob, minCaw);

        // Router returned 1 wei residual to the Minter; sweepResidualEth
        // must have forwarded it to alice. Net cost = ethIn - 1.
        assertEq(
            aliceEthBefore - alice.balance,
            ethIn - 1,
            "Alice should have received the 1-wei residual back"
        );

        // Minter must hold no ETH after the sweep.
        assertEq(address(minterWithResidue).balance, 0, "Minter must be drained after sweep");
    }

    // =========================================================================
    // SwappedEthForCaw event emitted with correct fields
    // =========================================================================

    function test_swapEthForCawTo_emitsEvent() public {
        uint256 ethIn   = 0.5 ether;
        uint256 minCaw  = 0;
        uint256 expectedCaw = ethIn * router.SWAP_RATE();

        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(minter));
        emit SwappedEthForCaw(bob, ethIn, expectedCaw);
        minter.swapEthForCawTo{value: ethIn}(bob, minCaw);
    }

    // Helper: declare the event signature so vm.expectEmit can match it.
    event SwappedEthForCaw(address indexed recipient, uint256 ethIn, uint256 cawOut);

    // =========================================================================
    // Existing _swapEthForCaw callers (depositZap) still work correctly
    // — regression guard to ensure we didn't break the old path that sends
    //   output to address(this).
    // =========================================================================

    function test_depositZap_still_lands_in_minter_not_recipient() public {
        // We cannot call depositZap through the real Minter because it will call
        // CawProfile.depositFor which our stub doesn't handle the CAW pull.
        // Instead, call swapEthForCawTo with recipient=address(minter) to verify
        // that _swapEthForCawTo(to=address(this)) correctly lands CAW in the Minter,
        // matching the old _swapEthForCaw behavior.
        uint256 ethIn = 1 ether;

        vm.prank(alice);
        minter.swapEthForCawTo{value: ethIn}(address(minter), 0);

        uint256 minterCaw = caw.balanceOf(address(minter));
        assertEq(
            minterCaw,
            ethIn * router.SWAP_RATE(),
            "When recipient=minter the swap output lands on the Minter (same as old _swapEthForCaw)"
        );
    }

    receive() external payable {}
}
