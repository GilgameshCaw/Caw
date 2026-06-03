// contracts/SessionMessageParser.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title SessionMessageParser
/// @notice External library for parsing the human-readable personal_sign session
///         message used by `registerSessionPersonal` in CawProfileLedger.
///         Extracted to keep CawProfileLedger under the EIP-170 24,576-byte
///         deployed-bytecode limit. `parseSessionMessage` and `uint2str` are
///         `external` so they live in the library's own deployed bytecode —
///         the consuming contract only carries a small delegatecall stub
///         (~50 bytes per linked function).
///
///         Message format (13 newline-separated lines):
///           Enable Quick Sign
///           ------------------
///           Spend limit:
///           5M CAW
///           (blank)
///           Tip per action:
///           1000 CAW
///           (blank)
///           Expires:
///           25 April 2026 00:00:00 UTC
///           (blank)
///           CAW Key:
///           0x742d...3e
library SessionMessageParser {

  error BadParse();
  error BadDate();

  /// @notice Parse the multi-line session message.
  /// @return spendLimit      Parsed CAW spend limit (whole tokens with M/K/B suffix).
  /// @return perActionTipRate Parsed tip-rate in whole CAW tokens.
  /// @return expiry          Unix timestamp parsed from the human-readable date line.
  /// @return sessionKey      Session key address parsed from the hex line.
  function parseSessionMessage(bytes memory msg_)
    external pure returns (uint256 spendLimit, uint64 perActionTipRate, uint64 expiry, address sessionKey)
  {
    bytes[] memory lines = _splitLines(msg_);
    if (lines.length != 13) revert BadParse();

    // Line 0: "Enable Quick Sign"
    if (keccak256(lines[0]) != keccak256("Enable Quick Sign")) revert BadParse();
    // Line 1: "------------------" (decorative, skip)
    // Line 2: "Spend limit:" (label, skip)

    // Line 3: "5M CAW"
    spendLimit = _parseSpendLimitValue(lines[3]);

    // Line 4: "" (blank, skip)
    // Line 5: "Tip per action:" (label, skip)

    // Line 6: "1000 CAW"
    perActionTipRate = _parseTipRateValue(lines[6]);

    // Line 7: "" (blank, skip)
    // Line 8: "Expires:" (label, skip)

    // Line 9: "25 April 2026 00:00:00 UTC"
    expiry = _parseExpiryValue(lines[9]);

    // Line 10: "" (blank, skip)
    // Line 11: "CAW Key:" (label, skip)

    // Line 12: "0x..."
    sessionKey = _parseAddressLine(lines[12]);
  }

  /// @notice Convert a uint256 to its decimal ASCII bytes representation.
  ///         Used by `registerSessionPersonal` to build the EIP-191 prefix.
  function uint2str(uint256 value) external pure returns (bytes memory) {
    if (value == 0) return "0";
    uint256 temp = value;
    uint256 digits;
    while (temp != 0) { digits++; temp /= 10; }
    bytes memory buffer = new bytes(digits);
    while (value != 0) {
      digits--;
      buffer[digits] = bytes1(uint8(48 + value % 10));
      value /= 10;
    }
    return buffer;
  }

  // -------------------------------------------------------------------------
  // Internal helpers (only called within parseSessionMessage chain)
  // -------------------------------------------------------------------------

  /// @dev Parse a tip-rate line like "1000 CAW" or "0 CAW" → uint64 whole tokens.
  function _parseTipRateValue(bytes memory line) internal pure returns (uint64) {
    if (line.length < 5) revert BadParse();
    uint256 number = 0;
    uint256 i = 0;
    while (i < line.length && line[i] >= 0x30 && line[i] <= 0x39) {
      number = number * 10 + (uint8(line[i]) - 0x30);
      i++;
    }
    if (number > type(uint64).max) revert BadParse();
    // Allow 0 (opt-out) explicitly.
    if (!(i < line.length && line[i] == 0x20)) revert BadParse();
    if (!(
      line.length - i - 1 == 3 &&
      line[i+1] == 'C' && line[i+2] == 'A' && line[i+3] == 'W'
    )) revert BadParse();
    return uint64(number);
  }

  function _splitLines(bytes memory data) internal pure returns (bytes[] memory) {
    // Count newlines
    uint256 count = 1;
    for (uint256 i = 0; i < data.length; i++) {
      if (data[i] == 0x0A) count++;
    }
    bytes[] memory lines = new bytes[](count);
    uint256 lineIdx = 0;
    uint256 start = 0;
    for (uint256 i = 0; i < data.length; i++) {
      if (data[i] == 0x0A) {
        lines[lineIdx] = _slice(data, start, i);
        lineIdx++;
        start = i + 1;
      }
    }
    lines[lineIdx] = _slice(data, start, data.length);
    return lines;
  }

  function _slice(bytes memory data, uint256 from, uint256 to) internal pure returns (bytes memory) {
    bytes memory result = new bytes(to - from);
    for (uint256 i = from; i < to; i++) result[i - from] = data[i];
    return result;
  }

  /// @dev Parse "5M CAW" → 5000000
  function _parseSpendLimitValue(bytes memory line) internal pure returns (uint256) {
    if (line.length < 5) revert BadParse();
    uint256 number = 0;
    uint256 i = 0;
    while (i < line.length && line[i] >= 0x30 && line[i] <= 0x39) {
      number = number * 10 + (uint8(line[i]) - 0x30);
      i++;
    }
    if (number == 0) revert BadParse();
    if (i >= line.length) revert BadParse();
    if (line[i] == 'M') return number * 1_000_000;
    if (line[i] == 'K') return number * 1_000;
    if (line[i] == 'B') return number * 1_000_000_000;
    revert BadParse();
  }

  /// @dev Parse "25 April 2026 00:00:00 UTC" → unix timestamp
  function _parseExpiryValue(bytes memory line) internal pure returns (uint64) {
    if (line.length <= 20) revert BadDate();
    uint256 i = 0;

    // Day (1-2 digits)
    uint256 day = 0;
    while (i < line.length && line[i] >= 0x30 && line[i] <= 0x39) {
      day = day * 10 + (uint8(line[i]) - 0x30);
      i++;
    }
    if (day < 1 || day > 31) revert BadDate();
    i++; // skip space

    // Month name
    uint256 monthStart = i;
    while (i < line.length && line[i] != 0x20) i++;
    uint256 month = _parseMonth(_slice(line, monthStart, i));
    i++; // skip space

    // Year (4 digits)
    uint256 year = 0;
    for (uint256 j = 0; j < 4; j++) {
      year = year * 10 + (uint8(line[i + j]) - 0x30);
    }
    i += 4;
    i++; // skip space

    // HH:MM:SS
    uint256 hour   = (uint8(line[i]) - 0x30) * 10 + (uint8(line[i+1]) - 0x30);
    uint256 minute = (uint8(line[i+3]) - 0x30) * 10 + (uint8(line[i+4]) - 0x30);
    uint256 second = (uint8(line[i+6]) - 0x30) * 10 + (uint8(line[i+7]) - 0x30);

    // Validate ranges so silent rollover can't extend the user's intended
    // expiry. Without these: "Feb 31" parses fine and rolls into March, or
    // "30:99:99" parses and rolls into the next day + extra hours/minutes.
    // Audit fix 2026-05-08 (L2 M-4).
    if (hour >= 24) revert BadDate();
    if (minute >= 60) revert BadDate();
    if (second >= 60) revert BadDate();
    // Month-aware day bound. 28-day Feb default; +1 for leap years.
    uint8[12] memory daysInMonth = [31,28,31,30,31,30,31,31,30,31,30,31];
    if (_isLeapYear(year)) daysInMonth[1] = 29;
    if (day > uint256(daysInMonth[month - 1])) revert BadDate();
    // Sanity cap on year so the for-loop in _toUnixTimestamp can't be
    // weaponized into a 30M-gas DoS (~10K iterations max from 1970).
    if (year > 2200) revert BadDate();

    return uint64(_toUnixTimestamp(year, month, day, hour, minute, second));
  }

  function _parseMonth(bytes memory m) internal pure returns (uint256) {
    bytes32 h = keccak256(m);
    if (h == keccak256("January"))   return 1;
    if (h == keccak256("February"))  return 2;
    if (h == keccak256("March"))     return 3;
    if (h == keccak256("April"))     return 4;
    if (h == keccak256("May"))       return 5;
    if (h == keccak256("June"))      return 6;
    if (h == keccak256("July"))      return 7;
    if (h == keccak256("August"))    return 8;
    if (h == keccak256("September")) return 9;
    if (h == keccak256("October"))   return 10;
    if (h == keccak256("November"))  return 11;
    if (h == keccak256("December"))  return 12;
    revert BadParse();
  }

  /// @dev Convert date components to unix timestamp (UTC). Only valid for years >= 1970.
  function _toUnixTimestamp(uint256 year, uint256 month, uint256 day, uint256 hour, uint256 minute, uint256 second) internal pure returns (uint256) {
    if (year < 1970) revert BadDate();
    uint256 timestamp = 0;
    // Years
    for (uint256 y = 1970; y < year; y++) {
      timestamp += _isLeapYear(y) ? 366 days : 365 days;
    }
    // Months
    uint8[12] memory daysInMonth = [31,28,31,30,31,30,31,31,30,31,30,31];
    if (_isLeapYear(year)) daysInMonth[1] = 29;
    for (uint256 m = 1; m < month; m++) {
      timestamp += uint256(daysInMonth[m - 1]) * 1 days;
    }
    // Days, hours, minutes, seconds
    timestamp += (day - 1) * 1 days + hour * 1 hours + minute * 1 minutes + second;
    return timestamp;
  }

  function _isLeapYear(uint256 year) internal pure returns (bool) {
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
  }

  /// @dev Parse "0x742d...3e" → address
  function _parseAddressLine(bytes memory line) internal pure returns (address) {
    // "0x" + 40 hex chars = 42 bytes
    if (line.length != 42) revert BadDate();
    bytes memory hexStr = _slice(line, 2, 42);
    return address(uint160(_hexToUint(hexStr)));
  }

  function _hexToUint(bytes memory hexStr) internal pure returns (uint256 result) {
    for (uint256 i = 0; i < hexStr.length; i++) {
      uint8 c = uint8(hexStr[i]);
      uint8 val;
      if (c >= 0x30 && c <= 0x39) val = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) val = c - 0x61 + 10;
      else if (c >= 0x41 && c <= 0x46) val = c - 0x41 + 10;
      else revert BadParse();
      result = result * 16 + val;
    }
  }
}
