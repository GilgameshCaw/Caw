// TypeScript port of solidity/contracts/CawProfileURI.sol's SVG rendering
// pipeline: tokenize → compute params → emit glyph <path> elements.
//
// Output is intended to be pixel-identical to the on-chain NFT so the
// in-app preview matches exactly on every platform. Numeric quantization
// (6 decimal places for X, integer Y/scale) matches the contract's E6
// fixed-point formatter so the strings agree byte-for-byte.

import {
  ADVANCES,
  CHAR_LUT,
  GLYPH_PATHS,
  INVALID_SLOT,
  LIG_COUNT,
  LIG_TABLE,
  LUT_BASE,
  LUT_LAST,
  UPEM,
} from './glyphData';

const MIN_FONT_SIZE = 22;
const TARGET_PX = 251;
const OVERFLOW_LEFT_MARGIN = 8;
const CENTER_BALANCE_MIN_LEN = 11;
const DATA_A_LAST_SLOT = 38;

const MAX_BY_LEN_TABLE = [176, 133, 99, 77, 64, 55, 49, 44, 40, 36, 33, 31, 29, 27, 25, 23, 22];
const NARROW_CHARS = new Set(['i', 'j', 'f', 'l', 't']);
const DESCENDER_CHARS = new Set(['j', 'f', 'y', 'g', 'p', 'q']);
const TALL_ENDING_CHARS = new Set(['d', 'f', 'l']);

function charToSlot(ch: number): number {
  if (ch < LUT_BASE || ch > LUT_LAST) return INVALID_SLOT;
  return CHAR_LUT[ch - LUT_BASE];
}

function findBigramLig(c1: number, c2: number): number {
  for (let i = 0; i < LIG_COUNT; i++) {
    const off = i * 4;
    if (LIG_TABLE[off + 2] !== 0xff) continue;
    if (LIG_TABLE[off] === c1 && LIG_TABLE[off + 1] === c2) return LIG_TABLE[off + 3];
  }
  return INVALID_SLOT;
}

function findTrigramLig(c1: number, c2: number, c3: number): number {
  for (let i = 0; i < LIG_COUNT; i++) {
    const off = i * 4;
    if (LIG_TABLE[off + 2] === 0xff) continue;
    if (LIG_TABLE[off] === c1 && LIG_TABLE[off + 1] === c2 && LIG_TABLE[off + 2] === c3) {
      return LIG_TABLE[off + 3];
    }
  }
  return INVALID_SLOT;
}

interface TokenizeResult {
  tokenSlots: number[];
  advUpem: number;
}

// DP tokenizer: at each position, pick the token (base/bigram/trigram) that
// minimizes total base-char cost, tie-broken by preferring the shorter token
// so e.g. 'ffy' picks f + fy rather than ff + y. Mirrors _tokenize in .sol.
function tokenize(bytes: number[]): TokenizeResult {
  const n = bytes.length;
  const dpLen = new Uint8Array(n + 1);
  const dpCost = new Uint16Array(n + 1);

  for (let i = n - 1; i >= 0; i--) {
    const baseSlot = charToSlot(bytes[i]);
    let bestLen = 0;
    let bestCost = 0xffff;

    if (baseSlot !== INVALID_SLOT) {
      bestLen = 1;
      bestCost = 1 + dpCost[i + 1];
    }
    if (i + 2 <= n) {
      const s1 = baseSlot;
      const s2 = charToSlot(bytes[i + 1]);
      if (s1 !== INVALID_SLOT && s2 !== INVALID_SLOT) {
        const lig = findBigramLig(s1, s2);
        if (lig !== INVALID_SLOT) {
          const cand = dpCost[i + 2];
          if (cand < bestCost || (cand === bestCost && bestLen > 2)) {
            bestCost = cand;
            bestLen = 2;
          }
        }
      }
    }
    if (i + 3 <= n) {
      const s1 = baseSlot;
      const s2 = charToSlot(bytes[i + 1]);
      const s3 = charToSlot(bytes[i + 2]);
      if (s1 !== INVALID_SLOT && s2 !== INVALID_SLOT && s3 !== INVALID_SLOT) {
        const lig = findTrigramLig(s1, s2, s3);
        if (lig !== INVALID_SLOT) {
          const cand = dpCost[i + 3];
          if (cand < bestCost || (cand === bestCost && bestLen > 3)) {
            bestCost = cand;
            bestLen = 3;
          }
        }
      }
    }

    dpLen[i] = bestLen;
    dpCost[i] = bestCost === 0xffff ? 0 : bestCost;
  }

  const tokenSlots: number[] = [];
  let advUpem = 0;
  let i = 0;
  while (i < n) {
    const len = dpLen[i];
    if (len === 0) { i++; continue; }
    let slot: number;
    if (len === 1) slot = charToSlot(bytes[i]);
    else if (len === 2) slot = findBigramLig(charToSlot(bytes[i]), charToSlot(bytes[i + 1]));
    else slot = findTrigramLig(charToSlot(bytes[i]), charToSlot(bytes[i + 1]), charToSlot(bytes[i + 2]));
    tokenSlots.push(slot);
    advUpem += ADVANCES[slot];
    i += len;
  }
  return { tokenSlots, advUpem };
}

