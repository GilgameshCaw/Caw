#!/usr/bin/env node
// Regenerates client/src/services/FrontEnd/src/components/usernameSvg/glyphData.ts
// from solidity/contracts/CawFontData{A,B}.sol and the lookup tables in
// solidity/contracts/CawProfileURI.sol. Run this after any change to those
// contracts.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../../../../..');
const SOL_DIR = path.join(REPO, 'solidity/contracts');
const OUT_FILE = path.join(__dirname, '../src/components/usernameSvg/glyphData.ts');

function readHexBlob(solPath) {
  const src = fs.readFileSync(solPath, 'utf8');
  const chunks = [];
  const re = /hex"([0-9a-fA-F]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) chunks.push(m[1]);
  return chunks.join('').toLowerCase();
}

function readConstHex(sol, name) {
  // Match `bytes ... NAME = hex"...";` — handles whitespace but not multi-literal concat.
  const re = new RegExp(`${name}\\s*=\\s*hex"([0-9a-fA-F]+)"\\s*;`);
  const m = sol.match(re);
  if (!m) throw new Error(`could not find hex constant ${name}`);
  return m[1].toLowerCase();
}

function hexToU8(h) {
  const out = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}
function hexToU16(h) {
  const out = [];
  for (let i = 0; i < h.length; i += 4) {
    out.push((parseInt(h.slice(i, i + 2), 16) << 8) | parseInt(h.slice(i + 2, i + 4), 16));
  }
  return out;
}

const dataA = readHexBlob(path.join(SOL_DIR, 'CawFontDataA.sol'));
const dataB = readHexBlob(path.join(SOL_DIR, 'CawFontDataB.sol'));
const combined = dataA + dataB;
const pathBlob = Buffer.from(combined, 'hex').toString('utf8');

const uri = fs.readFileSync(path.join(SOL_DIR, 'CawProfileURI.sol'), 'utf8');
const CHAR_LUT = hexToU8(readConstHex(uri, 'CHAR_LUT'));
const LIG_TABLE = hexToU8(readConstHex(uri, 'LIG_TABLE'));
const ADVANCES = hexToU16(readConstHex(uri, 'ADVANCES'));
const OFFSETS = hexToU16(readConstHex(uri, 'OFFSETS'));
const LENGTHS = hexToU16(readConstHex(uri, 'LENGTHS'));

if (ADVANCES.length !== 54 || OFFSETS.length !== 54 || LENGTHS.length !== 54) {
  throw new Error(`expected 54 slots, got A=${ADVANCES.length} O=${OFFSETS.length} L=${LENGTHS.length}`);
}
if (LIG_TABLE.length !== 72) throw new Error(`expected 72 ligature bytes, got ${LIG_TABLE.length}`);

const glyphPaths = [];
for (let slot = 0; slot < 54; slot++) {
  glyphPaths.push(pathBlob.substring(OFFSETS[slot], OFFSETS[slot] + LENGTHS[slot]));
}

const body = `// AUTO-GENERATED from solidity/contracts/CawFontData{A,B}.sol and
// CawProfileURI.sol. Do not edit by hand — re-run scripts/extract-glyphs.js
// if the contracts change.
//
// Each entry in GLYPH_PATHS is the SVG \`d=\` content for one glyph, in the
// same font-units coordinate space as the on-chain renderer (UPEM = 2048,
// Y-axis inverted via the negative scale in the transform).

/** ASCII lookup: (char - 0x30) → slot index, 0xFF for invalid. */
export const CHAR_LUT: readonly number[] = [
  ${CHAR_LUT.join(', ')}
];

/**
 * Ligature table. 18 entries, 4 bytes each: [c1, c2, c3, result].
 * c3 === 0xFF means bigram. Trigrams come first (contract relies on it).
 */
export const LIG_TABLE: readonly number[] = [
  ${LIG_TABLE.join(', ')}
];

/** Per-slot glyph advance width in font UPEM (2048 per em). */
export const ADVANCES: readonly number[] = [
  ${ADVANCES.join(', ')}
];

/** SVG \`d=\` content per slot (54 entries: 36 base + 18 ligatures). */
export const GLYPH_PATHS: readonly string[] = [
${glyphPaths.map(p => '  ' + JSON.stringify(p)).join(',\n')}
];

export const INVALID_SLOT = 0xff;
export const LUT_BASE = 0x30;
export const LUT_LAST = 0x7a;
export const LIG_COUNT = 18;
export const UPEM = 2048;
`;

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, body);
console.log(`wrote ${OUT_FILE} (${body.length} bytes, ${glyphPaths.length} glyphs)`);
