// Quick local renderer for OG previews. Hits the same in-process
// satori pipeline the route uses, then writes a PNG to /tmp so we can
// open it without spinning up the full API.
//
// Usage: npx tsx scripts/render-og-preview.ts <cawId> [outPath]
import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { prisma } from '../src/prismaClient'

// We need to call the same private functions the route uses. Easiest
// path: import the module and pull out the exports we add for testing.
// To avoid editing the route file, copy the layout call inline here —
// kept short.
const W = 1200
const H = 630

async function main() {
  const id = Number(process.argv[2])
  const out = process.argv[3] || `/tmp/og-${id}.png`
  if (!Number.isFinite(id)) {
    console.error('Usage: render-og-preview.ts <cawId> [outPath]')
    process.exit(1)
  }

  // Force the route to render via direct satori call, but we can just
  // hit the route's render path by importing from og.ts. Easier: spin
  // a one-off Express app with just og mounted, request the png.
  const express = (await import('express')).default
  const app = express()
  app.use('/api/og', (await import('../src/api/routes/og')).default)
  const server = app.listen(0)
  const port = (server.address() as any).port

  const url = `http://127.0.0.1:${port}/api/og/image/caw/${id}`
  console.log('Fetching', url)
  const res = await fetch(url)
  if (!res.ok) {
    console.error('Render failed:', res.status, await res.text())
    server.close()
    process.exit(1)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(out, buf)
  console.log(`Wrote ${out} (${buf.length} bytes)`)
  server.close()
  await prisma.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
