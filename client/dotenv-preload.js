// Pre-loaded via `node -r ./dotenv-preload.js`. Has to be a separate file,
// not just an early line in start.ts, because TypeScript/ESM hoists `import`
// statements above sibling `require()` calls — putting the dotenv call at
// the top of start.ts didn't actually run it before the OTel import. The
// -r flag, by contrast, runs strictly before the entry script, so by the
// time start.ts (and therefore otel.ts via its import) executes,
// process.env is already populated.
//
// dotenv.config() with no args reads .env from process.cwd(). pm2's
// ecosystem sets cwd to client/, which is where .env lives — match that.
require('dotenv').config()
