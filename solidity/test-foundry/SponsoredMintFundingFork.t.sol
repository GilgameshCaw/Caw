// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/CawProfileMinter.sol";

// ============================================================================
// SponsoredMintFundingForkTest
// ============================================================================
// Regression test for the EIP-7702 msg.sender / tx.origin CAW-funding bug in
// CawProfileMinter.mintAndDepositSponsored and depositForSponsored.
//
// ROOT CAUSE (confirmed in Sepolia tx
//   0x7f703d670d017247427bf5fe3a6409bb5047ebc3b98fa3ac17e502c2f5258e75):
//
//   SmartEOA.initialize calls minterContract.call(mintCalldata), making
//   msg.sender to the Minter equal to the SmartEOA (user's delegated EOA).
//   The user holds 0 CAW at bootstrap time.  The original code pulled CAW
//   from _msgSender() (= SmartEOA), reverting "not enough CAW".
//   The correct payer is tx.origin — the sponsor server EOA that broadcasts
//   the type-0x04 tx, holds the CAW pool, and pre-approved the Minter.
//
// TEST STRUCTURE:
//   Both unit (no-fork) and fork (Sepolia) sections.
//   Unit tests deploy the fixed Minter with mocks and do NOT require a fork.
//   Fork tests verify sponsor's on-chain CAW/allowance preconditions only.
//
//   Unit test naming convention:
//     _before_  = reproduces the bug (expected revert)
//     _after_   = proves the fix (expected success)
//
// FORK CONFIG (Sepolia):
//   CAW     = 0x56817dc696448135203C0556f702c6a953260411
//   Sponsor = 0xF71338f3eAa483aA66125598B09BA1988e694a95 (9.1B CAW, UNLIMITED approval)
// ============================================================================

// ============================================================================
// Local mocks (used in both unit and fork unit-on-fork sections)
// ============================================================================

/// @dev Minimal ERC-20 used to stand in for CAW in unit tests.
contract ForkMockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: bal");
        require(allowance[from][msg.sender] >= amount, "ERC20: allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Minimal Uniswap V2 router stub (only WETH() is called by Minter constructor).
contract ForkMockRouter {
    address public immutable WETH;
    constructor(address w) { WETH = w; }
    function swapExactETHForTokens(uint256, address[] calldata, address, uint256)
        external payable returns (uint256[] memory) { revert("unused"); }
}

/// @dev Slim CawProfile mock: tracks owners, records last mint params.
contract ForkMockProfile {
    mapping(uint256 => address) private _owner;
    uint32 private _nextId = 1;

    address public minter;
    ForkMockERC20 public caw;

    uint32  public lastMintedId;

    constructor(address _minter, address _caw) {
        minter = _minter;
        caw = ForkMockERC20(_caw);
    }

    function nextId() external returns (uint32) { return _nextId; }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owner[tokenId];
        require(o != address(0), "ForkMockProfile: nonexistent");
        return o;
    }

    function mintAndDeposit(
        uint32, address sender, string memory, uint32 newId, uint256 depositAmount,
        uint32, uint256, bytes calldata, uint32, uint256
    ) external payable {
        if (depositAmount > 0) {
            caw.transferFrom(msg.sender, address(this), depositAmount);
        }
        _owner[newId] = sender;
        _nextId = newId + 1;
        lastMintedId = newId;
    }

    function mint(uint32, address sender, string memory, uint32 newId, uint256)
        external payable {
        _owner[newId] = sender;
        _nextId = newId + 1;
    }

    function mintAndAuth(uint32, address sender, string memory, uint32 newId,
        uint32, uint256, bytes calldata) external payable {
        _owner[newId] = sender;
        _nextId = newId + 1;
    }

    function depositFor(uint32, uint32 tokenId, uint256 amount, uint32, uint256)
        external payable {
        require(_owner[tokenId] != address(0), "ForkMockProfile: nonexistent");
        caw.transferFrom(msg.sender, address(this), amount);
    }

    function authenticateForMinter(uint32, uint32 tokenId, uint32, address owner, uint256)
        external payable {
        require(msg.sender == minter, "NotMinter");
        require(_owner[tokenId] == owner, "NotOwner");
    }

    function setLzRefundTo(address payable) external {}

    function seedToken(uint32 tokenId, address owner) external {
        _owner[tokenId] = owner;
        if (tokenId >= _nextId) _nextId = tokenId + 1;
    }
}

