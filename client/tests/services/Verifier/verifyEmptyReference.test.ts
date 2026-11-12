import { expect } from 'chai'
import http from 'node:http'
import {
  fetchReferenceManifest,
  verifyFrontend,
  type ManifestV1,
} from '../../../src/services/Verifier/src/verify'

// A reference manifest that lists no files must not count as "every file
// matched". verify.ts has no imports, so it runs here as it is.

async function serve(documents: Record<string, unknown>) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\//, '')
    if (path in documents) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(documents[path]))
    } else {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

const base = { version: 1, clientVersion: 'test', builtAt: '2026-01-01T00:00:00Z' }

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('Verifier: a reference with no files', () => {
  it('is refused when the reference manifest is read, as {} and as []', async () => {
    const s = await serve({
      'empty-object.json': { ...base, files: {} },
      'empty-array.json': { ...base, files: [] },
      'one-file.json': { ...base, files: { 'index.html': 'sha256-00' } },
    })
    try {
      expect(await messageOf(fetchReferenceManifest(`${s.url}/empty-object.json`))).to.equal('Reference manifest lists no files')
      expect(await messageOf(fetchReferenceManifest(`${s.url}/empty-array.json`))).to.equal('Reference manifest lists no files')
      const ok = await fetchReferenceManifest(`${s.url}/one-file.json`)
      expect(Object.keys(ok.files)).to.deep.equal(['index.html'])
    } finally {
      await s.close()
    }
  })

  it('does not pass any mirror when verifyFrontend is given one directly', async () => {
    // The mirror serves nothing at all; with nothing to compare, "ok" must still be false.
    const m = await serve({})
    try {
      for (const files of [{}, []]) {
        const empty = { ...base, files } as unknown as ManifestV1
        const report = await verifyFrontend(m.url, empty)
        expect(report.ok).to.equal(false)
        expect(report.summary).to.include({ matched: 0, mismatched: 0, missing: 0, errored: 0 })
      }
    } finally {
      await m.close()
    }
  })
})
