// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "forge-std/Test.sol";
import "../contracts/SessionMessageParser.sol";

/// @title SessionMessageParserTest
/// @notice Unit tests for the personal_sign message parser, focused on the tip
///         line. The FE writes the tip with a magnitude suffix ("1M CAW") for
///         readability; the parser must accept that (mirroring the spend-limit
///         line) and must still reject any trailing text after "CAW" (e.g. a USD
///         note) and the literal opt-out "0 CAW".
contract SessionMessageParserTest is Test {
    using SessionMessageParser for bytes;

    uint256 constant CHAIN_ID = 84532;
    address constant LEDGER = address(uint160(uint256(keccak256("test ledger"))));

    function _addr() internal pure returns (string memory) { return vm.toString(LEDGER); } // lowercase 0x...

    function _deployment() internal pure returns (string memory) { return string.concat("84532 ", _addr()); }

    function _upper(string memory a) internal pure returns (string memory) {
        bytes memory b = bytes(a);
        for (uint256 i = 2; i < b.length; i++) {
            if (b[i] >= 0x61 && b[i] <= 0x66) b[i] = bytes1(uint8(b[i]) - 32);
        }
        return string(b);
    }

    // Build a full 16-line message with the given tip line, valid everywhere else.
    function _msg(string memory tipLine) internal pure returns (bytes memory) {
        return _msgFull(tipLine, _deployment());
    }

    // The same message with the given last line ("<chain id> <ledger address>").
    function _msgFull(string memory tipLine, string memory deploymentLine) internal pure returns (bytes memory) {
        return bytes(string.concat(
            "Enable Quick Sign\n",
            "------------------\n",
            "Spend limit:\n",
            "286M CAW\n",
            "\n",
            "Tip per action:\n",
            tipLine, "\n",
            "\n",
            "Expires:\n",
            "14 December 2026 16:32:48 UTC\n",
            "\n",
            "CAW Key:\n",
            "0x358c96d6Ce583d3cac6C847a46A36D2BA6FAED58\n",
            "\n",
            "Chain and contract:\n",
            deploymentLine
        ));
    }

    function _parse(bytes memory m)
        internal
        pure
        returns (uint256 spendLimit, uint64 tipRate, uint64 expiry, address key)
    {
        return SessionMessageParser.parseSessionMessage(m, CHAIN_ID, LEDGER);
    }

    // ── Tip line accepts the M/K/B magnitude suffix (the readable form) ──────

    function test_tip_suffix_M() public pure {
        (, uint64 tip,,) = _parse(_msg("1M CAW"));
        assertEq(tip, 1_000_000);
    }

    function test_tip_suffix_K() public pure {
        (, uint64 tip,,) = _parse(_msg("500K CAW"));
        assertEq(tip, 500_000);
    }

    function test_tip_suffix_B() public pure {
        (, uint64 tip,,) = _parse(_msg("2B CAW"));
        assertEq(tip, 2_000_000_000);
    }

    // ── Plain integer still works (legacy form) ─────────────────────────────

    function test_tip_plain_integer() public pure {
        (, uint64 tip,,) = _parse(_msg("1000 CAW"));
        assertEq(tip, 1000);
    }

    // ── Opt-out: "0 CAW" parses to 0 (the FE no longer writes "none") ────────

    function test_tip_zero_optout() public pure {
        (, uint64 tip,,) = _parse(_msg("0 CAW"));
        assertEq(tip, 0);
    }

    // ── Spend limit still parses alongside the new tip handling ─────────────

    function test_spend_limit_unchanged() public pure {
        (uint256 spend,,,) = _parse(_msg("1M CAW"));
        assertEq(spend, 286_000_000);
    }

    // ── A trailing " (...)" note is accepted and ignored (value unchanged) ───

    function test_tip_accepts_usd_note() public pure {
        (, uint64 tip,,) = _parse(_msg("1M CAW (~$0.0010)"));
        assertEq(tip, 1_000_000);
    }

    function test_tip_accepts_usd_note_plain() public pure {
        (, uint64 tip,,) = _parse(_msg("1000 CAW (~$0.000001)"));
        assertEq(tip, 1000);
    }

    // ── Rejections: BARE trailing text (not wrapped in parens) must BadParse ──

    function test_tip_rejects_trailing_text_plain() public {
        vm.expectRevert(SessionMessageParser.BadParse.selector);
        _parse(_msg("1000 CAW extra"));
    }

    function test_tip_rejects_unclosed_paren() public {
        vm.expectRevert(SessionMessageParser.BadParse.selector);
        _parse(_msg("1M CAW (~$0.0010"));
    }

    function test_tip_rejects_none_literal() public {
        vm.expectRevert(SessionMessageParser.BadParse.selector);
        _parse(_msg("none"));
    }

    function test_tip_rejects_missing_caw() public {
        vm.expectRevert(SessionMessageParser.BadParse.selector);
        _parse(_msg("1M"));
    }

    // ── The "Chain and contract:" line binds the message to one deployment ───

    function test_deployment_matching_line_parses() public pure {
        (uint256 spend, uint64 tip,, address key) = _parse(_msg("1000 CAW"));
        assertEq(spend, 286_000_000);
        assertEq(tip, 1000);
        assertEq(key, 0x358c96d6Ce583d3cac6C847a46A36D2BA6FAED58);
    }

    function test_deployment_address_case_does_not_matter() public pure {
        _parse(_msgFull("1000 CAW", string.concat("84532 ", _addr())));
        _parse(_msgFull("1000 CAW", string.concat("84532 ", _upper(_addr()))));
    }

    function test_deployment_rejects_another_chain() public {
        vm.expectRevert(SessionMessageParser.WrongDeployment.selector);
        _parse(_msgFull("1000 CAW", string.concat("421614 ", _addr())));
    }

    function test_deployment_rejects_another_ledger() public {
        vm.expectRevert(SessionMessageParser.WrongDeployment.selector);
        _parse(_msgFull("1000 CAW", string.concat("84532 ", vm.toString(address(uint160(LEDGER) + 1)))));
    }

    /// @dev The 13-line message from before the binding is no longer accepted.
    function test_legacy_13_line_message_is_rejected() public {
        bytes memory legacy = bytes(string.concat(
            "Enable Quick Sign\n------------------\nSpend limit:\n286M CAW\n\nTip per action:\n1000 CAW\n\n",
            "Expires:\n14 December 2026 16:32:48 UTC\n\nCAW Key:\n0x358c96d6Ce583d3cac6C847a46A36D2BA6FAED58"
        ));
        vm.expectRevert(SessionMessageParser.BadParse.selector);
        _parse(legacy);
    }

    function test_deployment_rejects_malformed_lines() public {
        string memory a = _addr();
        string[8] memory bad;
        bad[0] = "";                                              // empty
        bad[1] = a;                                               // no chain id
        bad[2] = "84532";                                         // no address
        bad[3] = string.concat("84532  ", a);                     // two spaces
        bad[4] = string.concat("84532 00", _tail(a));             // "00", not "0x"
        bad[5] = string.concat("84532 ", _head(a, 40));           // short address
        bad[6] = string.concat("84532 ", a, " extra");            // trailing text
        bad[7] = string.concat("845320000000000000000 ", a);      // 21 digits
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(SessionMessageParser.BadParse.selector);
            this.parseExternal(_msgFull("1000 CAW", bad[i]));
        }
    }

    function _head(string memory a, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(a); bytes memory r = new bytes(n);
        for (uint256 i = 0; i < n; i++) r[i] = b[i];
        return string(r);
    }

    function _tail(string memory a) internal pure returns (string memory) {
        bytes memory b = bytes(a); bytes memory r = new bytes(b.length - 2);
        for (uint256 i = 2; i < b.length; i++) r[i - 2] = b[i];
        return string(r);
    }

    /// @dev vm.expectRevert needs an external call to the test contract to catch a library revert in a loop.
    function parseExternal(bytes memory m) external pure {
        SessionMessageParser.parseSessionMessage(m, CHAIN_ID, LEDGER);
    }
}