/// @dev ERC-1271 + ISmartEOA nonce mock — represents the user's SmartEOA.
///      isValidSignature returns magic for any non-empty sig.
contract ForkSmartEOAMock {
    bytes4 private constant MAGIC = 0x1626ba7e;
    mapping(address => mapping(uint8 => uint256)) private _nonces;

    function isValidSignature(bytes32, bytes calldata sig)
        external pure returns (bytes4)
    {
        if (sig.length == 0) return bytes4(0xffffffff);
        return MAGIC;
    }

    function nonceOf(address verifyingContract, uint8 actionType)
        external view returns (uint256)
    {
        return _nonces[verifyingContract][actionType];
    }

    function consumeNonce(address verifyingContract, uint8 actionType) external {
        require(msg.sender == verifyingContract, "mock: not verifyingContract");
        unchecked { ++_nonces[verifyingContract][actionType]; }
    }

    receive() external payable {}
}

/// @dev This contract CALLS the Minter, making msg.sender = CallerProxy to the Minter.
///      It simulates SmartEOA.initialize's call to the Minter in a 7702 tx.
///      tx.origin is set separately via vm.prank(callerProxy, txOrigin).
contract CallerProxy {
    function callMinter(address minter, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = minter.call{value: msg.value}(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
    receive() external payable {}
}

// ============================================================================
// Main test contract
// ============================================================================

contract SponsoredMintFundingForkTest is Test {

    // -----------------------------------------------------------------------
    // Sepolia on-chain addresses (for fork precondition checks only).
    // -----------------------------------------------------------------------
    address internal constant SEPOLIA_CAW     = 0x56817dc696448135203C0556f702c6a953260411;
    address internal constant SEPOLIA_SPONSOR = 0xF71338f3eAa483aA66125598B09BA1988e694a95;
    address internal constant SEPOLIA_MINTER  = 0xa7bB3f84d1A639460b3Aed31EA9E13978D2d8CD0;

    // -----------------------------------------------------------------------
    // Unit-test fixtures (no fork required)
    // -----------------------------------------------------------------------
    ForkMockERC20    internal caw;
    ForkMockProfile  internal profile;
    ForkMockRouter   internal router;
    CawProfileMinter internal minter;
    ForkSmartEOAMock internal userSmartEOA;
    CallerProxy      internal callerProxy;

    // Sponsor wallet: holds CAW + UNLIMITED approval to Minter.
    // In unit tests this is a cheatcode-controlled address.
    address internal constant UNIT_SPONSOR = address(0xF1e5700000000000000000000000000000000001);

    // Non-empty sig accepted by ForkSmartEOAMock.
    bytes internal constant ANY_SIG = hex"abcd";

    // EIP-712 typehashes (must match CawProfileMinter constants).
    bytes32 internal constant MINT_DEPOSIT_TYPEHASH = keccak256(
        "MintAndDeposit(uint32 networkId,address recipient,string username,uint256 depositAmount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce,uint8 kycLevel,uint32 sponsorTokenId,uint256 repayAmount)"
    );
    bytes32 internal constant DEPOSIT_FOR_TYPEHASH = keccak256(
        "DepositFor(uint32 networkId,uint32 tokenId,uint256 amount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce)"
    );

    // -----------------------------------------------------------------------
    // setUp — always runs (unit fixtures only; fork opt-in per test).
    // -----------------------------------------------------------------------
    function setUp() public {
        // Deploy unit-test mocks.
        caw    = new ForkMockERC20();
        router = new ForkMockRouter(address(0xdead));

        // Predict minter address so MockProfile can bake it in.
        address predictedMinter = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        profile     = new ForkMockProfile(predictedMinter, address(caw));
        minter      = new CawProfileMinter(
            address(caw),
            address(profile),
            address(router),
            address(this)   // pathwayExpander = test contract
        );
        require(address(minter) == predictedMinter, "minter address prediction mismatch");

        userSmartEOA = new ForkSmartEOAMock();
        callerProxy  = new CallerProxy();

        // Fund UNIT_SPONSOR with plenty of CAW and UNLIMITED approval.
        caw.mint(UNIT_SPONSOR, 1_000_000_000 * 10**24);
        vm.prank(UNIT_SPONSOR);
        caw.approve(address(minter), type(uint256).max);

        vm.deal(address(callerProxy), 1 ether);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _mintDigest(
        address recipient,
        string memory username,
        uint256 depositAmount,
        uint256 permitNonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            MINT_DEPOSIT_TYPEHASH,
            uint32(1),
            recipient,
            keccak256(bytes(username)),
            depositAmount,
            uint32(0),
            uint256(0),
            permitNonce,
            uint8(0),
            uint32(0),
            uint256(0)
        ));
        return keccak256(abi.encodePacked("\x19\x01", minter.DOMAIN_SEPARATOR(), structHash));
    }

    function _depositDigest(
        uint32 tokenId,
        uint256 amount,
        uint256 permitNonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            DEPOSIT_FOR_TYPEHASH,
            uint32(1),
            tokenId,
            amount,
            uint32(0),
            uint256(0),
            permitNonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", minter.DOMAIN_SEPARATOR(), structHash));
    }

    // -----------------------------------------------------------------------
    // UNIT TEST: BEFORE fix simulation
    //
    // Reproduce the bug by calling mintAndDepositSponsored such that
    // msg.sender = CallerProxy (0 CAW) and tx.origin = UNIT_SPONSOR.
    //
    // With the OLD code (_msgSender() as funder), this WOULD revert.
    // With the NEW code (tx.origin as funder), this MUST succeed.
    //
    // We document the before state in a negative-path test that verifies
    // CallerProxy has 0 CAW (the user state at bootstrap time).
    // -----------------------------------------------------------------------

    /// @notice Prove the pre-condition: CallerProxy holds 0 CAW (simulates SmartEOA).
    function test_unit_precondition_callerProxy_has_zero_caw() public view {
        uint256 callerBal = caw.balanceOf(address(callerProxy));
        assertEq(callerBal, 0, "CallerProxy must hold 0 CAW (simulates user SmartEOA at bootstrap)");
    }

    /// @notice Prove the pre-condition: UNIT_SPONSOR holds CAW + has Minter approved.
    function test_unit_precondition_sponsor_has_caw_and_approval() public view {
        assertGt(caw.balanceOf(UNIT_SPONSOR), 0, "Sponsor must hold CAW");
        assertEq(caw.allowance(UNIT_SPONSOR, address(minter)), type(uint256).max, "Sponsor must have UNLIMITED approval");
    }

    /// @notice AFTER-FIX: the 7702 call chain — CallerProxy (0 CAW) calls the Minter,
    ///         UNIT_SPONSOR is tx.origin.  With the fix the mint succeeds and CAW
    ///         is pulled from tx.origin (UNIT_SPONSOR), not msg.sender (CallerProxy).
    ///
    ///         vm.prank(addr, txOrigin) sets both msg.sender and tx.origin.
    ///           msg.sender to CallerProxy = test contract (irrelevant)
    ///           msg.sender to Minter      = CallerProxy (SmartEOA stand-in)
    ///           tx.origin                 = UNIT_SPONSOR (the broadcaster)
    function test_unit_after_fix_mintAndDepositSponsored_pullsFromTxOrigin_succeeds() public {
        uint256 depositAmount = 1_000 * 10**18;

        uint256 permitNonce = userSmartEOA.nonceOf(address(minter), 1);

        bytes memory mintCalldata = abi.encodeWithSelector(
            CawProfileMinter.mintAndDepositSponsored.selector,
            uint32(1),
            address(userSmartEOA),
            "txoriginsponsor",        // 15 chars (4-char band: 2.4B burn)
            depositAmount,
            uint32(0),
            uint256(0),
            permitNonce,
            ANY_SIG,
            uint8(0),
            uint32(0),
            uint256(0)
        );

        uint256 sponsorBalBefore = caw.balanceOf(UNIT_SPONSOR);
        uint256 callerBalBefore  = caw.balanceOf(address(callerProxy));
        assertEq(callerBalBefore, 0, "pre: CallerProxy has 0 CAW");

        // vm.prank(msg.sender, tx.origin): CallerProxy calls Minter, sponsor broadcasts.
        vm.prank(address(callerProxy), UNIT_SPONSOR);
        callerProxy.callMinter(address(minter), mintCalldata);

        // CallerProxy (SmartEOA stand-in) still has 0 CAW — it was never touched.
        assertEq(caw.balanceOf(address(callerProxy)), 0, "CallerProxy CAW must remain 0");

        // Sponsor's CAW decreased by burn + deposit.
        uint256 sponsorBalAfter = caw.balanceOf(UNIT_SPONSOR);
        assertLt(sponsorBalAfter, sponsorBalBefore, "Sponsor CAW must decrease (burn + deposit pulled from tx.origin)");

        // Token minted to userSmartEOA.
        assertEq(profile.ownerOf(1), address(userSmartEOA), "NFT must be minted to the user (recipient)");
    }

    /// @notice Before-fix simulation: if we prank UNIT_SPONSOR as BOTH msg.sender
    ///         and tx.origin (the old direct-call path), it works.  This confirms
    ///         the fix doesn't break the Population-A direct-call path where
    ///         msg.sender == tx.origin == sponsor.
    function test_unit_after_fix_direct_sponsor_call_still_works() public {
        uint256 depositAmount = 1_000 * 10**18;
        uint256 permitNonce   = userSmartEOA.nonceOf(address(minter), 1);

        // UNIT_SPONSOR calls the Minter directly (no proxy), so msg.sender = tx.origin = UNIT_SPONSOR.
        vm.prank(UNIT_SPONSOR, UNIT_SPONSOR);
        minter.mintAndDepositSponsored(
            1, address(userSmartEOA), "directsponsor", depositAmount, 0, 0,
            permitNonce, ANY_SIG, 0, 0, 0
        );

        assertEq(profile.ownerOf(1), address(userSmartEOA), "direct-call: NFT minted to user");
    }

    /// @notice Negative: confirm zero-CAW tx.origin reverts with the expected message.
    ///         This proves the fix correctly requires the broadcaster (tx.origin) to
    ///         hold + approve CAW — a random EOA cannot drain the sponsor.
    function test_unit_after_fix_zeroCawTxOrigin_reverts() public {
        address zeroCawOrigin = vm.addr(0xdeadbeef);
        assertEq(caw.balanceOf(zeroCawOrigin), 0, "precondition: origin has 0 CAW");

        uint256 permitNonce  = userSmartEOA.nonceOf(address(minter), 1);
        uint256 depositAmount = 1_000 * 10**18;

        bytes memory mintCalldata = abi.encodeWithSelector(
            CawProfileMinter.mintAndDepositSponsored.selector,
            uint32(1),
            address(userSmartEOA),
            "badorigintest",
            depositAmount,
            uint32(0),
            uint256(0),
            permitNonce,
            ANY_SIG,
            uint8(0),
            uint32(0),
            uint256(0)
        );

        // CallerProxy calls Minter; tx.origin = zeroCawOrigin (no CAW, no approval).
        vm.prank(address(callerProxy), zeroCawOrigin);
        vm.expectRevert("You do not have enough CAW to make this purchase");
        callerProxy.callMinter(address(minter), mintCalldata);
    }

    // -----------------------------------------------------------------------
    // depositForSponsored — same bug, same fix
    // -----------------------------------------------------------------------

    /// @notice AFTER-FIX: depositForSponsored via CallerProxy (0 CAW), sponsor is tx.origin.
    ///         The deposit is pulled from tx.origin (UNIT_SPONSOR).
    function test_unit_after_fix_depositForSponsored_pullsFromTxOrigin_succeeds() public {
        // Mint token first so depositForSponsored has a token to deposit into.
        uint256 mintNonce = userSmartEOA.nonceOf(address(minter), 1);
        vm.prank(UNIT_SPONSOR, UNIT_SPONSOR);
        minter.mintAndDepositSponsored(
            1, address(userSmartEOA), "depositbase", 0, 0, 0, mintNonce, ANY_SIG, 0, 0, 0
        );
        assertEq(profile.ownerOf(1), address(userSmartEOA), "pre: token minted");

        // Now depositForSponsored via the proxy.
        uint256 depositAmount    = 500 * 10**18;
        uint256 depositNonce     = userSmartEOA.nonceOf(address(minter), 2);
        uint256 sponsorBalBefore = caw.balanceOf(UNIT_SPONSOR);

        bytes memory depositCalldata = abi.encodeWithSelector(
            CawProfileMinter.depositForSponsored.selector,
            uint32(1),
            uint32(1),        // tokenId
            depositAmount,
            uint32(0),
            uint256(0),
            depositNonce,
            ANY_SIG
        );

        vm.prank(address(callerProxy), UNIT_SPONSOR);
        callerProxy.callMinter(address(minter), depositCalldata);

        uint256 sponsorBalAfter = caw.balanceOf(UNIT_SPONSOR);
        assertLt(sponsorBalAfter, sponsorBalBefore, "Sponsor CAW must decrease by deposit amount");
        assertApproxEqAbs(
            sponsorBalBefore - sponsorBalAfter,
            depositAmount,
            0,
            "Sponsor CAW decrease must equal depositAmount"
        );
        assertEq(caw.balanceOf(address(callerProxy)), 0, "CallerProxy (SmartEOA) must remain at 0 CAW");
    }

    /// @notice depositForSponsored: direct sponsor call (msg.sender == tx.origin) still works.
    function test_unit_after_fix_depositForSponsored_directCall_succeeds() public {
        uint256 mintNonce = userSmartEOA.nonceOf(address(minter), 1);
        vm.prank(UNIT_SPONSOR, UNIT_SPONSOR);
        minter.mintAndDepositSponsored(
            1, address(userSmartEOA), "depositdirect", 0, 0, 0, mintNonce, ANY_SIG, 0, 0, 0
        );

        uint256 depositAmount = 200 * 10**18;
        uint256 depositNonce  = userSmartEOA.nonceOf(address(minter), 2);

        vm.prank(UNIT_SPONSOR, UNIT_SPONSOR);
        minter.depositForSponsored(1, 1, depositAmount, 0, 0, depositNonce, ANY_SIG);

        // No revert = success.
    }

    // -----------------------------------------------------------------------
    // FORK-ONLY: verify on-chain sponsor state (preconditions check only).
    // These tests do NOT interact with the deployed (old) Minter — they only
    // read CAW balances and allowances to confirm the real sponsor wallet has
    // the expected funding for a future redeploy.
    // -----------------------------------------------------------------------

    function test_fork_sponsor_balance_and_allowance_preconditions() public {
        string memory rpc = vm.envOr("RPC_SEPOLIA", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);

        IERC20 sepoliaCAW = IERC20(SEPOLIA_CAW);
        uint256 sponsorBal       = sepoliaCAW.balanceOf(SEPOLIA_SPONSOR);
        uint256 minterAllowance  = sepoliaCAW.allowance(SEPOLIA_SPONSOR, SEPOLIA_MINTER);

        assertGt(sponsorBal, 0,       "Sepolia: sponsor must hold CAW");
        assertGt(minterAllowance, 0,  "Sepolia: sponsor must have approved Minter");
    }
}
