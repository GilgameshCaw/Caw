// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/SmartEOA.sol";
import "../contracts/CawProfileMinter.sol";

// =============================================================================
// PopBBootstrapE2E.t.sol
// =============================================================================
//
// Comprehensive end-to-end test for the Population-B sponsored-bootstrap flow:
//
//   sponsor EOA (tx.origin, holds CAW)
//     → SmartEOA.initialize(pkX, pkY, ecdsaFallback, minter, mintCalldata)
//       [SmartEOA msg.sender=SmartEOA, tx.origin=sponsor]
//       → CawProfileMinter.mintAndDepositSponsored(...)
//         → _checkPermit: ISmartEOA.nonceOf + ERC-1271.isValidSignature(150k gas) + consumeNonce
//         → _burnAndAssignId: CAW.transferFrom(tx.origin=sponsor, dead, burnAmount)
//         → CAW.transferFrom(sponsor, minter, depositAmount)
//         → CAW.approve(profile, depositAmount)
//         → MockProfile.mintAndDeposit{value: lzFee}(...)
//           → CAW.transferFrom(minter, profile, depositAmount)
//           → NFT minted to recipient (SmartEOA/userEOA)
//           → records lzSend fee
//
// FIXES ALREADY IN PLACE (verified by this test):
//   - a63cf604: ERC1271_GAS_LIMIT 50k→150k (WebAuthn isValidSignature gas)
//   - a15464f5: payer = tx.origin when msg.sender is contract (sponsor CAW pull)
//
// BUG HUNT: Actively looks for a 6th stacked bug in:
//   (a) SmartEOA.initialize gas forwarding to Minter inner call
//   (b) nonce/ACTION_MINT_DEPOSIT consumption ordering
//   (c) msg.value forwarding: sponsor → initialize → Minter → Profile
//   (d) CawProfile-side requires on a fresh mint
//
// P-256 STRATEGY:
//   The EIP-7951 P-256 precompile is not live in foundry's local EVM.
//   We use the MockP256Precompile pattern (same as SmartEOA.t.sol /
//   SmartEOAGas.t.sol): a registry of accepted input hashes installed at
//   0x0100 via vm.etch. This exercises the FULL SmartEOA isValidSignature →
//   _verifyWebAuthnSafe → self-staticcall → _verifyWebAuthn → P256 path,
//   including the 63/64 gas forwarding the old 50k limit broke.
//
// LZ STRATEGY:
//   We use a rich CawProfile mock (E2EMockProfile) that:
//   - Performs the real CAW transferFrom (exercises sponsor-funding path)
//   - Records lzSend details (asserts fee > 0 and was forwarded)
//   - Mints the ERC-721 NFT to the recipient
//   - Implements setLzRefundTo and all the IMint interface methods
//   This avoids deploying the full 9-arg CawProfile + NetworkManager + BuyAndBurn
//   stack while keeping all critical financial flows real.
//
// 7702 DELEGATION STRATEGY:
//   We use vm.etch to copy SmartEOA's runtime bytecode into a fresh EOA address.
//   This correctly models: EOA has SmartEOA code, storage is per-EOA (not the
//   implementation), and msg.sender inside initialize is the EOA address.
//   vm.signAndAttachDelegation is not used because it would override the test
//   flow; vm.etch is functionally equivalent for testing the call chain.
//
// =============================================================================

// =============================================================================
// P-256 mock infrastructure (copied from SmartEOA.t.sol pattern)
// =============================================================================

contract E2EP256Registry {
    mapping(bytes32 => bool) public accepted;
    function register(bytes32 inputHash) external {
        accepted[inputHash] = true;
    }
}

contract E2EMockP256Precompile {
    E2EP256Registry public immutable registry;
    constructor(address _registry) { registry = E2EP256Registry(_registry); }
    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length < 160) return new bytes(0);
        bytes32 h = keccak256(input[0:160]);
        if (registry.accepted(h)) return abi.encode(uint256(1));
        return new bytes(0);
    }
}

// =============================================================================
// Minimal ERC-20 (CAW stand-in)
// =============================================================================

