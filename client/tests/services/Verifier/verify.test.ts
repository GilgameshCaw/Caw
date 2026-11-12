import { expect } from 'chai'
import http from 'node:http'
import { createHash } from 'node:crypto'
import {
  fetchReferenceManifest,
  normalizeMirrorUrl,
  verifyFrontend,
  type ManifestV1,
} from '../../../src/services/Verifier/src/verify'

// verify.ts is the code that decides "match" or "mismatch" for a mirror. It has
// no imports, so it runs here as it is, against small local mirrors.

const sha = (text: string) => 'sha256-' + createHash('sha256').update(text).digest('hex')

const FILES: Record<string, string> = {
  'index.html': '<html>app</html>',
  'assets/a.js': 'console.log("a")',
  'assets/b.js': 'console.log("b")',
}

function manifestOf(files: Record<string, string>): ManifestV1 {
  const listed: Record<string, string> = {}
  for (const [path, body] of Object.entries(files)) listed[path] = sha(body)
  return { version: 1, clientVersion: 'test', builtAt: '2026-01-01T00:00:00Z', files: listed }
}

type Handler = (path: string, res: http.ServerResponse) => boolean

// A mirror serving `files`; `custom` may answer a path itself (return true).
async function mirror(files: Record<string, string>, custom?: Handler) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\//, '')
    if (custom && custom(path, res)) return
    if (path in files) {
      res.writeHead(200)
      res.end(files[path])
    } else {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}`,
    // An answer the verifier gave up on can leave its connection open until it times out; close it now.
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

describe('Verifier verify.ts', () => {
  describe('normalizeMirrorUrl', () => {
    it('adds https to a bare host name and keeps only scheme, host and port', () => {
      expect(normalizeMirrorUrl('example.com')).to.equal('https://example.com')
      expect(normalizeMirrorUrl('https://example.com/some/path/')).to.equal('https://example.com')
      expect(normalizeMirrorUrl('  https://example.com:8443/x ')).to.equal('https://example.com:8443')
    })

    it('allows plain http for localhost only', () => {
      expect(normalizeMirrorUrl('http://localhost:8000')).to.equal('http://localhost:8000')
      expect(normalizeMirrorUrl('http://127.0.0.1:8000/')).to.equal('http://127.0.0.1:8000')
      expect(normalizeMirrorUrl('http://[::1]:8000')).to.equal('http://[::1]:8000')
    })

    it('refuses plain http for any other host, other schemes and an empty address', () => {
      expect(() => normalizeMirrorUrl('http://example.com')).to.throw(/https/)
      expect(() => normalizeMirrorUrl('http://192.168.1.10')).to.throw(/https/)
      expect(() => normalizeMirrorUrl('ftp://example.com')).to.throw(/Unsupported protocol: ftp:/)
      expect(() => normalizeMirrorUrl('   ')).to.throw(/Empty/)
    })

    it('is not fooled by names that only look like localhost, and drops credentials', () => {
      expect(() => normalizeMirrorUrl('http://localhost.example.com')).to.throw(/https/)
      expect(() => normalizeMirrorUrl('http://127.0.0.1.example.com')).to.throw(/https/)
      expect(() => normalizeMirrorUrl('http://localhost@evil.example.com')).to.throw(/https/)
      expect(normalizeMirrorUrl('https://user:secret@example.com/x')).to.equal('https://example.com')
    })
  })

  describe('verifyFrontend', () => {
    it('passes a mirror that serves exactly the listed files', async () => {
      const m = await mirror(FILES)
      try {
        const report = await verifyFrontend(m.url, manifestOf(FILES))
        expect(report.ok).to.equal(true)
        expect(report.summary).to.include({ matched: 3, mismatched: 0, missing: 0, errored: 0 })
      } finally {
        await m.close()
      }
    })

    it('reports a file that was changed', async () => {
      const m = await mirror({ ...FILES, 'assets/a.js': 'console.log("tampered")' })
      try {
        const report = await verifyFrontend(m.url, manifestOf(FILES))
        expect(report.ok).to.equal(false)
        expect(report.summary).to.include({ matched: 2, mismatched: 1 })
        expect(report.files.find((f) => f.status === 'mismatch')?.path).to.equal('assets/a.js')
      } finally {
        await m.close()
      }
    })

    it('reports a file the mirror does not serve as missing', async () => {
      const files = { ...FILES }
      delete files['assets/b.js']
      const m = await mirror(files)
      try {
        const report = await verifyFrontend(m.url, manifestOf(FILES))
        expect(report.ok).to.equal(false)
        expect(report.files.find((f) => f.status === 'missing')?.path).to.equal('assets/b.js')
      } finally {
        await m.close()
      }
    })

    it('fails a mirror that answers 404 for everything (nothing is skipped)', async () => {
      const m = await mirror({})
      try {
        const report = await verifyFrontend(m.url, manifestOf(FILES))
        expect(report.ok).to.equal(false)
        expect(report.summary.missing).to.equal(3)
      } finally {
        await m.close()
      }
    })

    it('fails a mirror that cannot be reached, with every file counted as errored', async () => {
      const m = await mirror(FILES)
      const url = m.url
      await m.close()
      const report = await verifyFrontend(url, manifestOf(FILES))
      expect(report.ok).to.equal(false)
      expect(report.summary).to.include({ errored: 3, matched: 0 })
    })

    it('does not read more than maxFileBytes of one file (declared or streamed)', async () => {
      const big = 'x'.repeat(5000)
      const m = await mirror(
        { 'index.html': FILES['index.html'], 'assets/a.js': big, 'assets/b.js': big },
        (path, res) => {
          if (path === 'assets/b.js') {
            // no content-length: sent in chunks, so only the byte count can stop it
            res.writeHead(200)
            res.write(big.slice(0, 2500))
            res.end(big.slice(2500))
            return true
          }
          return false
        },
      )
      try {
        const listed = manifestOf({ 'index.html': FILES['index.html'], 'assets/a.js': big, 'assets/b.js': big })
        const report = await verifyFrontend(m.url, listed, { maxFileBytes: 1000 })
        expect(report.ok).to.equal(false)
        const errored = report.files.filter((f) => f.status === 'error')
        expect(errored.map((f) => f.path).sort()).to.deep.equal(['assets/a.js', 'assets/b.js'])
        for (const f of errored) expect((f as { error: string }).error).to.equal('response is too large (over 1000 bytes)')
        expect(report.files.find((f) => f.path === 'index.html')?.status).to.equal('match')
      } finally {
        await m.close()
      }
    })

    it('refuses a file that declares more than the default limit, with a short message', async () => {
      // 40 MiB are declared but only one byte is sent: the answer has to be refused from the header alone.
      const m = await mirror(FILES, (path, res) => {
        if (path === 'assets/a.js') {
          res.writeHead(200, { 'content-length': String(40 * 1024 * 1024) })
          res.write('x')
          return true
        }
        return false
      })
      try {
        const report = await verifyFrontend(m.url, manifestOf(FILES))
        const a = report.files.find((f) => f.path === 'assets/a.js') as { status: string; error: string }
        expect(a.status).to.equal('error')
        expect(a.error).to.equal('response is too large (over 32 MiB)')
        expect(a.error.length).to.be.at.most(40) // what a table row shows
        expect(report.files.find((f) => f.path === 'assets/b.js')?.status).to.equal('match')
      } finally {
        await m.close()
      }
    })

    it('still verifies when the mirror\'s own build-manifest.json is far too large', async () => {
      const m = await mirror(FILES, (path, res) => {
        if (path === 'build-manifest.json') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"version":1,"files":{},"pad":"' + 'x'.repeat(3 * 1024 * 1024) + '"}')
          return true
        }
        return false
      })
      try {
        const report = await verifyFrontend(m.url, manifestOf(FILES))
        expect(report.ok).to.equal(true)
        expect(report.mirrorClientVersion).to.equal(undefined) // the oversized manifest was ignored
      } finally {
        await m.close()
      }
    })
  })

  describe('fetchReferenceManifest', () => {
    it('reads a valid reference manifest', async () => {
      const m = await mirror({ 'reference.json': JSON.stringify(manifestOf(FILES)) })
      try {
        const reference = await fetchReferenceManifest(`${m.url}/reference.json`)
        expect(reference.version).to.equal(1)
        expect(Object.keys(reference.files)).to.have.length(3)
      } finally {
        await m.close()
      }
    })

    it('refuses a reference of the wrong version, and one that is far too large', async () => {
      const m = await mirror({
        'v2.json': JSON.stringify({ ...manifestOf(FILES), version: 2 }),
        'huge.json': '{"version":1,"pad":"' + 'x'.repeat(3 * 1024 * 1024) + '"}',
      })
      try {
        let message = ''
        try {
          await fetchReferenceManifest(`${m.url}/v2.json`)
        } catch (error) {
          message = (error as Error).message
        }
        expect(message).to.match(/schema/)
        message = ''
        try {
          await fetchReferenceManifest(`${m.url}/huge.json`)
        } catch (error) {
          message = (error as Error).message
        }
        expect(message).to.equal('response is too large (over 2 MiB)')
      } finally {
        await m.close()
      }
    })
  })
})
