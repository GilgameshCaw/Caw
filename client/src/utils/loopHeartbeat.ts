// Reporting one iteration of a service loop to the runServices watchdog.
//
// The watchdog restarts a service whose loop has not reported within its
// timeout. A loop that reports only when an iteration succeeds looks dead
// while its upstream keeps failing (an RPC answering 402 or 429, say), and is
// restarted over and over although a restart does not fix the upstream.
// heartbeatDegraded exists for that case: the loop ran, it just could not make
// progress. The watchdog keeps such a loop alive, logs how long it has been
// stuck, and stops vouching for it after DEGRADED_ESCALATE_FACTOR times its
// timeout, so a restart still happens if the problem does not clear.

export interface LoopBeats {
  heartbeat(loopName?: string): void
  heartbeatDegraded(loopName?: string, reason?: string): void
}

/** A short, single-line reason for the watchdog log. */
export function stallReason(err: unknown): string {
  const e = err as any
  const text = String(e?.error?.message || e?.shortMessage || e?.message || err)
  return text.replace(/\s+/g, " ").slice(0, 160)
}

/**
 * Runs one iteration and reports it: heartbeat when it resolves,
 * heartbeatDegraded with the reason when it throws. The error is passed to
 * `onError` (for the loop own log line) and not rethrown, so the caller timer
 * keeps going. Returns true when the iteration succeeded.
 */
export async function runBeat(
  loopName: string,
  beats: LoopBeats,
  iteration: () => Promise<unknown>,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  try {
    await iteration()
  } catch (err) {
    try { onError?.(err) } catch { /* a failing log line must not hide the beat */ }
    beats.heartbeatDegraded(loopName, stallReason(err))
    return false
  }
  beats.heartbeat(loopName)
  return true
}
