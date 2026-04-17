// Fix TS2769 "No overload matches this call" on Express route handlers.
//
// Express's @types/express expects route handlers to return `void | Promise<void>`,
// but the common `return res.json(...)` pattern returns `Response`, making the
// handler's return type `Promise<Response | undefined>`. This is a well-known
// typing gap in Express v4/v5 + @types/express.
//
// This augmentation adds an overload that accepts `Promise<any>`, which is what
// our async handlers actually return. It's type-safe because Express ignores the
// return value of route handlers — only `next()` matters for error forwarding.
//
// Note: handlers that use middleware before the async handler (e.g.
// `router.get('/', requireAdmin, async (req, res) => ...)`) still trigger
// TS2769 because the mixed-type argument list doesn't match any single
// overload. These are safe to ignore — the runtime works fine.

import { Request, Response, NextFunction } from 'express'

declare module 'express-serve-static-core' {
  interface IRouterMatcher<T> {
    (
      path: PathParams,
      ...handlers: Array<(req: Request, res: Response, next: NextFunction) => Promise<any>>
    ): T
    (
      path: PathParams,
      ...handlers: Array<(req: Request<any, any, any, any>, res: Response, next?: NextFunction) => Promise<any>>
    ): T
  }
}
