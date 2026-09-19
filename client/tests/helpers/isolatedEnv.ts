/**
 * Side-effect-only module: import it FIRST in any test that loads the API app
 * (createApp), so importing the app cannot touch production services.
 *
 * Importing src/api/server starts singletons at import time (Elasticsearch
 * connect + full sync, Redis clients), so the isolation has to happen before
 * that import, not in a mocha hook.
 */
const dbUrl = process.env.DATABASE_URL ?? ''
if (!/\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(dbUrl)) {
  throw new Error('refusing to load the API app: DATABASE_URL must point at a caw_test_* database')
}

// Nothing may reach the node's real Elasticsearch or Redis db 0.
process.env.ELASTICSEARCH_NODE = 'http://127.0.0.1:1' // connection refused, instantly
delete process.env.ELASTICSEARCH_API_KEY
process.env.ES_INDEX_PREFIX = 'caw_test'
process.env.REDIS_URL = 'redis://127.0.0.1:6379/15'

export {}
