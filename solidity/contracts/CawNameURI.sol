// contracts/CawNameURI.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

/// @notice Interface for raw glyph-path data contracts.
interface ICawFontData {
  function DATA() external view returns (bytes memory);
}

/// @title CawNameURI
/// @notice On-chain SVG renderer for CAW username NFTs. Builds each username
///         from 54 vectorized glyph paths (36 base chars + 18 ligatures), with
///         a dynamic-programming tokenizer for ligature selection and a
///         width-fitting size algorithm that keeps the text comfortably inside
///         the 270×270 viewport. The glyph paths are stored in two companion
///         data contracts (CawFontDataA and CawFontDataB) because they exceed
///         the 24,576-byte per-contract bytecode limit.
contract CawNameURI is Ownable {
  string public description = "CAW NAMEs are username NFTs the CAW social network on the ethereum chain.";

  /// @notice Address of the data contract holding glyph paths for slots 0-38.
  address public immutable fontDataA;
  /// @notice Address of the data contract holding glyph paths for slots 39-53.
  address public immutable fontDataB;

  // ============================================
  // CONSTANTS (lookup tables)
  // ============================================

  /// @dev Sentinel returned by _charToSlot when the input char is not a-z / 0-9.
  uint8 private constant INVALID_SLOT = 0xFF;

  /// @dev First valid ASCII char in the lookup range.
  uint8 private constant LUT_BASE = 0x30; // '0'
  /// @dev Last valid ASCII char in the lookup range ('z' = 0x7A).
  uint8 private constant LUT_LAST = 0x7A;

  /// @dev Split-point slot for data-contract routing. Slots <= this live in
  ///      fontDataA; slots > this live in fontDataB.
  uint8 private constant DATA_A_LAST_SLOT = 38;
  /// @dev Byte length of data in fontDataA (subtracted from glyph offsets to
  ///      locate them within fontDataB).
  uint256 private constant DATA_A_LENGTH = 15154;

  /// @dev ASCII lookup: (char - LUT_BASE) → slot index, 0xFF for invalid.
  ///      Covers chars '0' (0x30) through 'z' (0x7A), 75 entries.
  bytes private constant CHAR_LUT = hex"00010203040506070809ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20212223";

  /// @dev Ligature table. 18 entries, 4 bytes each: [c1, c2, c3, result].
  ///      c3 == 0xFF for bigrams; trigrams use all three. Trigrams come first
  ///      so the tokenizer can check them in order.
  bytes private constant LIG_TABLE = hex"0f0f12270f0f15280f12ff240f15ff250f0fff260f13ff290f1bff2a0f1eff2b0f22ff2c1515ff2d1d11ff2e1d12ff2f1d1bff301d1dff311d22ff321d0eff331d18ff341010ff35";
  uint8 private constant LIG_COUNT = 18;

  /// @dev Per-slot glyph advance width (uint16 each, 54 entries × 2 = 108 bytes).
  ///      Units are font UPEM (2048 per em).
  bytes private constant ADVANCES = hex"04200372047803b004f203dd0489041204220489041b03e10310041b02f9027f03bb0442025e022103b3022206500484036e03fb03e1035502d802d5047c039b050504020456034b044904be04d906a306fa044a059806c5065c0454069704760569050f066b058005fb074c";

  /// @dev Per-slot offset into the concatenated glyph-path blob (uint16 × 54).
  bytes private constant OFFSETS = hex"0000012801a1028b041304a10594071e079109710afd0cb10e260f21112c126713bc15b2176f19021a831c411d71206f2265233b24c426352768286d294d2b762c6b2e052fb8315633bf363738b43b323ed0423f44c546b5499c4c614ecb5177534454b5566058b15adf5c95";

  /// @dev Per-slot length of the glyph path (uint16 × 54).
  bytes private constant LENGTHS = hex"0128007900ea0188008e00f3018a007301e0018c01b4017500fb020b013b015501f601bd0193018101be013002fe01f600d6018901710133010500e0022900f5019a01b3019e02690278027d027e039e036f028601f002e702c5026a02ac01cd017101ab0251022e01b6066f";

  /// @dev Max fontSize per name length when clamping the width-fit algorithm.
  ///      Indexed by (length - 1). Entries beyond len 17 just hold 22 (the
  ///      minimum fontSize), since any longer name is already at the floor.
  uint8[17] private MAX_BY_LEN_TABLE = [
    176, 133, 99, 77, 64, 55, 49, 44, 40, 36, 33, 31, 29, 27, 25, 23, 22
  ];

  /// @dev Bounded lookup into MAX_BY_LEN_TABLE. Accepts arbitrary name lengths:
  ///      anything > 17 falls back to 22 (the min, matching the base table).
  function _maxByLen(uint256 len) internal view returns (uint256) {
    if (len == 0 || len > 17) return 22;
    return uint256(MAX_BY_LEN_TABLE[len - 1]);
  }

  /// @dev Minimum fontSize floor.
  uint256 private constant MIN_FONT_SIZE = 22;
  /// @dev Width target for width-fit: 93% of 270 = 251px.
  uint256 private constant TARGET_PX = 251;
  /// @dev Font units per em. 2^11 = 2048 for cheap bit-shift divide.
  uint256 private constant UPEM = 2048;
  /// @dev Left margin when overflowing (left-align escape).
  uint256 private constant OVERFLOW_LEFT_MARGIN = 8;
  /// @dev Trigger width-fit + rebalance logic for names at or above this length.
  uint256 private constant CENTER_BALANCE_MIN_LEN = 11;
  /// @dev Stroke width in font units for faux-bold.
  uint256 private constant STROKE_UPEM = 50;

  // ============================================
  // CONSTRUCTOR
  // ============================================

  constructor(address _fontDataA, address _fontDataB) {
    require(_fontDataA != address(0) && _fontDataB != address(0), "data addr 0");
    fontDataA = _fontDataA;
    fontDataB = _fontDataB;
  }

  // ============================================
  // PUBLIC ENTRY POINTS
  // ============================================

  function setDescription(string memory _description) external onlyOwner {
    description = _description;
  }

  /// @notice Build the full `data:application/json;base64,...` URI for a name.
  function generate(string memory name) public view returns (string memory) {
    bytes memory nameBytes = bytes(name);
    require(nameBytes.length > 0, "empty name");
    // No upper bound: names that exceed the canvas just run off the right.

    // Tokenize into slot indices. tokens[i] = slot, or INVALID_SLOT if the
    // input char was unsupported (skipped from rendering).
    (uint8[] memory tokenSlots, uint256 tokenCount, uint256 advUpem) = _tokenize(nameBytes);

    // Compute fontSize, xpercent, yposition.
    (uint256 fontSize, uint256 xpercentE2, uint256 yposition) = _computeParams(nameBytes, advUpem, tokenCount);

    // Assemble SVG.
    bytes memory svg = _buildSvg(name, tokenSlots, tokenCount, fontSize, xpercentE2, yposition);

    // Wrap in JSON + base64.
    string memory json = Base64.encode(
      bytes(string(abi.encodePacked(
        '{"name": "', name,
        '", "description": "', description,
        '", "image": "data:image/svg+xml;base64,', Base64.encode(svg),
        '"}'
      )))
    );
    return string(abi.encodePacked('data:application/json;base64,', json));
  }

  // ============================================
  // TOKENIZER (dynamic programming)
  // ============================================

  /// @dev DP tokenizer. For each position, choose the token (base/bigram/
  ///      trigram) that minimizes total base-char cost, tie-broken by
  ///      preferring the shorter token (so 'ffy' picks f + fy, not ff + y).
  /// @return tokenSlots Array of slot indices (length = max n).
  /// @return tokenCount Number of tokens emitted.
  /// @return advUpem Sum of advance widths in font UPEM units.
  function _tokenize(bytes memory nameBytes)
    internal
    view
    returns (uint8[] memory tokenSlots, uint256 tokenCount, uint256 advUpem)
  {
    uint256 n = nameBytes.length;
    // dpLen[i] = length of token starting at position i (0 = skip, 1 = base, 2/3 = ligature).
    // dpCost[i] = total cost from position i to end.
    uint8[] memory dpLen = new uint8[](n + 1);
    uint16[] memory dpCost = new uint16[](n + 1);
    dpLen[n] = 0;
    dpCost[n] = 0;

    for (uint256 i = n; i > 0; ) {
      unchecked { i--; }
      uint8 baseSlot = _charToSlot(uint8(nameBytes[i]));

      // Best option so far for this position.
      uint8 bestLen = 0;
      uint16 bestCost = type(uint16).max;

      // Option 1: base char (cost +1).
      if (baseSlot != INVALID_SLOT) {
        bestLen = 1;
        bestCost = 1 + dpCost[i + 1];
      }

      // Option 2: bigram.
      if (i + 2 <= n) {
        uint8 s1 = baseSlot;
        uint8 s2 = _charToSlot(uint8(nameBytes[i + 1]));
        if (s1 != INVALID_SLOT && s2 != INVALID_SLOT) {
          uint8 ligSlot = _findBigramLig(s1, s2);
          if (ligSlot != INVALID_SLOT) {
            uint16 costCandidate = dpCost[i + 2];
            if (costCandidate < bestCost || (costCandidate == bestCost && bestLen > 2)) {
              bestCost = costCandidate;
              bestLen = 2;
            }
          }
        }
      }

      // Option 3: trigram.
      if (i + 3 <= n) {
        uint8 s1 = baseSlot;
        uint8 s2 = _charToSlot(uint8(nameBytes[i + 1]));
        uint8 s3 = _charToSlot(uint8(nameBytes[i + 2]));
        if (s1 != INVALID_SLOT && s2 != INVALID_SLOT && s3 != INVALID_SLOT) {
          uint8 ligSlot = _findTrigramLig(s1, s2, s3);
          if (ligSlot != INVALID_SLOT) {
            uint16 costCandidate = dpCost[i + 3];
            if (costCandidate < bestCost || (costCandidate == bestCost && bestLen > 3)) {
              bestCost = costCandidate;
              bestLen = 3;
            }
          }
        }
      }

      dpLen[i] = bestLen;
      dpCost[i] = bestCost == type(uint16).max ? 0 : bestCost;
    }

    // Walk dp to emit tokens.
    tokenSlots = new uint8[](n);
    tokenCount = 0;
    advUpem = 0;
    uint256 i2 = 0;
    while (i2 < n) {
      uint8 len = dpLen[i2];
      if (len == 0) {
        unchecked { i2++; }
        continue;
      }
      uint8 slot;
      if (len == 1) {
        slot = _charToSlot(uint8(nameBytes[i2]));
      } else if (len == 2) {
        uint8 s1 = _charToSlot(uint8(nameBytes[i2]));
        uint8 s2 = _charToSlot(uint8(nameBytes[i2 + 1]));
        slot = _findBigramLig(s1, s2);
      } else {
        uint8 s1 = _charToSlot(uint8(nameBytes[i2]));
        uint8 s2 = _charToSlot(uint8(nameBytes[i2 + 1]));
        uint8 s3 = _charToSlot(uint8(nameBytes[i2 + 2]));
        slot = _findTrigramLig(s1, s2, s3);
      }
      tokenSlots[tokenCount] = slot;
      advUpem += _readAdvance(slot);
      unchecked { tokenCount++; i2 += len; }
    }
  }

  // ============================================
  // LOOKUPS
  // ============================================

  /// @dev Convert an ASCII char to a slot index, or INVALID_SLOT.
  function _charToSlot(uint8 ch) internal pure returns (uint8) {
    if (ch < LUT_BASE || ch > LUT_LAST) return INVALID_SLOT;
    return uint8(CHAR_LUT[ch - LUT_BASE]);
  }

  /// @dev Scan LIG_TABLE for a bigram match. c1,c2 are slot indices.
  function _findBigramLig(uint8 c1, uint8 c2) internal pure returns (uint8) {
    bytes memory table = LIG_TABLE;
    for (uint256 i = 0; i < LIG_COUNT; i++) {
      uint256 off = i * 4;
      if (uint8(table[off + 2]) != 0xFF) continue; // skip trigrams
      if (uint8(table[off]) == c1 && uint8(table[off + 1]) == c2) {
        return uint8(table[off + 3]);
      }
    }
    return INVALID_SLOT;
  }

  /// @dev Scan LIG_TABLE for a trigram match.
  function _findTrigramLig(uint8 c1, uint8 c2, uint8 c3) internal pure returns (uint8) {
    bytes memory table = LIG_TABLE;
    for (uint256 i = 0; i < LIG_COUNT; i++) {
      uint256 off = i * 4;
      if (uint8(table[off + 2]) == 0xFF) continue; // skip bigrams
      if (uint8(table[off]) == c1 && uint8(table[off + 1]) == c2 && uint8(table[off + 2]) == c3) {
        return uint8(table[off + 3]);
      }
    }
    return INVALID_SLOT;
  }

  /// @dev Read the uint16 advance for a slot.
  function _readAdvance(uint8 slot) internal pure returns (uint16) {
    bytes memory adv = ADVANCES;
    uint256 off = uint256(slot) * 2;
    return (uint16(uint8(adv[off])) << 8) | uint16(uint8(adv[off + 1]));
  }

  /// @dev Read (offset, length) for a slot from OFFSETS and LENGTHS.
  function _readSlotRange(uint8 slot) internal pure returns (uint256 off, uint256 len) {
    bytes memory offsets = OFFSETS;
    bytes memory lengths = LENGTHS;
    uint256 o = uint256(slot) * 2;
    off = (uint256(uint8(offsets[o])) << 8) | uint256(uint8(offsets[o + 1]));
    len = (uint256(uint8(lengths[o])) << 8) | uint256(uint8(lengths[o + 1]));
  }

  /// @dev Fetch a glyph path from the appropriate data contract.
  function _getGlyphPath(uint8 slot) internal view returns (bytes memory) {
    (uint256 off, uint256 len) = _readSlotRange(slot);
    address src = slot <= DATA_A_LAST_SLOT ? fontDataA : fontDataB;
    if (slot > DATA_A_LAST_SLOT) {
      off -= DATA_A_LENGTH; // convert global offset to local-within-B
    }
    bytes memory full = ICawFontData(src).DATA();
    bytes memory path = new bytes(len);
    for (uint256 i = 0; i < len; i++) path[i] = full[off + i];
    return path;
  }

  // ============================================
  // PARAMS (fontSize, x%, y)
  // ============================================

  /// @dev Compute the (fontSize, xpercent*100, yposition) triple. xpercent is
  ///      returned scaled by 100 so we can represent 0.5% increments if
  ///      needed; for integer percents it holds 8800 for 88%, 9350 for 93.5%,
  ///      etc. The caller divides by 100 when formatting.
  function _computeParams(bytes memory nameBytes, uint256 advUpem, uint256 /*tokenCount*/)
    internal
    view
    returns (uint256 fontSize, uint256 xpercentE2, uint256 yposition)
  {
    uint256 len = nameBytes.length;

    // Override: standalone 'f'.
    if (len == 1 && nameBytes[0] == 'f') {
      return (150, 8200, 195);
    }

    fontSize = _baseFontSize(len);
    fontSize += _narrowBonus(nameBytes) * 3;

    // y-position: drops when a descender is present, for short names.
    yposition = 231;
    if (_hasDescender(nameBytes)) {
      if (len == 1) yposition = 180;
      else if (len == 2) yposition = 200;
      else if (len == 3) yposition = 210;
      else if (len <= 5) yposition = 220;
    }

    // Start xpercent at 90, tighten if the name ends in a tall char (d/f/l).
    xpercentE2 = 9000;
    if (_endsWithTallChar(nameBytes)) {
      if (len == 1) xpercentE2 = 7500;
      else if (len == 2) xpercentE2 = 8000;
      else if (len <= 4) xpercentE2 = 8900;
    } else {
      if (len <= 2) xpercentE2 = 8800;
      else if (len <= 4) xpercentE2 = 8900;
    }

    // Width-fit: if the natural text width overflows the current anchor,
    // shrink fontSize and move anchor to 93%.
    //   widthPx = advUpem * fontSize / 2048
    //   anchorPx = xpercentE2 * 270 / 10000
    uint256 widthPxHi = advUpem * fontSize;       // UPEM-scaled width
    uint256 anchorPxHi = xpercentE2 * 270 * UPEM / 10000; // same scale
    if (widthPxHi > anchorPxHi && advUpem > 0) {
      // fitted = floor(TARGET_PX * UPEM / advUpem).
      uint256 fitted = (TARGET_PX * UPEM) / advUpem;
      uint256 maxBase = _maxByLen(len) + 8;
      if (fitted > maxBase) fitted = maxBase;
      if (fitted < MIN_FONT_SIZE) fitted = MIN_FONT_SIZE;
      fontSize = fitted;
      xpercentE2 = 9300;
    }

    // Center-balance for long names: if the left margin ends up smaller than
    // the right margin, re-anchor so both margins are equal.
    if (len >= CENTER_BALANCE_MIN_LEN) {
      uint256 finalWidthPx = (advUpem * fontSize) / UPEM;
      uint256 anchorPx = (xpercentE2 * 270) / 10000;
      uint256 leftPad = anchorPx > finalWidthPx ? anchorPx - finalWidthPx : 0;
      uint256 rightPad = 270 > anchorPx ? 270 - anchorPx : 0;
      if (leftPad < rightPad) {
        // xpercent = ((270 + finalWidth) / 2) / 270 * 100 → in E2 units:
        xpercentE2 = ((270 + finalWidthPx) * 10000) / (2 * 270);
      }
    }

    // Overflow escape hatch: if text still overflows, left-align with small
    // left margin so the start of the name stays visible.
    {
      uint256 finalWidthPx = (advUpem * fontSize) / UPEM;
      uint256 anchorPx = (xpercentE2 * 270) / 10000;
      if (finalWidthPx > anchorPx) {
        // xpercent = (8 + finalWidth) / 270 * 100 → E2
        xpercentE2 = ((OVERFLOW_LEFT_MARGIN + finalWidthPx) * 10000) / 270;
      }
    }
  }

  function _baseFontSize(uint256 len) internal pure returns (uint256) {
    if (len == 1) return 176;
    if (len == 2) return 133;
    if (len == 3) return 99;
    if (len == 4) return 77;
    if (len == 5) return 64;
    if (len == 6) return 55;
    if (len == 7) return 49;
    if (len == 8) return 44;
    if (len == 9) return 40;
    if (len == 10) return 36;
    if (len == 11) return 33;
    if (len == 12) return 31;
    if (len == 13) return 29;
    if (len == 14) return 27;
    if (len == 15) return 25;
    if (len == 16) return 23;
    return 22; // len 17+
  }

  function _narrowBonus(bytes memory nameBytes) internal pure returns (uint256) {
    uint256 count = 0;
    for (uint256 i = 0; i < nameBytes.length; i++) {
      bytes1 ch = nameBytes[i];
      if (ch == 'i' || ch == 'j' || ch == 'f' || ch == 'l' || ch == 't') {
        count++;
      }
    }
    return count > 10 ? 0 : count;
  }

  function _hasDescender(bytes memory nameBytes) internal pure returns (bool) {
    for (uint256 i = 0; i < nameBytes.length; i++) {
      bytes1 ch = nameBytes[i];
      if (ch == 'j' || ch == 'f' || ch == 'y' || ch == 'g' || ch == 'p' || ch == 'q') {
        return true;
      }
    }
    return false;
  }

  function _endsWithTallChar(bytes memory nameBytes) internal pure returns (bool) {
    bytes1 last = nameBytes[nameBytes.length - 1];
    return (last == 'd' || last == 'f' || last == 'l');
  }

  // ============================================
  // SVG BUILDING
  // ============================================

  /// @dev Assemble the final SVG. We build in two halves: everything up to
  ///      the glyph group, the glyphs themselves, then the trailing stuff.
  function _buildSvg(
    string memory name,
    uint8[] memory tokenSlots,
    uint256 tokenCount,
    uint256 fontSize,
    uint256 xpercentE2,
    uint256 yposition
  ) internal view returns (bytes memory) {
    // Precompute the text width and starting cursor.
    uint256 advUpem = 0;
    for (uint256 i = 0; i < tokenCount; i++) advUpem += _readAdvance(tokenSlots[i]);
    // widthPxE6 = advUpem * fontSize * 1_000_000 / UPEM  (6 decimal digits)
    uint256 widthPxE6 = (advUpem * fontSize * 1_000_000) / UPEM;
    // anchorPxE6 = xpercentE2 * 270 * 1_000_000 / 10000 = xpercentE2 * 27_000
    uint256 anchorPxE6 = xpercentE2 * 27_000;
    // cursorE6 = anchorPxE6 - widthPxE6  (may be negative; represent as int)
    // Use a signed int for the cursor so underflow doesn't wrap.
    int256 cursorE6 = int256(anchorPxE6) - int256(widthPxE6);

    // scale string: fontSize / 2048, formatted to 6 decimals.
    // scaleE6 = fontSize * 1_000_000 / 2048
    uint256 scaleE6 = (fontSize * 1_000_000) >> 11;
    string memory scaleStr = _formatE6(scaleE6);

    bytes memory glyphs;
    for (uint256 i = 0; i < tokenCount; i++) {
      uint8 slot = tokenSlots[i];
      bytes memory path = _getGlyphPath(slot);
      string memory xStr = _formatSignedE6(cursorE6);
      glyphs = abi.encodePacked(
        glyphs,
        '<path d="', path,
        '" transform="translate(', xStr, ',', Strings.toString(yposition),
        ') scale(', scaleStr, ',-', scaleStr,
        ')" fill="rgb(235,192,70)" stroke="rgb(235,192,70)" stroke-width="50" stroke-linejoin="round" stroke-linecap="round"/>'
      );
      // advance the cursor by advance * fontSize / UPEM
      uint256 advE6 = (uint256(_readAdvance(slot)) * fontSize * 1_000_000) >> 11;
      cursorE6 += int256(advE6);
    }

    return abi.encodePacked(
      // SVG header, defs, background
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 270 270" fill="none">',
      // <title> is the SVG accessibility / tooltip primitive — screen readers
      // announce it, browsers show it on hover for standalone SVGs, and it
      // gives text-extracting indexers a plaintext copy of the username.
      '<title>', name, '</title>',
      '<defs><clipPath id="c"><rect width="270" height="270" rx="22" ry="22"/></clipPath></defs>',
      '<g clip-path="url(#c)"><rect width="270" height="270" fill="url(#g)"/>',
      // Logo (unchanged from before)
      LOGO,
      // Glyph paths
      glyphs,
      // Close group, outline, gradient defs, close svg
      '</g><rect x="0.5" y="0.5" width="269" height="269" rx="22" ry="22" fill="none" stroke="rgba(240,177,0,0.3)" stroke-width="1"/>',
      '<defs><linearGradient id="g" x1="110.5" y1="140" x2="8" gradientUnits="userSpaceOnUse">',
      '<stop stop-color="#000000"/><stop offset="0.35" stop-color="#ECc052"/><stop offset="1" stop-color="#ECc052"/>',
      '</linearGradient></defs></svg>'
    );
  }

  /// @dev The three-ornament logo (unchanged from the original contract).
  bytes private constant LOGO =
    '<path d="M30.36,35.15l15.28,1.29a7.47,7.47,0,0,0,5.29-3l-1.84-7.27a33,33,0,0,1,8.77,0L56,33.42s1.69,3.13,6.6,2.94c.75,0,14-1.25,14-1.25L69.15,45.52l-5.73.54a9.57,9.57,0,0,1-4.11-.29,10.59,10.59,0,0,1-3-1.63L53.47,50.6l-2.73-6.45a10.13,10.13,0,0,0-1.52.88c-2,1.36-5.49,1.08-5.49,1.08l-5.82-.48Z" style="fill:#000000"/>'
    '<path d="M48.32,84.39,41.8,70.51a7.45,7.45,0,0,0-5.25-3.07l-5.39,5.22a33.26,33.26,0,0,1-4.4-7.58L34,63s1.86-3-.75-7.18c-.4-.63-8.06-11.48-8.06-11.48l12.72,1.23,3.33,4.69A9.54,9.54,0,0,1,43.05,54a10.71,10.71,0,0,1,.09,3.41l7-.76-4.22,5.59a10.44,10.44,0,0,0,1.52.86c2.19,1.08,3.67,4.22,3.67,4.22l2.5,5.28Z" style="fill:#000000"/>'
    '<path d="M82,44.21,73.25,56.8a7.46,7.46,0,0,0,0,6.09l7.22,2a32.65,32.65,0,0,1-4.36,7.6l-5.39-5.26s-3.55-.1-5.85,4.25c-.35.66-5.9,12.72-5.9,12.72l-5.3-11.64L56,67.39A9.69,9.69,0,0,1,58.34,64a10.82,10.82,0,0,1,2.9-1.78L57.07,56.5l6.95.86a11.11,11.11,0,0,0,0-1.76c-.17-2.43,1.81-5.29,1.81-5.29l3.32-4.8Z" style="fill:#000000"/>';

  // ============================================
  // NUMBER FORMATTING
  // ============================================

  /// @dev Format a non-negative integer (in 10^-6 units) as a decimal string.
  ///      E.g. 1234567 → "1.234567".
  function _formatE6(uint256 v) internal pure returns (string memory) {
    uint256 whole = v / 1_000_000;
    uint256 frac = v % 1_000_000;
    if (frac == 0) return Strings.toString(whole);
    // Build fractional part zero-padded to 6 digits, then trim trailing zeros.
    bytes memory fracBytes = new bytes(6);
    uint256 x = frac;
    for (uint256 i = 6; i > 0; ) {
      unchecked { i--; }
      fracBytes[i] = bytes1(uint8(48 + (x % 10)));
      x /= 10;
    }
    uint256 trimEnd = 6;
    while (trimEnd > 0 && fracBytes[trimEnd - 1] == '0') {
      unchecked { trimEnd--; }
    }
    bytes memory trimmed = new bytes(trimEnd);
    for (uint256 i = 0; i < trimEnd; i++) trimmed[i] = fracBytes[i];
    return string(abi.encodePacked(Strings.toString(whole), '.', trimmed));
  }

  /// @dev Format a possibly-negative E6 integer. Negative values emit a '-' prefix.
  function _formatSignedE6(int256 v) internal pure returns (string memory) {
    if (v < 0) {
      return string(abi.encodePacked('-', _formatE6(uint256(-v))));
    }
    return _formatE6(uint256(v));
  }
}