function baseFontSize(len: number): number {
  const table = [176, 133, 99, 77, 64, 55, 49, 44, 40, 36, 33, 31, 29, 27, 25, 23];
  if (len < 1) return 22;
  if (len >= 17) return 22;
  return table[len - 1];
}

function maxByLen(len: number): number {
  if (len === 0 || len > 17) return 22;
  return MAX_BY_LEN_TABLE[len - 1];
}

function narrowBonus(name: string): number {
  let count = 0;
  for (const c of name) if (NARROW_CHARS.has(c)) count++;
  return count > 10 ? 0 : count;
}

function hasDescender(name: string): boolean {
  for (const c of name) if (DESCENDER_CHARS.has(c)) return true;
  return false;
}

function endsWithTallChar(name: string): boolean {
  if (name.length === 0) return false;
  return TALL_ENDING_CHARS.has(name[name.length - 1]);
}

interface Params {
  fontSize: number;
  xpercentE2: number;
  yposition: number;
}

// Mirrors _computeParams in .sol. xpercentE2 is "x percent × 100", so 93% → 9300.
function computeParams(name: string, advUpem: number): Params {
  const len = name.length;

  if (len === 1 && name[0] === 'f') {
    return { fontSize: 150, xpercentE2: 8200, yposition: 195 };
  }

  let fontSize = baseFontSize(len);
  fontSize += narrowBonus(name) * 3;

  let yposition = 231;
  if (hasDescender(name)) {
    if (len === 1) yposition = 180;
    else if (len === 2) yposition = 200;
    else if (len === 3) yposition = 210;
    else if (len <= 5) yposition = 220;
  }

  let xpercentE2 = 9000;
  if (endsWithTallChar(name)) {
    if (len === 1) xpercentE2 = 7500;
    else if (len === 2) xpercentE2 = 8000;
    else if (len <= 4) xpercentE2 = 8900;
  } else {
    if (len <= 2) xpercentE2 = 8800;
    else if (len <= 4) xpercentE2 = 8900;
  }

  // Width-fit shrink. Contract uses integer math; use floor here to match.
  const widthPxHi = advUpem * fontSize;
  const anchorPxHi = Math.floor((xpercentE2 * 270 * UPEM) / 10000);
  if (widthPxHi > anchorPxHi && advUpem > 0) {
    let fitted = Math.floor((TARGET_PX * UPEM) / advUpem);
    const maxBase = maxByLen(len) + 8;
    if (fitted > maxBase) fitted = maxBase;
    if (fitted < MIN_FONT_SIZE) fitted = MIN_FONT_SIZE;
    fontSize = fitted;
    xpercentE2 = 9300;
  }

  if (len >= CENTER_BALANCE_MIN_LEN) {
    const finalWidthPx = Math.floor((advUpem * fontSize) / UPEM);
    const anchorPx = Math.floor((xpercentE2 * 270) / 10000);
    const leftPad = anchorPx > finalWidthPx ? anchorPx - finalWidthPx : 0;
    const rightPad = 270 > anchorPx ? 270 - anchorPx : 0;
    if (leftPad < rightPad) {
      xpercentE2 = Math.floor(((270 + finalWidthPx) * 10000) / (2 * 270));
    }
  }

  const finalWidthPx = Math.floor((advUpem * fontSize) / UPEM);
  const anchorPx = Math.floor((xpercentE2 * 270) / 10000);
  if (finalWidthPx > anchorPx) {
    xpercentE2 = Math.floor(((OVERFLOW_LEFT_MARGIN + finalWidthPx) * 10000) / 270);
  }

  return { fontSize, xpercentE2, yposition };
}

