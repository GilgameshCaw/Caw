// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// registerSessionPersonal signs an EIP-191 digest over the message only. The message used to name
// no chain and no contract, so the same (message, signature) registered the same key on every
// deployment of CawProfileLedger. The last line now names the chain id and the ledger, and the
// ledger requires it to be its own. consumedSessionMessage is per ledger, so it only ever stopped a
// second use on the SAME ledger.

import "forge-std/Test.sol";
import "../contracts/CawProfileLedger.sol";
import "../contracts/SessionMessageParser.sol";
import "../contracts/MockLayerZeroEndpoint.sol";

contract SessionMessageDeploymentBindingTest is Test {
    uint256 constant OWNER_PK   = 0xA11CE1;
    uint256 constant SESSION_PK = 0x5E55101;

    bytes32 constant DELEGATION_TYPEHASH = keccak256(
        "SessionDelegation(address sessionKey,uint64 expiry,uint8 scopeBitmap,uint256 spendLimit,uint64 perActionTipRate,uint256 nonce)"
    );

    MockLayerZeroEndpoint lzEndpoint;
    CawProfileLedger ledgerA;   // chain id 84532
    CawProfileLedger ledgerB;   // another deployment, on another chain id

    address owner;
    address sessionKey;

    function _deployLedger() internal returns (CawProfileLedger l) {
        l = new CawProfileLedger(
            30101, address(lzEndpoint), address(0),
            address(this),      // _cawProfile
            address(0xCAFE),    // _cawActions (unused here)
            address(0xbeef),    // _erc1271Sibling (dummy)
            true,               // bypassLZ
            address(this)       // _pathwayExpander
        );
    }

    function setUp() public {
        owner = vm.addr(OWNER_PK);
        sessionKey = vm.addr(SESSION_PK);
        lzEndpoint = new MockLayerZeroEndpoint(40245);
        vm.chainId(84532);
        ledgerA = _deployLedger();
        vm.chainId(421614);
        ledgerB = _deployLedger();
        vm.chainId(84532); // tests start on chain A
    }

    /// @dev The 16-line message for the given chain id and ledger.
    function _message(uint256 chainId, address ledger) internal view returns (bytes memory) {
        return abi.encodePacked(
            "Enable Quick Sign\n------------------\nSpend limit:\n5M CAW\n\nTip per action:\n1000 CAW\n\n",
            "Expires:\n1 January 2030 00:00:00 UTC\n\nCAW Key:\n",
            vm.toString(sessionKey),
            "\n\nChain and contract:\n",
            vm.toString(chainId), " ", vm.toString(ledger)
        );
    }

    function _signPersonal(bytes memory message) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n", _u2s(message.length), message
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _u2s(uint256 x) internal pure returns (string memory) { return vm.toString(x); }

    function _expiry(CawProfileLedger l) internal view returns (uint64 e) {
        (e, , , , , ) = l.sessions(owner, sessionKey);
    }

    // ───────────── the signature is bound to one deployment ─────────────

    function test_signatureForA_registersOnA_andIsRefusedOnB() public {
        bytes memory m = _message(84532, address(ledgerA));
        bytes memory sig = _signPersonal(m);

        ledgerA.registerSessionPersonal(owner, m, sig);
        assertGt(_expiry(ledgerA), 0, "registered on A");

        // Anyone who has seen the message and signature submits it to ledger B (another chain id).
        vm.chainId(421614);
        vm.expectRevert(SessionMessageParser.WrongDeployment.selector);
        ledgerB.registerSessionPersonal(owner, m, sig);
        assertEq(_expiry(ledgerB), 0, "nothing registered on B");
    }

    /// @dev Same chain id, another deployment: the ledger address alone is enough to refuse it.
    function test_sameChainOtherLedger_isRefused() public {
        vm.chainId(84532);
        CawProfileLedger ledgerC = _deployLedger();
        bytes memory m = _message(84532, address(ledgerA));
        bytes memory sig = _signPersonal(m);
        vm.expectRevert(SessionMessageParser.WrongDeployment.selector);
        ledgerC.registerSessionPersonal(owner, m, sig);
    }

    /// @dev Same address on another chain (the same deployer and nonce): the chain id alone is enough.
    function test_sameAddressOtherChain_isRefused() public {
        bytes memory m = _message(421614, address(ledgerA)); // names ledger A's address, but chain 421614
        bytes memory sig = _signPersonal(m);
        vm.chainId(84532);
        vm.expectRevert(SessionMessageParser.WrongDeployment.selector);
        ledgerA.registerSessionPersonal(owner, m, sig);
    }

    /// @dev Signing for B works on B: the binding does not stop a deployment from being used.
    function test_signatureForB_registersOnB() public {
        vm.chainId(421614);
        bytes memory m = _message(421614, address(ledgerB));
        bytes memory sig = _signPersonal(m);
        ledgerB.registerSessionPersonal(owner, m, sig);
        assertGt(_expiry(ledgerB), 0);
        assertEq(_expiry(ledgerA), 0);
    }

    function test_versionGetter() public view {
        assertEq(ledgerA.SESSION_MESSAGE_VERSION(), 2);
    }

    // ───────────── controls ─────────────

    /// @dev consumedSessionMessage still works within one ledger.
    function test_control_sameLedger_replayReverts() public {
        bytes memory m = _message(84532, address(ledgerA));
        bytes memory sig = _signPersonal(m);
        ledgerA.registerSessionPersonal(owner, m, sig);
        vm.expectRevert(CawProfileLedger.Replayed.selector);
        ledgerA.registerSessionPersonal(owner, m, sig);
    }

    /// @dev The EIP-712 path was already bound to its ledger.
    function test_control_eip712_signatureOnlyValidOnItsOwnLedger() public {
        uint64 expiry = uint64(1_893_456_000);
        uint256 nonce = 0;
        bytes32 structHash = keccak256(abi.encode(
            DELEGATION_TYPEHASH, sessionKey, expiry, uint8(0xBF), uint256(5_000_000), uint64(1000), nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ledgerA.eip712DomainHash(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        ledgerA.registerSession(owner, sessionKey, expiry, 0xBF, 5_000_000, 1000, nonce, sig);
        assertGt(_expiry(ledgerA), 0);

        vm.expectRevert(CawProfileLedger.BadSig.selector);
        ledgerB.registerSession(owner, sessionKey, expiry, 0xBF, 5_000_000, 1000, nonce, sig);
    }
}
