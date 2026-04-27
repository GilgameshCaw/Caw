import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export const brand = chalk.hex('#FFD700') // CAW gold
export const dim = chalk.dim
export const success = chalk.green
export const warn = chalk.yellow
export const err = chalk.red
export const info = chalk.cyan
export const bold = chalk.bold

// 3D-styled banner. Each glyph in cli/asci.txt is colored by which face of
// the letter it represents:
//   _   horizontals          → dark red
//   \   front face            → brightest gold
//   /   bottom face           → darkest gold
//   \/  inside-corner left    → medium gold (the digraph itself + a / that
//                               immediately precedes a \)
//
// A few spots can't be derived from neighbours alone and are hand-tuned
// via BANNER_OVERRIDES below.
const BANNER_RED         = chalk.hex('#660000')
const BANNER_GOLD_BRIGHT = chalk.hex('#FFe700')
const BANNER_GOLD_MID    = chalk.hex('#C9A227')
const BANNER_GOLD_DARK   = chalk.hex('#7C5E10')

const BANNER_OVERRIDES = {
  // Row 6 (0-indexed 5), col 28 reads as front face and col 29 as bottom —
  // the inner geometry of the W's middle peak that the neighbour rules
  // can't infer.
  5: {
    28: BANNER_GOLD_BRIGHT,
    29: BANNER_GOLD_DARK,
  },
}

const __bannerDir = path.dirname(fileURLToPath(import.meta.url))
const __bannerPath = path.resolve(__bannerDir, '../../asci.txt')

function colorBannerLine(line, rowIndex) {
  const chars = [...line]
  const out = []
  const rowOverrides = BANNER_OVERRIDES[rowIndex] || {}
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    const next = chars[i + 1]
    const prev = chars[i - 1]
    if (rowOverrides[i] && (c === '\\' || c === '/')) {
      out.push(rowOverrides[i](c))
      continue
    }
    if (c === '_') {
      out.push(BANNER_RED(c))
    } else if (c === '\\') {
      // Front face by default. \/ digraph paints both halves medium.
      out.push(next === '/' ? BANNER_GOLD_MID(c) : BANNER_GOLD_BRIGHT(c))
    } else if (c === '/') {
      // Bottom face by default. Two left-face exceptions:
      //   • a / immediately following a \  (the / half of \/)
      //   • a / immediately preceding a \  (rising left edge)
      out.push((prev === '\\' || next === '\\') ? BANNER_GOLD_MID(c) : BANNER_GOLD_DARK(c))
    } else {
      out.push(c)
    }
  }
  return out.join('')
}

let bannerCache = null
function loadBanner() {
  if (bannerCache) return bannerCache
  try {
    bannerCache = fs.readFileSync(__bannerPath, 'utf8').replace(/\n+$/, '').split('\n')
  } catch {
    bannerCache = []
  }
  return bannerCache
}

export function banner() {
  const lines = loadBanner()
  console.log()
  if (lines.length) {
    for (let r = 0; r < lines.length; r++) {
      console.log(colorBannerLine(lines[r], r))
    }
  } else {
    // Fallback if asci.txt is missing — the CLI should still run.
    console.log(brand.bold('  CAW'))
  }
  console.log()
  console.log(dim('  A trustless, decentralized social clearing-house'))
  console.log(dim('  focused on freedom of speech.'))
  console.log()
}

export function section(title) {
  console.log()
  console.log(brand('─'.repeat(50)))
  console.log(brand.bold(`  ${title}`))
  console.log(brand('─'.repeat(50)))
  console.log()
}

export function tip(text) {
  console.log(dim(`  💡 ${text}`))
}

export function tipBlock(lines) {
  console.log()
  console.log(dim('  ┌─────────────────────────────────────────────'))
  for (const line of lines) {
    console.log(dim(`  │ ${line}`))
  }
  console.log(dim('  └─────────────────────────────────────────────'))
  console.log()
}
