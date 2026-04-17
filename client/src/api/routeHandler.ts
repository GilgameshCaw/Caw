import { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Wraps an async Express route handler so that:
 *   1. `return res.json(...)` early-returns are allowed without TS2769 ("No
 *      overload matches this call") — Express expects `void | Promise<void>`
 *      but `res.json()` returns `Response`, making the handler's return type
 *      `Promise<Response | undefined>`. The cast here absorbs that.
 *   2. Unhandled rejections are forwarded to Express's error handler via
 *      `next(err)` instead of crashing the process.
 *
 * Usage:
 *   router.get('/foo', asyncHandler(async (req, res) => {
 *     if (!req.query.id) return res.status(400).json({ error: 'missing id' })
 *     res.json({ ok: true })
 *   }))
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}
