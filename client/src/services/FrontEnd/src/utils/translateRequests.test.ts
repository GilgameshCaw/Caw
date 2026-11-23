/**
 * translateRequests: how the frontend paces its requests to the node's
 * /api/translate (30 a minute per IP). Time is faked; a request is a function
 * the test controls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  scheduleTranslateRequest,
  resetTranslateRequests,
  TranslateRateLimitedError,
  TranslateCancelledError,
  AUTO_BUDGET,
  MAX_IN_FLIGHT,
  MAX_QUEUED,
  MAX_AUTO_ATTEMPTS,
  WINDOW_MS,
  DEFAULT_RETRY_AFTER_SECONDS,
} from './translateRequests'

/** A request that finishes when the test says so. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** What apiFetch throws for a 429. */
const tooMany = (retryAfterSeconds?: number) =>
  Object.assign(new Error('API 429: Translation rate limit exceeded.'), { status: 429, retryAfterSeconds })

/** The outcome of a promise, without the test failing on a rejection. */
const outcome = <T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> =>
  p.then(value => ({ value }), (error: unknown) => ({ error }))

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => { vi.useFakeTimers(); resetTranslateRequests() })
afterEach(() => { resetTranslateRequests(); vi.useRealTimers() })

describe('a request the user asked for', () => {
  it('is sent at once and its answer passes through', async () => {
    const send = vi.fn().mockResolvedValue('ok')
    await expect(scheduleTranslateRequest(send, 'user')).resolves.toBe('ok')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('is the default priority', async () => {
    const send = vi.fn().mockResolvedValue('ok')
    await expect(scheduleTranslateRequest(send)).resolves.toBe('ok')
  })

  it('a failure that is not a 429 passes through and pauses nothing', async () => {
    await expect(scheduleTranslateRequest(() => Promise.reject(new Error('boom')), 'user')).rejects.toThrow('boom')
    const send = vi.fn().mockResolvedValue('next')
    await expect(scheduleTranslateRequest(send, 'user')).resolves.toBe('next')
  })

  it('is not held by the budget of the automatic ones', async () => {
    const autos = Array.from({ length: AUTO_BUDGET + 1 }, () => vi.fn().mockResolvedValue('a'))
    autos.forEach(s => void scheduleTranslateRequest(s, 'auto'))
    await tick()
    const user = vi.fn().mockResolvedValue('u')
    await expect(scheduleTranslateRequest(user, 'user')).resolves.toBe('u')
    expect(user).toHaveBeenCalledTimes(1)
  })

  it('a 429 is reported with the Retry-After, and the next one is not sent during the pause', async () => {
    const refused = vi.fn().mockRejectedValue(tooMany(12))
    const first = await outcome(scheduleTranslateRequest(refused, 'user'))
    expect(first.error).toBeInstanceOf(TranslateRateLimitedError)
    expect((first.error as TranslateRateLimitedError).retryAfterSeconds).toBe(12)

    const during = vi.fn().mockResolvedValue('x')
    await tick(5_000)
    const second = await outcome(scheduleTranslateRequest(during, 'user'))
    expect(second.error).toBeInstanceOf(TranslateRateLimitedError)
    expect((second.error as TranslateRateLimitedError).retryAfterSeconds).toBe(7)
    expect(during).not.toHaveBeenCalled()

    await tick(7_001)
    await expect(scheduleTranslateRequest(during, 'user')).resolves.toBe('x')
  })

  it('a 429 without a Retry-After pauses for the default, and a huge one is capped', async () => {
    const a = await outcome(scheduleTranslateRequest(() => Promise.reject(tooMany()), 'user'))
    expect((a.error as TranslateRateLimitedError).retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS)
    resetTranslateRequests()
    const b = await outcome(scheduleTranslateRequest(() => Promise.reject(tooMany(9999)), 'user'))
    expect((b.error as TranslateRateLimitedError).retryAfterSeconds).toBe(120)
  })

  it('a request already cancelled is not sent', async () => {
    const c = new AbortController()
    c.abort()
    const send = vi.fn()
    const r = await outcome(scheduleTranslateRequest(send, 'user', c.signal))
    expect(r.error).toBeInstanceOf(TranslateCancelledError)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('automatic requests', () => {
  it(`go at most ${MAX_IN_FLIGHT} at a time`, async () => {
    const jobs = Array.from({ length: 5 }, () => {
      const d = deferred<string>()
      return { d, send: vi.fn(() => d.promise) }
    })
    const results = jobs.map(j => scheduleTranslateRequest(j.send, 'auto'))
    await tick()
    expect(jobs.filter(j => j.send.mock.calls.length > 0)).toHaveLength(MAX_IN_FLIGHT)

    jobs[0].d.resolve('0')
    await tick()
    expect(jobs.filter(j => j.send.mock.calls.length > 0)).toHaveLength(MAX_IN_FLIGHT + 1)

    jobs.slice(1).forEach((j, i) => j.d.resolve(String(i + 1)))
    await tick()
    expect(await Promise.all(results)).toEqual(['0', '1', '2', '3', '4'])
  })

  it(`go at most ${AUTO_BUDGET} in a minute; the rest wait for the window to move on`, async () => {
    const sends = Array.from({ length: AUTO_BUDGET + 2 }, () => vi.fn().mockResolvedValue('r'))
    const results = sends.map(s => scheduleTranslateRequest(s, 'auto'))
    await tick()
    expect(sends.filter(s => s.mock.calls.length > 0)).toHaveLength(AUTO_BUDGET)

    await tick(WINDOW_MS - 1_000)
    expect(sends.filter(s => s.mock.calls.length > 0)).toHaveLength(AUTO_BUDGET)

    await tick(2_000)
    expect(sends.filter(s => s.mock.calls.length > 0)).toHaveLength(AUTO_BUDGET + 2)
    expect(await Promise.all(results)).toHaveLength(AUTO_BUDGET + 2)
  })

  it('a 429 pauses all of them for the Retry-After and the refused one is tried again', async () => {
    const a = vi.fn().mockRejectedValueOnce(tooMany(10)).mockResolvedValue('A')
    const pa = scheduleTranslateRequest(a, 'auto')
    await tick()
    expect(a).toHaveBeenCalledTimes(1)

    const b = vi.fn().mockResolvedValue('B')
    const pb = scheduleTranslateRequest(b, 'auto')
    await tick(9_000)
    expect(b).not.toHaveBeenCalled()
    expect(a).toHaveBeenCalledTimes(1)

    await tick(2_000)
    expect(await pa).toBe('A')
    expect(await pb).toBe('B')
    expect(a).toHaveBeenCalledTimes(2)
  })

  it(`give up after ${MAX_AUTO_ATTEMPTS} refusals, with the error`, async () => {
    const send = vi.fn().mockRejectedValue(tooMany(1))
    const settled = outcome(scheduleTranslateRequest(send, 'auto'))
    await tick(MAX_AUTO_ATTEMPTS * 2_000)
    const r = await settled
    expect(r.error).toBeInstanceOf(TranslateRateLimitedError)
    expect(send).toHaveBeenCalledTimes(MAX_AUTO_ATTEMPTS)
  })

  it('a failure that is not a 429 is not tried again', async () => {
    const send = vi.fn().mockRejectedValue(new Error('boom'))
    const r = await outcome(scheduleTranslateRequest(send, 'auto'))
    expect((r.error as Error).message).toBe('boom')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('one that is cancelled while it waits is rejected and never sent', async () => {
    const running = Array.from({ length: MAX_IN_FLIGHT }, () => deferred<string>())
    running.forEach(d => void scheduleTranslateRequest(() => d.promise, 'auto'))
    await tick()

    const c = new AbortController()
    const waiting = vi.fn().mockResolvedValue('w')
    const settled = outcome(scheduleTranslateRequest(waiting, 'auto', c.signal))
    c.abort()
    expect((await settled).error).toBeInstanceOf(TranslateCancelledError)

    running.forEach(d => d.resolve('done'))
    await tick(WINDOW_MS)
    expect(waiting).not.toHaveBeenCalled()
  })

  it('one that is refused and then cancelled during the pause is not tried again', async () => {
    const c = new AbortController()
    const send = vi.fn().mockRejectedValue(tooMany(30))
    const settled = outcome(scheduleTranslateRequest(send, 'auto', c.signal))
    await tick()
    expect(send).toHaveBeenCalledTimes(1)
    c.abort()
    expect((await settled).error).toBeInstanceOf(TranslateCancelledError)
    await tick(WINDOW_MS)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it(`a queue of ${MAX_QUEUED} drops its oldest waiting request for a new one`, async () => {
    const running = Array.from({ length: MAX_IN_FLIGHT }, () => deferred<string>())
    running.forEach(d => void scheduleTranslateRequest(() => d.promise, 'auto'))
    await tick()

    const waiting = Array.from({ length: MAX_QUEUED }, () => vi.fn().mockResolvedValue('w'))
    const settled = waiting.map(s => outcome(scheduleTranslateRequest(s, 'auto')))
    const newest = vi.fn().mockResolvedValue('new')
    const newestSettled = outcome(scheduleTranslateRequest(newest, 'auto'))

    expect((await settled[0]).error).toBeInstanceOf(TranslateCancelledError)
    running.forEach(d => d.resolve('done'))
    // 103 requests at 20 a minute
    await tick(7 * WINDOW_MS)
    expect(waiting[0]).not.toHaveBeenCalled()
    expect(waiting[1]).toHaveBeenCalled()
    expect((await newestSettled).value).toBe('new')
  })
})
