// Paces the requests the frontend sends to the node's /api/translate.
//
// The node answers 30 requests a minute per IP and refuses the rest with a
// 429. With auto-translate on, every post on a page that is in another
// language sends its own request when the page loads, and a feed in several
// languages goes over the limit within seconds. The refused requests were then
// repeated into English, and a refusal showed nothing, so pressing Translate
// seemed to do nothing for up to a minute.
//
// Two kinds of request go through here:
//
//   'user'  a translation the user asked for. It is sent at once, whatever is
//           waiting. If the node has just refused a request, it is not sent
//           (the node would refuse it too) and the caller is told how long the
//           limit lasts, so it can say so.
//
//   'auto'  a translation nobody asked for. It waits its turn: at most
//           MAX_IN_FLIGHT at a time, and at most AUTO_BUDGET sends in any
//           minute (the node's limit is 30; the rest is left for the requests
//           users make, other tabs and other devices behind the same
//           address). When the node refuses one anyway, all of them wait out
//           the Retry-After it sent and the refused one is tried again.

export type TranslatePriority = 'user' | 'auto'

/** The node's rate limit stopped the request. */
export class TranslateRateLimitedError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Translation is rate limited; retry in ${retryAfterSeconds}s`)
    this.name = 'TranslateRateLimitedError'
  }
}

/** The request was cancelled, or dropped from a full queue, before it was sent. */
export class TranslateCancelledError extends Error {
  constructor() {
    super('Translation request cancelled')
    this.name = 'TranslateCancelledError'
  }
}

export const WINDOW_MS = 60_000
export const AUTO_BUDGET = 20
export const MAX_IN_FLIGHT = 3
export const MAX_QUEUED = 100
export const MAX_AUTO_ATTEMPTS = 3
/**
 * Used when a 429 carries no Retry-After. The node's own limit always sends one;
 * one without it is nginx's general per-IP limit (a rate a second, 50 by
 * default), which lifts within seconds.
 */
export const DEFAULT_RETRY_AFTER_SECONDS = 5
const MAX_RETRY_AFTER_SECONDS = 120

interface Job {
  send: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
  attempts: number
}

let sentAt: number[] = []
let inFlight = 0
let pausedUntil = 0
let queue: Job[] = []
let timer: ReturnType<typeof setTimeout> | null = null

/** For tests: forget everything this module remembers. */
export function resetTranslateRequests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  sentAt = []
  inFlight = 0
  pausedUntil = 0
  queue = []
}

function isRateLimited(err: unknown): err is { status: number; retryAfterSeconds?: number } {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 429
}

function retryAfterOf(err: { retryAfterSeconds?: number }): number {
  const s = Number(err.retryAfterSeconds)
  if (!(s > 0)) return DEFAULT_RETRY_AFTER_SECONDS
  return Math.min(Math.ceil(s), MAX_RETRY_AFTER_SECONDS)
}

/** Sends one request now. A 429 starts the pause and is reported as TranslateRateLimitedError. */
async function sendNow<T>(send: () => Promise<T>): Promise<T> {
  inFlight++
  sentAt.push(Date.now())
  try {
    return await send()
  } catch (err) {
    if (isRateLimited(err)) {
      const seconds = retryAfterOf(err)
      pausedUntil = Math.max(pausedUntil, Date.now() + seconds * 1000)
      throw new TranslateRateLimitedError(seconds)
    }
    throw err
  } finally {
    inFlight--
    pump()
  }
}

function wakeAt(ms: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; pump() }, Math.max(ms, 0) + 5)
}

/** Starts the queued 'auto' requests that may start now, and sets a timer for the next one. */
function pump(): void {
  if (timer) { clearTimeout(timer); timer = null }
  while (queue.length > 0) {
    const now = Date.now()
    sentAt = sentAt.filter(t => now - t < WINDOW_MS)
    if (now < pausedUntil) return wakeAt(pausedUntil - now)
    if (inFlight >= MAX_IN_FLIGHT) return // a request that finishes calls pump again
    if (sentAt.length >= AUTO_BUDGET) return wakeAt(sentAt[0] + WINDOW_MS - now)
    start(queue.shift() as Job)
  }
}

function start(job: Job): void {
  job.signal?.removeEventListener('abort', job.onAbort as () => void)
  job.attempts++
  sendNow(job.send).then(job.resolve, err => {
    if (err instanceof TranslateRateLimitedError && job.attempts < MAX_AUTO_ATTEMPTS && !job.signal?.aborted) {
      queue.unshift(job) // refused: try it again once the pause is over
      enqueueAbort(job)
      pump()
      return
    }
    job.reject(err)
  })
}

function enqueueAbort(job: Job): void {
  if (!job.signal) return
  job.onAbort = () => {
    const i = queue.indexOf(job)
    if (i >= 0) {
      queue.splice(i, 1)
      job.reject(new TranslateCancelledError())
    }
  }
  job.signal.addEventListener('abort', job.onAbort, { once: true })
}

/**
 * Runs `send`, one request to the node, under the rules above. `signal` cancels
 * an 'auto' request that has not been sent yet.
 */
export function scheduleTranslateRequest<T>(
  send: () => Promise<T>,
  priority: TranslatePriority = 'user',
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new TranslateCancelledError())

  if (priority === 'user') {
    const wait = pausedUntil - Date.now()
    if (wait > 0) return Promise.reject(new TranslateRateLimitedError(Math.ceil(wait / 1000)))
    return sendNow(send)
  }

  return new Promise<T>((resolve, reject) => {
    if (queue.length >= MAX_QUEUED) {
      // the oldest is the one the page is most likely to have scrolled past
      const dropped = queue.shift() as Job
      dropped.signal?.removeEventListener('abort', dropped.onAbort as () => void)
      dropped.reject(new TranslateCancelledError())
    }
    const job: Job = { send, resolve: resolve as (v: unknown) => void, reject, signal, attempts: 0 }
    queue.push(job)
    enqueueAbort(job)
    pump()
  })
}
