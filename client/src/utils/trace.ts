// Thin custom-span helper. Use for service-internal hot paths that auto-
// instrumentation doesn't see — validator simulation, action processing
// loops, batch handlers. HTTP routes, Prisma queries, Redis pub/sub, and
// outbound RPC calls already have spans from the auto-instrumentation; don't
// double-wrap those.
//
// No-op safe when OTel is disabled — @opentelemetry/api returns a NoopTracer
// whose spans cost basically nothing, so leaving span() calls in disabled
// installs has no performance impact.

import { trace, SpanStatusCode, type Span, type Attributes } from '@opentelemetry/api'

const tracer = trace.getTracer('caw-services')

/**
 * Wrap an async function in a span. Records exceptions automatically.
 *
 *   await span('validator.simulate', { batch: rows.length }, async (s) => {
 *     const result = await simulate(rows)
 *     s.setAttribute('rejected', result.rejections.length)
 *     return result
 *   })
 */
export async function span<T>(
  name: string,
  attrsOrFn: Attributes | ((s: Span) => Promise<T>),
  maybeFn?: (s: Span) => Promise<T>,
): Promise<T> {
  const attrs = typeof attrsOrFn === 'function' ? undefined : attrsOrFn
  const fn = typeof attrsOrFn === 'function' ? attrsOrFn : maybeFn!

  return tracer.startActiveSpan(name, { attributes: attrs }, async (s) => {
    try {
      const result = await fn(s)
      s.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err: any) {
      s.recordException(err)
      s.setStatus({ code: SpanStatusCode.ERROR, message: err?.message })
      throw err
    } finally {
      s.end()
    }
  })
}
