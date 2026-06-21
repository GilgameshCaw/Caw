/**
 * make-local-sponsor-code.ts — dev-only helper.
 *
 * Generates a `long`-tier sponsor code, hashes it with the SAME HMAC the live
 * /verify path uses, inserts the SponsorCode row into the LOCAL db, and prints
 * the plaintext code ONCE (it is never stored, only the hash is). Use the
 * printed code as ?code=... on /onboarding to test the sponsored flow locally.
 *
 * Run:  npx tsx scripts/make-local-sponsor-code.ts
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { generateLongCode, hashCode } from '../src/services/SponsorService/codes'

async function main() {
  if (!process.env.SPONSOR_CODE_HMAC_SECRET) {
    console.error('SPONSOR_CODE_HMAC_SECRET is not set in .env — cannot hash the code.')
    process.exit(1)
  }
  const prisma = new PrismaClient()

  const rawCode = generateLongCode()
  const codeHash = hashCode(rawCode)

  // 30-day expiry, 5 uses, min username length 3, plain gift (no repay/KYC).
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  await prisma.sponsorCode.create({
    data: {
      codeHash,
      tier: 'long',
      label: 'local-dev',
      budgetCapUsdCents: 10000, // $100 cap (long-tier max)
      maxDepositCawWei: (100_000_000n * 10n ** 18n).toString(), // generous local cap
      maxUses: 5,
      usesRemaining: 5,
      minUsernameLength: 3,
      expiresAt,
      repayBps: 0,
      requireKycLevel: 0,
    },
  })

  await prisma.$disconnect()

  console.log('\n  Local sponsor code created (long tier, 5 uses, expires in 30d):\n')
  console.log(`    CODE:  ${rawCode}`)
  console.log(`    USE:   http://localhost:5173/onboarding?code=${rawCode}\n`)
  console.log('  (Adjust the host/port to your local FE dev server.)\n')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
