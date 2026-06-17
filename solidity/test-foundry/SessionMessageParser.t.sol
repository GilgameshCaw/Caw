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

    // Build a full 13-line message with the given tip line, valid everywhere else.
    function _msg(string memory tipLine) internal pure returns (bytes memory) {
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
            "0x358c96d6Ce583d3cac6C847a46A36D2BA6FAED58"
        ));
    }

    function _parse(bytes memory m)
        internal
        pure
        returns (uint256 spendLimit, uint64 tipRate, uint64 expiry, address key)
    {
        return SessionMessageParser.parseSessionMessage(m);
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
}