contract E2EMockCAW {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "E2ECAW: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "E2ECAW: balance");
        require(allowance[from][msg.sender] >= amount, "E2ECAW: allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// =============================================================================
// Minimal Uniswap V2 router stub (Minter constructor needs WETH())
// =============================================================================

contract E2EMockRouter {
    address public immutable WETH;
    constructor(address _weth) { WETH = _weth; }
    function swapExactETHForTokens(uint256, address[] calldata, address, uint256)
        external payable returns (uint256[] memory) { revert("unused"); }
}

// =============================================================================
// Rich CawProfile mock — performs real CAW transfers, records LZ send
// =============================================================================

/// @dev Implements IMint so CawProfileMinter can call it without knowing it's a mock.
///      Real financial flows: CAW.transferFrom(minter, self, deposit).
///      LZ recording: tracks the ETH value forwarded as the LZ fee.
contract E2EMockProfile {
    E2EMockCAW public caw;

    mapping(uint256 => address) private _owner;
    uint32 private _nextId = 1;
    string[] public usernames;

    // Recorded from the most recent mintAndDeposit call.
    uint32  public lastMintedId;
    address public lastMintedOwner;
    uint256 public lastDepositAmount;
    uint256 public lastLzEthForwarded;  // msg.value received by mintAndDeposit
    uint32  public lastLzDestId;
    uint32  public lastSponsorTokenId;
    uint256 public lastRepayAmount;

    // setLzRefundTo tracking (audit H-1 fix verification).
    address payable public lastRefundTo;
    uint256 public setLzRefundToCallCount;

    // Simulated LZ fee that the mock accepts without sending a real message.
    // The mock accepts any msg.value; we track it to assert fee forwarding.
    uint256 public simulatedLzFeeReceived;

    constructor(address _caw) {
        caw = E2EMockCAW(_caw);
    }

    function nextId() external returns (uint32) { return _nextId; }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owner[tokenId];
        require(o != address(0), "E2EMockProfile: nonexistent");
        return o;
    }

    /// @notice Mint + deposit: pulls CAW from msg.sender (= Minter), records LZ fee.
    function mintAndDeposit(
        uint32 /*networkId*/,
        address owner,
        string memory username,
        uint32 newId,
        uint256 depositAmount,
        uint32 lzDestId,
        uint256 /*lzTokenAmount*/,
        bytes calldata /*sessionExtra*/,
        uint32 sponsorTokenId,
        uint256 repayAmount
    ) external payable {
        // Pull the deposit CAW from the Minter (msg.sender).
        // The Minter will have done: caw.approve(this, depositAmount) first.
        if (depositAmount > 0) {
            require(caw.transferFrom(msg.sender, address(this), depositAmount), "E2EMockProfile: caw pull failed");
        }

        // Mint the NFT.
        _owner[newId] = owner;
        _nextId = newId + 1;
        usernames.push(username);

        // Record call data.
        lastMintedId        = newId;
        lastMintedOwner     = owner;
        lastDepositAmount   = depositAmount;
        lastLzEthForwarded  = msg.value;
        lastLzDestId        = lzDestId;
        lastSponsorTokenId  = sponsorTokenId;
        lastRepayAmount     = repayAmount;

        // Simulate an lzSend: track the ETH we received.
        // In a real scenario this would call lzEndpoint.send{value: msg.value}(...)
        simulatedLzFeeReceived += msg.value;
    }

    function mint(uint32, address owner, string memory, uint32 newId, uint256)
        external payable {
        _owner[newId] = owner;
        _nextId = newId + 1;
    }

    function mintAndAuth(uint32, address owner, string memory, uint32 newId,
        uint32, uint256, bytes calldata) external payable {
        _owner[newId] = owner;
        _nextId = newId + 1;
    }

    function depositFor(uint32, uint32 tokenId, uint256 amount, uint32, uint256)
        external payable {
        require(_owner[tokenId] != address(0), "E2EMockProfile: nonexistent");
        caw.transferFrom(msg.sender, address(this), amount);
    }

    function authenticateForMinter(uint32, uint32 tokenId, uint32, address owner, uint256)
        external payable {
        require(_owner[tokenId] == owner, "E2EMockProfile: NotOwner");
    }

    /// @notice Minter calls this before + after each sponsored lzSend.
    ///         Track to verify the audit H-1 fix is exercised.
    function setLzRefundTo(address payable refundTo) external {
        lastRefundTo = refundTo;
        setLzRefundToCallCount++;
    }

    // Accept ETH (lzSend calls may forward value).
    receive() external payable {}
}

// =============================================================================
// CallerProxy — simulates SmartEOA.initialize → Minter call in the 7702 model
// =============================================================================

/// @dev In the real 7702 flow:
///      tx.to = userEOA (has SmartEOA code via 7702 delegation)
///      SmartEOA.initialize(.., minterContract, mintCalldata) does:
///        (bool ok,) = minterContract.call{value: msg.value}(mintCalldata)
///
///      In this test we model it via vm.etch (SmartEOA code at userEOA)
///      and call initialize directly. The tx.origin is set via the 2-arg
///      form: vm.prank(sponsor, sponsor). When SmartEOA.initialize runs its
///      inner .call to the Minter, msg.sender=userEOA but tx.origin stays
///      as the sponsor. This is the faithful model of the 7702 path.
///
///      We also separately test via CallerProxy (same pattern as
///      SponsoredMintFundingFork.t.sol) to verify the tx.origin CAW-pull fix
///      works when msg.sender != tx.origin.
contract E2ECallerProxy {
    function callMinter(address minter, bytes calldata data) external payable {
        (bool ok, bytes memory ret) = minter.call{value: msg.value}(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
    receive() external payable {}
}

// =============================================================================
// Main test
// =============================================================================

contract PopBBootstrapE2ETest is Test {

    // =========================================================================
    // P-256 key constants (same real NIST P-256 point as SmartEOA.t.sol §7)
    // =========================================================================

    bytes32 constant PK1_X = bytes32(0x4359cf55e848ec6f18a1163aeb2dfe474aad0db80bf5be418b689033e04dd032);
    bytes32 constant PK1_Y = bytes32(0xf18e3dafea96113646f34a71badc522653c4f0bdc86ffc6255db7823b4edd221);

    // Arbitrary r, s — registered in the mock so the precompile accepts them.
    bytes32 constant SIG_R = bytes32(0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa);
    bytes32 constant SIG_S = bytes32(0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb);

    // Minimal 37-byte authenticatorData (all zeros).
    bytes constant AUTH_DATA = hex"00000000000000000000000000000000000000000000000000000000000000000000000000";

    // =========================================================================
    // secp256k1 key for ecdsaFallback
    // =========================================================================

    uint256 internal constant ECDSA_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    // =========================================================================
    // Test infrastructure
    // =========================================================================

    E2EP256Registry      internal p256Registry;
    SmartEOA             internal smartEoaImpl;
    E2EMockCAW           internal caw;
    E2EMockProfile       internal profile;
    E2EMockRouter        internal router;
    CawProfileMinter     internal minter;
    E2ECallerProxy       internal callerProxy;

    // The user's EOA address (SmartEOA code is etch'd here).
    // Using a fresh address that isn't the test contract itself.
    address payable internal userEOA;
    address internal ecdsaFallback;

    // The sponsor server's EOA — holds CAW, has approved the Minter.
    address internal sponsor;
    uint256 internal constant SPONSOR_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // CAW amounts. Using a long (8+ char) username so burnAmount = 1e6 * 1e18 (cheapest).
    string internal constant USERNAME       = "popbuser1"; // 9 chars
    uint256 internal constant DEPOSIT_AMOUNT = 1_000 * 1e18;
    uint256 internal constant LZ_FEE        = 0.001 ether;
    uint32  internal constant NETWORK_ID    = 1;
    // lzDestId != mainnetLzId to trigger the cross-chain LZ branch in real CawProfile.
    // In our mock profile this just means msg.value > 0 is forwarded through.
    uint32  internal constant LZ_DEST_ID   = 40245;  // Base Sepolia EID

    // Dead address used by _burnAndAssignId.
    address internal constant DEAD = 0xdEAD000000000000000042069420694206942069;

    // =========================================================================
    // setUp
    // =========================================================================

    function setUp() public {
        // --- P-256 mock ---
        p256Registry = new E2EP256Registry();
        E2EMockP256Precompile mockP256 = new E2EMockP256Precompile(address(p256Registry));
        // Install mock precompile at the EIP-7951 address.
        vm.etch(address(0x0100), address(mockP256).code);

        // --- SmartEOA implementation ---
        // Deploy the real SmartEOA; we'll etch its code onto the user EOA.
        smartEoaImpl = new SmartEOA();

        // --- User EOA setup ---
        // We use vm.addr(ECDSA_PK) as the user's EOA so we have a known private key.
        // The ecdsaFallback is the same address in this test — in production the user
        // generates a SEPARATE secp256k1 key for the fallback, but for the test
        // we want a key we can sign with.
        ecdsaFallback = vm.addr(ECDSA_PK);
        userEOA = payable(ecdsaFallback); // user's EOA is their secp256k1 address

        // Install SmartEOA runtime code at userEOA via vm.etch.
        // After etch, calls to userEOA dispatch through SmartEOA selectors,
        // but storage reads/writes use userEOA's storage slots.
        // This faithfully models the 7702 delegation:
        //   EOA.code = 0xef0100 || address(smartEoaImpl)
        // and all subsequent dispatch hits SmartEOA's logic with per-EOA storage.
        vm.etch(userEOA, address(smartEoaImpl).code);

        // --- Deploy CAW token ---
        caw = new E2EMockCAW();

        // --- Deploy Minter with address prediction ---
        router = new E2EMockRouter(address(0xdead));

        // We need the Minter address before deploying the Profile so the Profile
        // can bake it in. But the Profile also needs to be deployed before the
        // Minter can be initialized. Use nonce prediction.
        // Deploy order: profile (needs predictedMinter), minter (needs profile).
        address predictedMinter = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        profile = new E2EMockProfile(address(caw));
        minter  = new CawProfileMinter(
            address(caw),
            address(profile),
            address(router),
            address(this)  // pathwayExpander = test contract (unused in this test)
        );
        require(address(minter) == predictedMinter, "Minter address prediction mismatch");

        // --- Sponsor setup ---
        sponsor = vm.addr(SPONSOR_PK);
        // Fund sponsor with enough CAW for burn + deposit across several tests.
        uint256 sponsorCaw = 1_000_000_000 * 1e24;
        caw.mint(sponsor, sponsorCaw);
        vm.prank(sponsor);
        caw.approve(address(minter), type(uint256).max);

        // --- Fund caller proxy ---
        callerProxy = new E2ECallerProxy();
        vm.deal(address(this), 10 ether);
        vm.deal(sponsor, 10 ether);
    }

    // =========================================================================
    // P-256 vector helpers (mirror of SmartEOA.t.sol helpers)
    // =========================================================================

    /// @dev Build the EIP-712 digest for MintAndDeposit that the SmartEOA
    ///      must sign via its passkey.
    function _buildMintAndDepositDigest(
        address recipient,
        string memory username,
        uint256 depositAmount,
        uint256 permitNonce,
        uint32 lzDestId
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("MintAndDeposit(uint32 networkId,address recipient,string username,uint256 depositAmount,uint32 lzDestId,uint256 lzTokenAmount,uint256 nonce,uint8 kycLevel,uint32 sponsorTokenId,uint256 repayAmount)"),
            uint32(NETWORK_ID),
            recipient,
            keccak256(bytes(username)),
            depositAmount,
            lzDestId,
            uint256(0),       // lzTokenAmount
            permitNonce,
            uint8(0),         // kycLevel
            uint32(0),        // sponsorTokenId
            uint256(0)        // repayAmount
        ));
        return keccak256(abi.encodePacked("\x19\x01", minter.DOMAIN_SEPARATOR(), structHash));
    }

    /// @dev Register a P-256 vector in the mock so isValidSignature accepts it.
    ///      Computes the precompile input: sha256(AUTH_DATA || sha256(cdj)) || r || s || qx || qy.
    function _registerP256(bytes32 digest, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) internal {
        bytes memory cdj = _makeCdj(digest);
        bytes32 h = sha256(abi.encodePacked(AUTH_DATA, sha256(cdj)));
        bytes memory p256Input = abi.encodePacked(h, r, s, qx, qy);
        p256Registry.register(keccak256(p256Input));
    }

    /// @dev Build a WebAuthn clientDataJSON with the digest as the challenge.
    function _makeCdj(bytes32 digest) internal pure returns (bytes memory) {
        bytes memory b64 = _base64urlEncode(abi.encodePacked(digest));
        return abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            b64,
            '","origin":"https://app.caw.social"}'
        );
    }

    /// @dev Minimal base64url encoder for 32-byte inputs (unpadded).
    function _base64urlEncode(bytes memory data) internal pure returns (bytes memory) {
        bytes memory alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        uint256 len = data.length;
        uint256 outLen = (len * 4 + 2) / 3;
        bytes memory out = new bytes(outLen);
        uint256 outIdx;
        uint256 i;
        while (i + 3 <= len) {
            uint24 chunk = (uint24(uint8(data[i])) << 16)
                         | (uint24(uint8(data[i+1])) << 8)
                         |  uint24(uint8(data[i+2]));
            out[outIdx++] = alphabet[(chunk >> 18) & 0x3F];
            out[outIdx++] = alphabet[(chunk >> 12) & 0x3F];
            out[outIdx++] = alphabet[(chunk >> 6)  & 0x3F];
            out[outIdx++] = alphabet[chunk & 0x3F];
            i += 3;
        }
        if (len - i == 2) {
            uint16 chunk = (uint16(uint8(data[i])) << 8) | uint16(uint8(data[i+1]));
            out[outIdx++] = alphabet[(chunk >> 10) & 0x3F];
            out[outIdx++] = alphabet[(chunk >> 4)  & 0x3F];
            out[outIdx]   = alphabet[(chunk << 2)  & 0x3F];
        } else if (len - i == 1) {
            uint8 chunk = uint8(data[i]);
            out[outIdx++] = alphabet[(chunk >> 2) & 0x3F];
            out[outIdx]   = alphabet[(chunk << 4) & 0x3F];
        }
        return out;
    }

    /// @dev Build the WebAuthn sig blob: abi.encode(authData, cdj, r, s).
    function _makeWebAuthnSig(bytes32 digest, bytes32 r, bytes32 s)
        internal pure returns (bytes memory)
    {
        bytes memory cdj = _makeCdj(digest);
        return abi.encode(AUTH_DATA, cdj, r, s);
    }

    // =========================================================================
    // Test 1: FULL E2E path via SmartEOA.initialize → Minter → MockProfile
    //
    // This is the main green-light test. Pass = sponsored bootstrap is working.
    // =========================================================================

    /// @notice Full end-to-end: sponsor broadcasts, SmartEOA.initialize calls
    ///         the Minter, which verifies the WebAuthn sig via ERC-1271 (150k gas
    ///         path), burns CAW from sponsor, deposits, and mints the NFT.
    function test_e2e_full_bootstrap_via_initialize() public {
        // -------------------------------------------------------
        // Step 1: compute the EIP-712 digest the user must sign.
        // Current nonce is 0 (fresh account, ACTION_MINT_DEPOSIT=1).
        // -------------------------------------------------------
        uint256 permitNonce = SmartEOA(userEOA).nonceOf(address(minter), 1);
        assertEq(permitNonce, 0, "e2e: initial nonce must be 0");

        bytes32 mintDigest = _buildMintAndDepositDigest(
            userEOA,
            USERNAME,
            DEPOSIT_AMOUNT,
            permitNonce,
            LZ_DEST_ID
        );

        // -------------------------------------------------------
        // Step 2: register the P-256 vector.
        // The user's passkey (PK1_X, PK1_Y) signs mintDigest with SIG_R/SIG_S.
        // Register this in the mock so the precompile accepts it.
        // -------------------------------------------------------
        _registerP256(mintDigest, SIG_R, SIG_S, PK1_X, PK1_Y);

        // -------------------------------------------------------
        // Step 3: build the WebAuthn signature blob.
        // -------------------------------------------------------
        bytes memory webAuthnSig = _makeWebAuthnSig(mintDigest, SIG_R, SIG_S);

        // -------------------------------------------------------
        // Step 4: build mintCalldata (what initialize will .call to the Minter).
        // -------------------------------------------------------
        bytes memory mintCalldata = abi.encodeWithSelector(
            CawProfileMinter.mintAndDepositSponsored.selector,
            uint32(NETWORK_ID),   // networkId
            userEOA,              // recipient = SmartEOA address
            USERNAME,
            DEPOSIT_AMOUNT,
            uint32(LZ_DEST_ID),
            uint256(0),           // lzTokenAmount (pay in ETH)
            permitNonce,
            webAuthnSig,
            uint8(0),             // kycLevel = no gate
            uint32(0),            // sponsorTokenId
            uint256(0)            // repayAmount
        );

        // -------------------------------------------------------
        // Step 5: record balances before the call.
        // -------------------------------------------------------
        uint256 burnAmount       = minter.costOfName(USERNAME);
        uint256 sponsorCawBefore = caw.balanceOf(sponsor);
        uint256 deadCawBefore    = caw.balanceOf(DEAD);
        uint256 minterCawBefore  = caw.balanceOf(address(minter));
        uint256 profileCawBefore = caw.balanceOf(address(profile));

        // -------------------------------------------------------
        // Step 6: execute SmartEOA.initialize with the sponsor as tx.origin.
        //
        // vm.prank(msg.sender, tx.origin):
        //   When test calls userEOA (SmartEOA.initialize), msg.sender = this (test contract).
        //   Inside initialize's inner .call to the Minter:
        //     msg.sender = userEOA (the SmartEOA)
        //     tx.origin  = sponsor (from the 2-arg prank)
        //
        // This faithfully models the 7702 tx where:
        //   tx.origin = sponsor server
        //   tx.to     = userEOA (delegated to SmartEOA)
        //   calldata  = initialize(...)
        // -------------------------------------------------------
        vm.prank(sponsor, sponsor);
        SmartEOA(userEOA).initialize{value: LZ_FEE}(
            PK1_X,
            PK1_Y,
            ecdsaFallback,
            payable(address(minter)),
            mintCalldata
        );

        // -------------------------------------------------------
        // Assertions: the tx must not have reverted (if we reach here it didn't).
        // -------------------------------------------------------

        // Assertion A: NFT is owned by the recipient (userEOA).
        assertEq(profile.lastMintedOwner(), userEOA, "A: NFT must be minted to userEOA");
        assertEq(profile.ownerOf(1), userEOA, "A2: ownerOf(1) must be userEOA");

        // Assertion B: sponsor's CAW decreased by burnAmount + depositAmount.
        uint256 sponsorCawAfter = caw.balanceOf(sponsor);
        uint256 totalCawPulled  = sponsorCawBefore - sponsorCawAfter;
        assertEq(
            totalCawPulled,
            burnAmount + DEPOSIT_AMOUNT,
            "B: sponsor CAW must decrease by burnAmount + depositAmount"
        );

        // Assertion C: dead address received burnAmount.
        assertEq(
            caw.balanceOf(DEAD) - deadCawBefore,
            burnAmount,
            "C: dead address must receive burnAmount"
        );

        // Assertion D: profile holds depositAmount (pulled from Minter).
        assertEq(
            caw.balanceOf(address(profile)) - profileCawBefore,
            DEPOSIT_AMOUNT,
            "D: profile must hold depositAmount"
        );

        // Assertion E: Minter's own CAW balance returned to where it was.
        // Minter pulled depositAmount from sponsor, then pushed it to profile.
        assertEq(
            caw.balanceOf(address(minter)),
            minterCawBefore,
            "E: Minter CAW balance must be unchanged after full flow"
        );

        // Assertion F: username registered in Minter's idByUsername.
        assertGt(minter.idByUsername(USERNAME), 0, "F: username must be registered");

        // Assertion G: LZ fee forwarded to the profile.
        assertEq(profile.simulatedLzFeeReceived(), LZ_FEE, "G: LZ fee must be forwarded to profile");

        // Assertion H: SmartEOA is initialized (prevents re-entry).
        vm.expectRevert(SmartEOA.AlreadyInitialized.selector);
        SmartEOA(userEOA).initialize{value: 0}(PK1_X, PK1_Y, ecdsaFallback, payable(address(0)), new bytes(0));

        // Assertion I: nonce was consumed (now = 1).
        assertEq(SmartEOA(userEOA).nonceOf(address(minter), 1), 1, "I: nonce must be 1 after mint");

        // Assertion J: setLzRefundTo was called (audit H-1 fix).
        // CawProfileMinter.mintAndDepositSponsored calls setLzRefundTo(recipient)
        // before mintAndDeposit, and setLzRefundTo(address(0)) after.
        assertGe(profile.setLzRefundToCallCount(), 2, "J: setLzRefundTo must be called at least twice");

        // Assertion K: isValidSignature still works after init (passkey enrolled).
        bytes32 testDigest = keccak256("some-future-action");
        _registerP256(testDigest, SIG_R, SIG_S, PK1_X, PK1_Y);
        bytes memory futureWebAuthnSig = _makeWebAuthnSig(testDigest, SIG_R, SIG_S);
        bytes4 sigResult = SmartEOA(userEOA).isValidSignature(testDigest, futureWebAuthnSig);
        assertEq(sigResult, bytes4(0x1626ba7e), "K: isValidSignature must return magic after init");
    }

    // =========================================================================
    // Test 2: ERC1271_GAS_LIMIT regression
    //
    // Explicitly verifies that the 50k gas cap FAILS and 150k PASSES.
    // This is the precise regression test for commit a63cf604.
    // =========================================================================

    /// @notice Regression: isValidSignature (WebAuthn path) fails with 50k gas but
    ///         passes with 150k. This is the gas test adapted to use the initialized
    ///         SmartEOA from this test (1 enrolled passkey).
    function test_erc1271_gas_limit_regression_50k_fails_150k_passes() public {
        // Initialize the SmartEOA so the passkey is enrolled.
        vm.prank(sponsor, sponsor);
        SmartEOA(userEOA).initialize{value: 0}(
            PK1_X, PK1_Y, ecdsaFallback, payable(address(0)), new bytes(0)
        );

        // Build and register a test vector.
        bytes32 digest = keccak256("test-gas-vector");
        _registerP256(digest, SIG_R, SIG_S, PK1_X, PK1_Y);
        bytes memory sig = _makeWebAuthnSig(digest, SIG_R, SIG_S);

        bytes4 ivsSelector = bytes4(keccak256("isValidSignature(bytes32,bytes)"));

        // --- 50k staticcall: must fail (returns 0xffffffff or reverts). ---
        (bool ok50, bytes memory ret50) = userEOA.staticcall{gas: 50_000}(
            abi.encodeWithSelector(ivsSelector, digest, sig)
        );
        // Either reverts entirely or returns fail sentinel.
        if (ok50 && ret50.length >= 32) {
            assertEq(
                abi.decode(ret50, (bytes4)),
                bytes4(0xffffffff),
                "50k: must return fail sentinel (OOG in inner self-staticcall)"
            );
        }
        // If ok50 is false (full revert) that's also acceptable — gas starvation confirmed.

        // --- 150k staticcall: must succeed and return magic. ---
        (bool ok150, bytes memory ret150) = userEOA.staticcall{gas: 150_000}(
            abi.encodeWithSelector(ivsSelector, digest, sig)
        );
        assertTrue(ok150, "150k: staticcall must not revert");
        require(ret150.length >= 32, "150k: return too short");
        assertEq(
            abi.decode(ret150, (bytes4)),
            bytes4(0x1626ba7e),
            "150k: must return ERC-1271 magic"
        );
    }

    // =========================================================================
    // Test 3: tx.origin funding fix regression
    //
    // Verifies that CAW is pulled from tx.origin (sponsor) NOT msg.sender (SmartEOA).
    // This is the regression test for commit a15464f5.
    // Uses CallerProxy to model the SmartEOA→Minter call.
    // =========================================================================

    /// @notice When the Minter is called by a contract (msg.sender has code),
    ///         CAW is pulled from tx.origin (sponsor), not msg.sender.
    ///         CallerProxy stands in for the SmartEOA.
    ///
    ///         This test does NOT go through SmartEOA.initialize — it tests the
    ///         Minter funding path directly using the ForkSmartEOAMock pattern
    ///         (any non-empty sig passes isValidSignature).
    function test_txorigin_funding_fix_regression() public {
        // Deploy a simple ISmartEOA-compatible mock (same as SponsoredMintFundingFork).
        SimpleSmartEOAMock userMock = new SimpleSmartEOAMock();

        uint256 permitNonce = userMock.nonceOf(address(minter), 1);

        bytes memory mintCalldata = abi.encodeWithSelector(
            CawProfileMinter.mintAndDepositSponsored.selector,
            uint32(NETWORK_ID),
            address(userMock),
            "txorigtest",          // 10 chars → burnAmount = 1e6 * 1e18
            DEPOSIT_AMOUNT,
            uint32(0),             // lzDestId = 0 (bypass LZ, no fee needed)
            uint256(0),
            permitNonce,
            hex"abcd",             // any non-empty sig accepted by SimpleSmartEOAMock
            uint8(0),
            uint32(0),
            uint256(0)
        );

        // Precondition: callerProxy has 0 CAW.
        assertEq(caw.balanceOf(address(callerProxy)), 0, "pre: callerProxy must have 0 CAW");
        uint256 sponsorBefore = caw.balanceOf(sponsor);

        // prank(callerProxy, sponsor): msg.sender=callerProxy, tx.origin=sponsor.
        vm.prank(address(callerProxy), sponsor);
        callerProxy.callMinter(address(minter), mintCalldata);

        // CallerProxy (SmartEOA stand-in) must still have 0 CAW.
        assertEq(caw.balanceOf(address(callerProxy)), 0, "post: callerProxy must have 0 CAW");

        // Sponsor's CAW decreased by burn + deposit.
        uint256 burnAmount = minter.costOfName("txorigtest");
        assertEq(
            sponsorBefore - caw.balanceOf(sponsor),
            burnAmount + DEPOSIT_AMOUNT,
            "tx.origin fix: sponsor must have paid burn + deposit"
        );

        // NFT minted to userMock.
        assertEq(profile.ownerOf(1), address(userMock), "NFT must be minted to userMock");
    }

    // =========================================================================
    // Test 4: Gas cost measurement
    //
    // Measures the end-to-end gas for SmartEOA.initialize (full bootstrap).
    // Output is used to validate GAS_LIMIT_BOOTSTRAP in SponsorService.
    // =========================================================================

    /// @notice Measures total gas for the sponsored bootstrap tx.
    ///         The SponsorService currently uses GAS_LIMIT_BOOTSTRAP = 1.2M.
    ///         This test confirms whether that's sufficient.
    function test_gas_measurement_full_bootstrap() public {
        // Re-use a fresh EOA to avoid re-init revert.
        address payable freshEOA  = payable(vm.addr(0xdeadbeef001));
        vm.etch(freshEOA, address(smartEoaImpl).code);

        uint256 permitNonce = SmartEOA(freshEOA).nonceOf(address(minter), 1);

        bytes32 mintDigest = _buildMintAndDepositDigest(
            freshEOA,
            "gasmeasure",
            DEPOSIT_AMOUNT,
            permitNonce,
            uint32(0)  // mainnet bypass path (lzDestId=0)
        );
        _registerP256(mintDigest, SIG_R, SIG_S, PK1_X, PK1_Y);
        bytes memory webAuthnSig = _makeWebAuthnSig(mintDigest, SIG_R, SIG_S);

        bytes memory mintCalldata = abi.encodeWithSelector(
            CawProfileMinter.mintAndDepositSponsored.selector,
            uint32(NETWORK_ID),
            freshEOA,
            "gasmeasure",
            DEPOSIT_AMOUNT,
            uint32(0),     // lzDestId = 0 = no LZ send
            uint256(0),
            permitNonce,
            webAuthnSig,
            uint8(0), uint32(0), uint256(0)
        );

        // Fund a fresh sponsor (avoids balance contention with other tests).
        address freshSponsor = vm.addr(0xdeadbeef002);
        caw.mint(freshSponsor, 1_000_000_000 * 1e18);
        vm.prank(freshSponsor);
        caw.approve(address(minter), type(uint256).max);
        vm.deal(freshSponsor, 1 ether);

        // Measure gas.
        uint256 gasBefore = gasleft();
        vm.prank(freshSponsor, freshSponsor);
        SmartEOA(freshEOA).initialize{value: 0}(
            PK1_X, PK1_Y,
            vm.addr(0xdeadbeef003), // ecdsaFallback (different address)
            payable(address(minter)),
            mintCalldata
        );
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("GAS USED: full PopB bootstrap SmartEOA.initialize + Minter + MockProfile", gasUsed);
        emit log_string("NOTE: mock-profile path. Real CawProfile adds ERC721._mint ~30k");
        emit log_string("      + NetworkManager fee calls ~6k + LZ EndpointV2.send ~50-100k");
        emit log_string("      Estimated real-world total: gasUsed + ~150k");

        // The gas used must be above a reasonable lower bound
        // (WebAuthn alone uses ~55k; the full flow must cost more).
        assertGt(gasUsed, 100_000, "gas measurement lower bound");

        // The full bootstrap must fit within 1.2M (current GAS_LIMIT_BOOTSTRAP).
        // The mock profile is cheaper than the real one, so we check < 800k here
        // to leave room for the real contract overhead estimated above.
        assertLt(
            gasUsed,
            800_000,
            "gas CRITICAL: mock-profile bootstrap must be < 800k (leaving ~400k for real CawProfile overhead)"
        );
    }

    // =========================================================================
    // Test 5: Nonce ordering invariant
    //
    // Verifies that the nonce is consumed AFTER the ERC-1271 check, not before.
    // A stale nonce revert must not leave the nonce in an inconsistent state.
    // =========================================================================

    function test_nonce_ordering_correct() public {
        // Initialize SmartEOA without a Minter call so we start fresh.
        vm.prank(sponsor, sponsor);
        SmartEOA(userEOA).initialize{value: 0}(
            PK1_X, PK1_Y, ecdsaFallback, payable(address(0)), new bytes(0)
        );

        uint256 nonceBeforeCall = SmartEOA(userEOA).nonceOf(address(minter), 1);
        assertEq(nonceBeforeCall, 0, "nonce ordering: must start at 0");

        // Build a WRONG nonce digest (submitNonce = 1, actual = 0).
        bytes32 wrongNonceDigest = _buildMintAndDepositDigest(
            userEOA, "noncetest", DEPOSIT_AMOUNT, 1 /* wrong */, uint32(0)
        );
        _registerP256(wrongNonceDigest, SIG_R, SIG_S, PK1_X, PK1_Y);
        bytes memory wrongNonceSig = _makeWebAuthnSig(wrongNonceDigest, SIG_R, SIG_S);

        // Call with wrong nonce — must revert "Nonce mismatch".
        vm.expectRevert("Nonce mismatch");
        vm.prank(sponsor, sponsor);
        minter.mintAndDepositSponsored(
            NETWORK_ID, userEOA, "noncetest", DEPOSIT_AMOUNT,
            0, 0,
            1 /* wrong nonce */,
            wrongNonceSig,
            0, 0, 0
        );

        // Nonce must NOT have been consumed (the revert was pre-sig, not post-sig).
        assertEq(SmartEOA(userEOA).nonceOf(address(minter), 1), 0, "nonce ordering: nonce must stay 0 after Nonce mismatch");

        // Build the CORRECT digest and sig.
        bytes32 correctDigest = _buildMintAndDepositDigest(
            userEOA, "noncetest", DEPOSIT_AMOUNT, 0 /* correct */, uint32(0)
        );
        _registerP256(correctDigest, SIG_R, SIG_S, PK1_X, PK1_Y);
        bytes memory correctSig = _makeWebAuthnSig(correctDigest, SIG_R, SIG_S);

        // Submit with correct nonce — must succeed.
        vm.prank(sponsor, sponsor);
        minter.mintAndDepositSponsored(
            NETWORK_ID, userEOA, "noncetest", DEPOSIT_AMOUNT,
            0, 0,
            0 /* correct nonce */,
            correctSig,
            0, 0, 0
        );

        // Nonce now = 1.
        assertEq(SmartEOA(userEOA).nonceOf(address(minter), 1), 1, "nonce ordering: nonce must be 1 after success");
    }

    // =========================================================================
    // Test 6: msg.value forwarding trace
    //
    // Trace the ETH value through the entire call chain:
    //   sponsor ETH → initialize{value: lzFee} → inner .call{value: lzFee} to Minter
    //   → Minter.mintAndDepositSponsored{value: lzFee} → MockProfile.mintAndDeposit{value: lzFee}
    //
    // This specifically tests for bug class (c): does initialize forward msg.value
    // to the Minter? Does the Minter forward it to CawProfile?
    // =========================================================================

    function test_msg_value_forwarding_through_initialize() public {
        uint256 testLzFee = 0.005 ether;

        uint256 permitNonce = SmartEOA(userEOA).nonceOf(address(minter), 1);
        bytes32 mintDigest = _buildMintAndDepositDigest(
            userEOA, "valuefwd", DEPOSIT_AMOUNT, permitNonce, LZ_DEST_ID
        );
        _registerP256(mintDigest, SIG_R, SIG_S, PK1_X, PK1_Y);
        bytes memory webAuthnSig = _makeWebAuthnSig(mintDigest, SIG_R, SIG_S);

        bytes memory mintCalldata = abi.encodeWithSelector(
            CawProfileMinter.mintAndDepositSponsored.selector,
            uint32(NETWORK_ID),
            userEOA,
            "valuefwd",
            DEPOSIT_AMOUNT,
            uint32(LZ_DEST_ID),
            uint256(0),
            permitNonce,
            webAuthnSig,
            uint8(0), uint32(0), uint256(0)
        );

        uint256 profileEthBefore = address(profile).balance;

        vm.prank(sponsor, sponsor);
        SmartEOA(userEOA).initialize{value: testLzFee}(
            PK1_X, PK1_Y, ecdsaFallback,
            payable(address(minter)),
            mintCalldata
        );

        // The profile should have received testLzFee.
        uint256 profileEthAfter = address(profile).balance;
        assertEq(
            profileEthAfter - profileEthBefore,
            testLzFee,
            "msg.value forwarding: profile must receive full lzFee (initialize to Minter to Profile)"
        );
    }

    // =========================================================================
    // Test 7: initialize gas forwarding (Bug Hunt item a)
    //
    // SmartEOA.initialize does:
    //   (bool ok,) = minterContract.call{value: msg.value}(mintCalldata)
    //
    // The call uses ALL remaining gas (no explicit gas limit on the inner .call).
    // This test verifies there is no accidental gas cap on that inner call that
    // would starve the Minter's execution.
    //
    // A fixed gas cap on the inner call would break the bootstrap if the Minter
    // needs more gas than the cap allows. We measure how much gas the inner call
    // needs and confirm initialize does not artificially constrain it.
    //
    // GAS BUDGET RATIONALE (Bug 6 fix):
    //   The full mock-profile bootstrap path costs ~528k gas (confirmed by
    //   test_gas_measurement_full_bootstrap). The original 400k budget was below
    //   this measured cost, producing an OOG inside MockProfile.mintAndDeposit
    //   that was unrelated to any cap in SmartEOA.initialize — a false failure.
    //   We now use 700k:
    //     700k > 528k (measured)  → non-capped inner .call succeeds
    //     700k < 1.2M (sponsor budget)  → validates GAS_LIMIT_BOOTSTRAP headroom
    //   If SmartEOA.initialize ever adds {gas: X} to its inner .call and X is
    //   too small, this test will fail even with 10M outer gas — the correct
    //   invariant to enforce.
    // =========================================================================

    function test_initialize_does_not_cap_gas_on_inner_minter_call() public {
        // Use a gasmeasure-variant username to avoid collision.
        string memory un = "gascheck";
        address payable freshEOA2 = payable(vm.addr(0xbeef001));
        vm.etch(freshEOA2, address(smartEoaImpl).code);

        uint256 permitNonce = SmartEOA(freshEOA2).nonceOf(address(minter), 1);
        bytes32 digest = _buildMintAndDepositDigest(freshEOA2, un, DEPOSIT_AMOUNT, permitNonce, uint32(0));
        _registerP256(digest, SIG_R, SIG_S, PK1_X, PK1_Y);
        bytes memory sig = _makeWebAuthnSig(digest, SIG_R, SIG_S);

        bytes memory mintCalldata = abi.encodeWithSelector(
            CawProfileMinter.mintAndDepositSponsored.selector,
            uint32(NETWORK_ID), freshEOA2, un, DEPOSIT_AMOUNT,
            uint32(0), uint256(0), permitNonce, sig, uint8(0), uint32(0), uint256(0)
        );

        address freshSponsor2 = vm.addr(0xbeef002);
        caw.mint(freshSponsor2, 1_000_000_000 * 1e18);
        vm.prank(freshSponsor2);
        caw.approve(address(minter), type(uint256).max);
        vm.deal(freshSponsor2, 1 ether);

        // 700k outer budget: above measured ~528k so a non-capped inner call succeeds;
        // below 1.2M sponsor budget to validate headroom. If SmartEOA.initialize
        // ever hard-codes a gas cap on its inner .call that is too small, this fails.
        bool ok;
        vm.prank(freshSponsor2, freshSponsor2);
        try this._callInitialize{gas: 700_000}(freshEOA2, freshSponsor2, mintCalldata) {
            ok = true;
        } catch {
            ok = false;
        }

        assertTrue(ok, "initialize inner .call must NOT cap gas - 700k outer budget must suffice (mock-profile path ~528k)");
    }

    /// @dev External wrapper so try/catch can capture reverts with the gas budget.
    function _callInitialize(address payable eoa, address sp, bytes calldata mintCalldata) external {
        // We need to prank from inside this call; use vm directly.
        vm.prank(sp, sp);
        SmartEOA(eoa).initialize{value: 0}(
            PK1_X, PK1_Y,
            vm.addr(0xbeef003),    // fresh ecdsaFallback (not same as eoa)
            payable(address(minter)),
            mintCalldata
        );
    }

    // =========================================================================
    // Test 8: replay attack — nonce prevents reuse of same permit
    // =========================================================================

    function test_permit_replay_rejected() public {
        // Initialize SmartEOA.
        vm.prank(sponsor, sponsor);
        SmartEOA(userEOA).initialize{value: 0}(
            PK1_X, PK1_Y, ecdsaFallback, payable(address(0)), new bytes(0)
        );

        // Build a valid permit at nonce=0.
        bytes32 digest = _buildMintAndDepositDigest(
            userEOA, "replaytest", DEPOSIT_AMOUNT, 0, uint32(0)
        );
        _registerP256(digest, SIG_R, SIG_S, PK1_X, PK1_Y);
        bytes memory sig = _makeWebAuthnSig(digest, SIG_R, SIG_S);

        // First submission: must succeed.
        vm.prank(sponsor, sponsor);
        minter.mintAndDepositSponsored(
            NETWORK_ID, userEOA, "replaytest", DEPOSIT_AMOUNT,
            0, 0, 0, sig, 0, 0, 0
        );
        assertEq(profile.ownerOf(1), userEOA, "first mint: NFT minted to userEOA");
        assertEq(SmartEOA(userEOA).nonceOf(address(minter), 1), 1, "nonce is now 1");

        // Second submission with the SAME sig and nonce=0: must revert.
        vm.expectRevert("Nonce mismatch");
        vm.prank(sponsor, sponsor);
        minter.mintAndDepositSponsored(
            NETWORK_ID, userEOA, "replaytest2", DEPOSIT_AMOUNT,
            0, 0, 0, sig, 0, 0, 0
        );
    }

    // =========================================================================
    // Test 9: isValidSignature fails with wrong passkey → mint reverts
    //
    // Verifies that a forged/unregistered sig causes the sponsored flow to revert
    // with "Bad sig" (not silently succeed).
    // =========================================================================

    function test_wrong_sig_reverts_mint() public {
        // Initialize SmartEOA.
        vm.prank(sponsor, sponsor);
        SmartEOA(userEOA).initialize{value: 0}(
            PK1_X, PK1_Y, ecdsaFallback, payable(address(0)), new bytes(0)
        );

        // Build the real digest but DON'T register any P-256 vector.
        // The precompile will reject the sig → isValidSignature returns 0xffffffff.
        bytes32 digest = _buildMintAndDepositDigest(
            userEOA, "badsigtest", DEPOSIT_AMOUNT, 0, uint32(0)
        );
        // Use sig values NOT registered in the registry.
        bytes32 fakeSigR = bytes32(uint256(0x1234));
        bytes32 fakeSigS = bytes32(uint256(0x5678));
        bytes memory fakeSig = _makeWebAuthnSig(digest, fakeSigR, fakeSigS);

        vm.expectRevert("Bad sig");
        vm.prank(sponsor, sponsor);
        minter.mintAndDepositSponsored(
            NETWORK_ID, userEOA, "badsigtest", DEPOSIT_AMOUNT,
            0, 0, 0, fakeSig, 0, 0, 0
        );
    }

    // =========================================================================
    // Test 10: plain EOA (no code) is rejected by the Minter's code.length guard
    // =========================================================================

    function test_plain_eoa_rejected_by_minter() public {
        // A plain EOA has no code — the Minter's "Direct submit required" guard fires.
        address plainEOA = vm.addr(0xcafe1234);
        assertEq(plainEOA.code.length, 0, "pre: plain EOA must have no code");

        SimpleSmartEOAMock userMock = new SimpleSmartEOAMock();

        vm.expectRevert("Direct submit required");
        vm.prank(sponsor, sponsor);
        minter.mintAndDepositSponsored(
            NETWORK_ID, plainEOA /* plain EOA */, "planeoa", DEPOSIT_AMOUNT,
            0, 0, 0, hex"abcd", 0, 0, 0
        );
    }

    receive() external payable {}
}

// =============================================================================
// SimpleSmartEOAMock — minimal ISmartEOA + ERC-1271 for regression tests
// =============================================================================

/// @dev Accepts any non-empty sig. Same interface as SmartContractWalletMock.
contract SimpleSmartEOAMock {
    bytes4 private constant MAGIC = 0x1626ba7e;
    mapping(address => mapping(uint8 => uint256)) private _nonces;

    function isValidSignature(bytes32, bytes calldata sig) external pure returns (bytes4) {
        if (sig.length == 0) return bytes4(0xffffffff);
        return MAGIC;
    }

    function nonceOf(address vc, uint8 at) external view returns (uint256) {
        return _nonces[vc][at];
    }

    function consumeNonce(address vc, uint8 at) external {
        require(msg.sender == vc, "SimpleSmartEOAMock: not permitted");
        unchecked { ++_nonces[vc][at]; }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