// Match the contract's _formatE6: emit an integer (10^-6 units) as a decimal
// string, trimming trailing zeros, dropping the decimal point entirely when
// the fractional part is zero. E.g. 1234567 → "1.234567", 2000000 → "2".
function formatE6(v: number): string {
  const whole = Math.trunc(v / 1_000_000);
  const frac = v - whole * 1_000_000;
  if (frac === 0) return String(whole);
  let fracStr = String(frac).padStart(6, '0');
  fracStr = fracStr.replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

function formatSignedE6(v: number): string {
  if (v < 0) return `-${formatE6(-v)}`;
  return formatE6(v);
}

export interface GlyphElement {
  d: string;
  transform: string;
}

export interface RenderedUsername {
  glyphs: GlyphElement[];
  /** Fill/stroke color used by the contract. Exposed so React can match. */
  color: string;
  strokeWidth: number;
}

/**
 * Produce the per-glyph <path> data for rendering `name` at the contract's
 * exact quantization. Consumers decide how to wrap it (in-app preview uses a
 * card with dropShadow; the contract's SVG wraps it in the gradient + logo).
 */
export function renderUsernameGlyphs(name: string): RenderedUsername {
  // The contract rejects empty strings; we silently return an empty render so
  // the live preview can show the card while the user is still typing.
  if (name.length === 0) {
    return { glyphs: [], color: 'rgb(235,192,70)', strokeWidth: 50 };
  }

  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) bytes.push(name.charCodeAt(i));

  const { tokenSlots, advUpem } = tokenize(bytes);
  const { fontSize, xpercentE2, yposition } = computeParams(name, advUpem);

  // widthPxE6 = advUpem * fontSize * 1e6 / UPEM, UPEM = 2048 = 2^11.
  const widthPxE6 = Math.floor((advUpem * fontSize * 1_000_000) / UPEM);
  const anchorPxE6 = xpercentE2 * 27_000;
  let cursorE6 = anchorPxE6 - widthPxE6;

  const scaleE6 = Math.floor((fontSize * 1_000_000) / UPEM);
  const scaleStr = formatE6(scaleE6);

  const glyphs: GlyphElement[] = [];
  for (const slot of tokenSlots) {
    const xStr = formatSignedE6(cursorE6);
    const transform = `translate(${xStr},${yposition}) scale(${scaleStr},-${scaleStr})`;
    glyphs.push({ d: GLYPH_PATHS[slot], transform });
    const advE6 = Math.floor((ADVANCES[slot] * fontSize * 1_000_000) / UPEM);
    cursorE6 += advE6;
  }

  return { glyphs, color: 'rgb(235,192,70)', strokeWidth: 50 };
}

// Re-export for consumers/tests that want to inspect individual pieces.
export const _internals = {
  tokenize,
  computeParams,
  formatE6,
  formatSignedE6,
  DATA_A_LAST_SLOT,
};
