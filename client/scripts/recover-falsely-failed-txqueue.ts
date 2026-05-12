// Recover TxQueue rows that were falsely marked failed with reason
// "Cawonce already used" when the underlying action actually landed
// on chain. Caused by a batch-contamination bug in ValidatorService
// (fixed in commit ef08a8b) — when a simulation batch returned mixed
// rejection messages, the validator skipped resolveCawonceUsed for
// every row and mass-marked them failed via the permanent-failure
// path.
//
// For each candidate row this script:
//   1. Reads its TxQueue payload (the original submitted ActionData).
//   2. Looks up the matching Action row (same senderId + cawonce).
//   3. Confirms content matches — same field-by-field compare
//      resolveCawonceUsed uses (actionType + receiverId +
//      receiverCawonce + decompressed text).
//   4. Flips status: failed → done, reason: null.
//
// Does NOT touch rows whose Action row is absent (still legitimately
// awaiting indexer, or genuinely a different action used the slot)
// — those keep their failure marker. The DataCleaner sweep can
// continue to age them out normally.
//
// Also hides any ACTION_FAILED notifications attached to the
// recovered rows, since the failure was misreported.
//
// Usage:
//   cd client
//   npx tsx scripts/recover-falsely-failed-txqueue.ts          # run for real
//   npx tsx scripts/recover-falsely-failed-txqueue.ts --dry    # show what we'd flip
//   npx tsx scripts/recover-falsely-failed-txqueue.ts --hours=24  # window (default: 12h)

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import SmlTxt from 'smltxt'

const prisma = new PrismaClient()

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry') || args.has('--dry-run')
const hoursArg = process.argv.find(a => a.startsWith('--hours='))
const windowHours = hoursArg ? Number(hoursArg.split('=')[1]) : 12

let _smlTxt: SmlTxt | undefined
function smlTxt(): SmlTxt {
  if (!_smlTxt) _smlTxt = SmlTxt.fromPkg()
  return _smlTxt
}
function decompressActionText(textField: unknown): string {
  if (typeof textField !== 'string' || !textField || textField === '0x') return ''
  const hex = textField.startsWith('0x') ? textField.slice(2) : textField
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return ''
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  try { return smlTxt().decompress(bytes) } catch { return '' }
}

async function main() {
  console.log(`[recover-falsely-failed] dryRun=${dryRun} window=${windowHours}h`)

  const candidates = await prisma.txQueue.findMany({
    where: {
      status: 'failed',
      reason: 'Cawonce already used',
      updatedAt: { gte: new Date(Date.now() - windowHours * 60 * 60 * 1000) },
    },
    select: { id: true, senderId: true, cawonce: true, payload: true },
    orderBy: { id: 'asc' },
  })
  console.log(`  found ${candidates.length} candidate rows`)

  let recovered = 0
  let notRecoverable = 0
  let contentMismatch = 0

  for (const row of candidates) {
    const data = (row.payload as any)?.data
    if (!data || row.cawonce == null) {
      notRecoverable++
      continue
    }

    const existingAction = await prisma.action.findFirst({
      where: { senderId: row.senderId, cawonce: row.cawonce },
    })
    if (!existingAction) {
      notRecoverable++
      continue
    }

    const ex = existingAction.data as any
    const dataTextPlain = decompressActionText(data.text)

    // STRICT match: every field the user signed must match what's on
    // chain. resolveCawonceUsed in the validator does the lighter
    // 4-field check (type + receiver + text), but for an irreversible
    // failed→done flip we want to be paranoid — checking amounts and
    // recipients catches the case where someone re-signed the same
    // cawonce slot with a different tip / withdrawal amount.
    //
    // The contract bitmap is per-cawonce: at most ONE action ever
    // lands at (senderId, cawonce). If the on-chain action's fields
    // ALL match the submitted payload, the TxQueue's signed action
    // IS the on-chain action — safe to flip done. If anything diverges
    // (even amounts), the TxQueue carries a different signed payload
    // and was legitimately rejected by the chain because someone else
    // (different device, different tip) won the slot.
    const arraysEqual = (a: any, b: any): boolean => {
      const aa = Array.isArray(a) ? a.map(String) : []
      const bb = Array.isArray(b) ? b.map(String) : []
      if (aa.length !== bb.length) return false
      return aa.every((v, i) => v === bb[i])
    }
    const sameClient = Number(ex?.clientId ?? -1) === Number(data.clientId ?? -1)
    const sameAction =
      sameClient &&
      Number(ex?.actionType ?? -1) === Number(data.actionType) &&
      Number(ex?.receiverId ?? -1) === Number(data.receiverId ?? 0) &&
      Number(ex?.receiverCawonce ?? -1) === Number(data.receiverCawonce ?? 0) &&
      (ex?.text ?? '') === dataTextPlain &&
      arraysEqual(ex?.amounts, data?.amounts) &&
      arraysEqual(ex?.recipients, data?.recipients)

    if (!sameAction) {
      contentMismatch++
      console.log(`  TxQueue ${row.id} (senderId=${row.senderId} cawonce=${row.cawonce}): on-chain Action has DIFFERENT content — leaving failed`)
      continue
    }

    console.log(`  TxQueue ${row.id} (senderId=${row.senderId} cawonce=${row.cawonce}): on-chain Action matches → ${dryRun ? 'WOULD' : 'will'} flip to done`)
    if (!dryRun) {
      await prisma.txQueue.update({
        where: { id: row.id },
        data: { status: 'done', reason: null },
      })
      // Hide any ACTION_FAILED notifications that pointed at this row.
      // Use updateMany so missing-notification is a no-op (Cawonce already used
      // suppresses notification creation in markTxQueueFailed, but earlier
      // failure paths predating that suppression may have left some).
      await prisma.notification.updateMany({
        where: {
          type: 'ACTION_FAILED',
          userId: row.senderId,
          actionPayload: { path: ['originalTxQueueId'], equals: row.id },
        },
        data: { hidden: true },
      })
    }
    recovered++
  }

  console.log('')
  console.log(`[recover-falsely-failed] summary:`)
  console.log(`  recovered     : ${recovered}`)
  console.log(`  content diff  : ${contentMismatch} (left failed — different action at this cawonce)`)
  console.log(`  no Action row : ${notRecoverable} (left failed — legitimately unresolved)`)
  console.log(`  total scanned : ${candidates.length}`)

  await prisma.$disconnect()
}

main().catch(err => {
  console.error('[recover-falsely-failed] error:', err)
  process.exit(1)
})
