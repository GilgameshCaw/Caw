/**
 * Finalize this validator's own PENDING submissions straight from the archive
 * contract's state.
 *
 * autoFinalizeSubmissions() finds submissions by scanning SubmissionCreated
 * events from a stored checkpoint block. A validator whose checkpoint has
 * already moved past a still-pending submission (the earlier behaviour: a
 * submission scanned while inside its challenge period was skipped and the
 * checkpoint advanced past it) never sees that submission again, so its
 * pendingCount stays pinned at the cap. validatorSubmissions[submitter] holds
 * exactly the submitter's unfinalized submissions, so reading it does not
 * depend on the checkpoint and also recovers a validator that is already stuck.
 *
 * finalizeSubmission() swap-and-pops that array, so all ids are collected
 * before the first one is finalized. It is permissionless and requires
 * block.timestamp > finalizedAt (strict).
 */

export interface OwnSubmissionsReader {
  getValidatorSubmissionCount(addr: string): Promise<bigint | number>
  validatorSubmissions(addr: string, index: number): Promise<bigint | number>
  getSubmission(id: number): Promise<any>
}

export interface SubmissionFinalizer {
  finalizeSubmission(id: number): Promise<{ wait(): Promise<any> }>
}

export async function finalizeOwnPendingSubmissions(opts: {
  archive: OwnSubmissionsReader
  archiveW: SubmissionFinalizer
  self: string
  nowSec?: number
  log?: (msg: string) => void
  logError?: (msg: string) => void
}): Promise<number[]> {
  const { archive, archiveW, self } = opts
  const log = opts.log ?? ((m: string) => console.log(m))
  const logError = opts.logError ?? ((m: string) => console.error(m))
  const finalized: number[] = []

  let ids: number[] = []
  try {
    const n = Number(await archive.getValidatorSubmissionCount(self))
    for (let i = 0; i < n; i++) ids.push(Number(await archive.validatorSubmissions(self, i)))
  } catch (err: any) {
    logError(`[OptimisticReplication] Could not list own pending submissions: ${err?.shortMessage || err?.message}`)
    return finalized
  }

  for (const id of ids) {
    let sub: any
    try {
      sub = await archive.getSubmission(id)
    } catch {
      continue // could not read it this cycle; the next cycle looks again
    }
    if (Number(sub[6]) !== 0) continue // not PENDING (0=PENDING, 1=FINALIZED, 2=SLASHED)
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
    if (!(now > Number(sub[5]))) continue // challenge period still active (contract needs strict >)

    try {
      log(`[OptimisticReplication] Finalizing own pending submission ${id} from contract state...`)
      const tx = await archiveW.finalizeSubmission(id)
      await tx.wait()
      log(`[OptimisticReplication] Finalized own pending submission ${id}.`)
      finalized.push(id)
    } catch (err: any) {
      if (err?.reason?.includes('Not pending')) continue
      logError(`[OptimisticReplication] Failed to finalize own pending submission ${id}: ${err?.shortMessage || err?.message}`)
    }
  }
  return finalized
}
