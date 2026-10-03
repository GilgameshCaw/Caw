export function parseUsernameDriftReconcileIntervalMinutes(
  raw: string | undefined,
): number {
  if (raw == null || raw.trim() === '') return 60

  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 60
  return n
}

export function shouldReconcileUsernameDrift(
  now: number,
  lastRun: number,
  intervalMs: number,
): boolean {
  if (intervalMs <= 0) return false
  if (lastRun <= 0) return true
  return now - lastRun >= intervalMs
}
