// Remembers that a scan gave up, so the next tick does not repeat it.
//
// A log walk that reaches its block limit without finding what it needs costs
// one RPC call per window (200,000 at the defaults on an RPC that caps the
// range at 200 blocks). Nothing it found is kept, so running it again on the
// next tick only repeats the cost.

export class ScanBackoff {
  private held = new Map<string, { until: number; limit: number }>()

  constructor(
    private readonly holdMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The scan under `key` gave up at `limit` blocks. */
  record(key: string, limit: number): void {
    this.held.set(key, { until: this.now() + this.holdMs, limit })
  }

  /**
   * Milliseconds left before `key` may be scanned again, or 0 when it may be
   * scanned now. A different `limit` than the one recorded (the operator
   * raised it) lifts the hold.
   */
  remaining(key: string, limit: number): number {
    const h = this.held.get(key)
    if (!h) return 0
    if (h.limit !== limit || this.now() >= h.until) {
      this.held.delete(key)
      return 0
    }
    return h.until - this.now()
  }

  /** The scan under `key` succeeded. */
  clear(key: string): void {
    this.held.delete(key)
  }
}
