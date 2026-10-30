import { shrinkWindow } from './logRangeError'

/** The walk read `maxBlocks` blocks and still did not have enough events. */
export class WalkLimitError extends Error {
  constructor(public readonly covered: number, public readonly maxBlocks: number) {
    super(`walked ${covered} blocks back without enough events (limit ${maxBlocks})`)
    this.name = 'WalkLimitError'
  }
}

export interface WalkLogsBackwardOptions<T> {
  /** Highest block to read (inclusive). */
  latest: number
  /** Lowest block to read (inclusive). The walk never goes below it. */
  floor?: number
  /** Give up (throw WalkLimitError) once this many blocks, counted back from
   *  `latest`, have been read without `onWindow` saying it has enough. */
  maxBlocks?: number
  /** First window to try, in blocks. */
  chunk: number
  /** Reads one inclusive block range. May throw. */
  fetchWindow: (fromBlock: number, toBlock: number) => Promise<T[]>
  /** Called with each window's events, newest window first. Return true to stop. */
  onWindow: (events: T[]) => boolean
  /** Called when a window is rejected as too wide and the walk shrinks it. */
  onShrink?: (rejected: number, next: number) => void
}

/**
 * Walks block ranges backwards from `latest`, newest window first, until
 * `onWindow` says it has enough or the walk reaches `floor`. A window the RPC
 * rejects as too wide is retried on the same range with a smaller one (see
 * shrinkWindow), and the smaller size is kept for the rest of the walk. Any
 * other failure throws, so a caller never gets a result built from a partial
 * scan. With `maxBlocks`, a walk that has read that many blocks back without
 * enough events throws WalkLimitError instead of going on to the floor. Returns
 * the events oldest window first, and the window size it ended on.
 */
export async function walkLogsBackward<T>(o: WalkLogsBackwardOptions<T>): Promise<{ events: T[]; chunk: number }> {
  const floor = o.floor ?? 0
  let chunk = o.chunk
  let toBlock = o.latest
  let events: T[] = []
  for (;;) {
    let fromBlock = floor
    let got: T[] = []
    for (;;) {
      fromBlock = Math.max(floor, toBlock - chunk + 1)
      try {
        got = await o.fetchWindow(fromBlock, toBlock)
        break
      } catch (err) {
        const smaller = shrinkWindow(err, chunk)
        if (smaller === undefined) throw err
        o.onShrink?.(chunk, smaller)
        chunk = smaller
      }
    }
    events = [...got, ...events]
    if (o.onWindow(got) || fromBlock <= floor) break
    const covered = o.latest - fromBlock + 1
    if (o.maxBlocks !== undefined && covered >= o.maxBlocks) throw new WalkLimitError(covered, o.maxBlocks)
    toBlock = fromBlock - 1
  }
  return { events, chunk }
}
