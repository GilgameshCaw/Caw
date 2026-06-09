/**
 * CLI script to bulk-generate sponsor invite codes and insert them into the DB.
 *
 * Usage:
 *   npx tsx scripts/create-sponsor-codes.ts \
 *     --count 10 \
 *     --tier short \
 *     --maxUses 3 \
 *     --maxDepositCaw 5000000000000000000000000 \
 *     --budgetCap 800 \
 *     --minUsernameLength 3 \
 *     --expiresInHours 48 \
 *     --label "launch-wave-1"
 *
 * The raw codes are written to messages/sponsor-codes-{timestamp}-{label}.txt
 * (messages/ is gitignored). The DB stores only HMAC hashes.
 *
 * Requires: SPONSOR_CODE_HMAC_SECRET env var set (same as the API process).
 * Load from client/.env or export in the shell before running.
 */

import fs from 'fs'
import path from 'path'
import { prisma } from '../src/prismaClient'
import { generateShortCode, generateLongCode, hashCode } from '../src/services/SponsorService/codes'

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const flag = `--${name}`
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return undefined
  return process.argv[idx + 1]
}

function getArgNum(name: string, fallback?: number): number | undefined {
  const v = getArg(name)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got: ${v}`)
  return n
}

const count          = getArgNum('count', 1)!
const tier           = (getArg('tier') ?? 'short') as 'short' | 'long'
const maxUses        = getArgNum('maxUses')
const maxDepositCaw  = getArg('maxDepositCaw') ?? '10000000000000000000000000'  // 10M CAW default
const budgetCap      = getArgNum('budgetCap')
const minUsernameLen = getArgNum('minUsernameLength', 0)!
const expiresInHours = getArgNum('expiresInHours')
const label          = getArg('label')
// Sponsor-Repay (Phase 2): basis points of the deposit the user must repay on
// first withdrawal. 0 = plain gift, 10000 = 1x deposit, 20000 = 2x (the cap the
// contract enforces). requireKycLevel gates withdrawal behind KYC (0 = none).
const repayBps         = getArgNum('repayBps', 0)!
const requireKycLevel  = getArgNum('requireKycLevel', 0)!

// ─── Validation ───────────────────────────────────────────────────────────────

if (!['short', 'long'].includes(tier)) {
  console.error(`--tier must be 'short' or 'long', got: ${tier}`)
  process.exit(1)
}

if (budgetCap === undefined) {
  console.error('--budgetCap is required (USD cents, e.g. 800 for $8.00)')
  process.exit(1)
}

if (tier === 'short' && budgetCap > 1000) {
  console.error('Tier 1 (short) codes may not exceed $10 budget cap (1000 cents)')
  process.exit(1)
}

if (tier === 'long' && budgetCap > 10000) {
  console.error('Tier 2 (long) codes may not exceed $100 budget cap (10000 cents)')
  process.exit(1)
}

if (repayBps < 0 || repayBps > 20000) {
  console.error('--repayBps must be between 0 and 20000 (the contract caps repay at 2x deposit)')
  process.exit(1)
}

if (requireKycLevel < 0 || requireKycLevel > 255) {
  console.error('--requireKycLevel must be 0-255 (0 = no KYC gate)')
  process.exit(1)
}

if (!process.env.SPONSOR_CODE_HMAC_SECRET) {
  console.error('SPONSOR_CODE_HMAC_SECRET is not set. Load client/.env or export it before running.')
  process.exit(1)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const defaultExpiry = tier === 'short' ? 24 : 30 * 24
  const expiryHours   = expiresInHours ?? defaultExpiry
  const expiresAt     = new Date(Date.now() + expiryHours * 60 * 60 * 1000)

  const rawCodes: string[] = []
  let collisions = 0

  for (let i = 0; i < count; i++) {
    let rawCode: string
    let codeHash: string
    let attempts = 0

    // Regenerate on hash collision (extremely unlikely).
    while (true) {
      rawCode = tier === 'short' ? generateShortCode() : generateLongCode()
      codeHash = hashCode(rawCode)
      const existing = await prisma.sponsorCode.findUnique({ where: { codeHash } })
      if (!existing) break
      attempts++
      collisions++
      if (attempts > 5) {
        console.error(`[${i + 1}/${count}] Could not generate a non-colliding code after 5 attempts. Aborting.`)
        process.exit(1)
      }
    }

    const actualMaxUses      = maxUses ?? (tier === 'long' ? 1 : undefined)
    const actualUsesRemaining = actualMaxUses ?? null

    await prisma.sponsorCode.create({
      data: {
        codeHash,
        tier,
        label: label ?? null,
        budgetCapUsdCents:  budgetCap,
        maxDepositCawWei:   maxDepositCaw,
        maxUses:            actualMaxUses ?? null,
        usesRemaining:      actualUsesRemaining,
        minUsernameLength:  minUsernameLen,
        repayBps,
        requireKycLevel,
        expiresAt,
        createdBy:          null,
      },
    })

    rawCodes.push(rawCode)
    process.stdout.write(`\r  Generated ${i + 1}/${count}...`)
  }

  console.log('')  // newline after progress indicator

  // Write codes to messages/ (gitignored).
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug      = label ? `-${label.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}` : ''
  const outDir    = path.join(__dirname, '..', '..', '..', 'messages')
  const outFile   = path.join(outDir, `sponsor-codes-${timestamp}${slug}.txt`)

  try {
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true })
    }
    const lines = [
      `# Sponsor codes — ${new Date().toISOString()}`,
      `# tier=${tier} count=${count} budgetCap=$${(budgetCap / 100).toFixed(2)} expiresIn=${expiryHours}h label=${label ?? '(none)'}`,
      `# IMPORTANT: These codes cannot be recovered from the DB. Keep this file secure.`,
      '',
      ...rawCodes,
      '',
    ]
    fs.writeFileSync(outFile, lines.join('\n'), 'utf8')
  } catch (err) {
    console.warn('[warn] Could not write output file:', err)
    console.log('\n=== CODES (copy now — not stored in DB) ===')
    rawCodes.forEach(c => console.log(c))
    console.log('===========================================')
  }

  console.log('')
  console.log(`Inserted ${count} ${tier} code(s) into the DB.`)
  console.log(`  Budget cap:    $${(budgetCap / 100).toFixed(2)} per redemption`)
  console.log(`  Max deposit:   ${maxDepositCaw} wei`)
  console.log(`  Max uses:      ${maxUses ?? (tier === 'long' ? 1 : 'unlimited')}`)
  console.log(`  Expires:       ${expiresAt.toISOString()} (+${expiryHours}h)`)
  if (label) console.log(`  Label:         ${label}`)
  if (collisions > 0) console.log(`  Hash collisions resolved: ${collisions}`)
  console.log('')

  let writtenPath: string | null = null
  try {
    if (fs.existsSync(outFile)) writtenPath = outFile
  } catch { /* ignore */ }

  if (writtenPath) {
    console.log(`Raw codes written to: ${writtenPath}`)
    console.log('(messages/ is gitignored — keep this file secure)')
  }

  await prisma.$disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
