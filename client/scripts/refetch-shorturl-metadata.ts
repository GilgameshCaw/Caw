// scripts/refetch-shorturl-metadata.ts
//
// Re-runs extractMetadata for ShortUrl rows that captured bad values.
// The common case (and the reason this script exists) is the
// "__CAW_PUBLIC_URL__" literal in imageUrl — when our own metadata
// fetcher was hitting nginx with a CAWBot UA that wasn't in the
// prerender-routing alternation, nginx served the static dist/index.html
// where the placeholder hadn't been substituted, and that placeholder
// ended up in the DB. The nginx fix (cawbot added to the UA matcher)
// stops new rows from getting this damage; this script repairs the
// already-stored ones.
//
// Usage:
//   npx tsx scripts/refetch-shorturl-metadata.ts                      # default filter
//   npx tsx scripts/refetch-shorturl-metadata.ts --filter=placeholder # same as default
//   npx tsx scripts/refetch-shorturl-metadata.ts --filter=all         # every row
//   npx tsx scripts/refetch-shorturl-metadata.ts --dry-run            # don't write
//   npx tsx scripts/refetch-shorturl-metadata.ts --code=lPuXhk        # one specific code
//
// Idempotent — running twice in a row is fine.

import { prisma } from '../src/prismaClient'
import { extractMetadata } from '../src/api/routes/shorturl'

interface Args {
  filter: 'placeholder' | 'all'
  dryRun: boolean
  code: string | null
}

function parseArgs(): Args {
  const args: Args = { filter: 'placeholder', dryRun: false, code: null }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true
    else if (arg.startsWith('--filter=')) {
      const v = arg.slice('--filter='.length)
      if (v === 'placeholder' || v === 'all') args.filter = v
      else throw new Error(`Unknown --filter value: ${v}`)
    } else if (arg.startsWith('--code=')) {
      args.code = arg.slice('--code='.length)
    } else {
      throw new Error(`Unknown arg: ${arg}`)
    }
  }
  return args
}

async function main() {
  const args = parseArgs()
  console.log(`[refetch-shorturl] filter=${args.filter} dryRun=${args.dryRun} code=${args.code ?? '*'}`)

  const where: any = args.code
    ? { code: args.code }
    : args.filter === 'placeholder'
      ? {
          OR: [
            { imageUrl: { contains: '__CAW_PUBLIC_URL__' } },
            { title: { contains: '__CAW_PUBLIC_URL__' } },
            { description: { contains: '__CAW_PUBLIC_URL__' } },
            { siteName: { contains: '__CAW_PUBLIC_URL__' } },
          ],
        }
      : {}

  const rows = await prisma.shortUrl.findMany({
    where,
    select: { code: true, originalUrl: true, title: true, description: true, imageUrl: true, siteName: true },
    orderBy: { createdAt: 'desc' },
  })

  console.log(`[refetch-shorturl] ${rows.length} candidate row(s)`)

  let updated = 0
  let skipped = 0
  let failed = 0

  for (const row of rows) {
    console.log(`\n  ${row.code}  →  ${row.originalUrl}`)
    console.log(`    before: title=${JSON.stringify(row.title)} image=${JSON.stringify(row.imageUrl)}`)

    let metadata: Awaited<ReturnType<typeof extractMetadata>>
    try {
      metadata = await extractMetadata(row.originalUrl)
    } catch (err: any) {
      console.log(`    FAILED: ${err?.message || err}`)
      failed++
      continue
    }

    // If extractMetadata returned nothing useful (404, SSRF block, timeout),
    // don't overwrite — keep the bad row visible so you can see it failed
    // rather than silently nulling everything. Re-run later if upstream comes
    // back. A row with the unsubstituted placeholder is still bad after this
    // but at least we didn't make it worse.
    if (!metadata.title && !metadata.description && !metadata.imageUrl && !metadata.siteName) {
      console.log(`    SKIP: extractMetadata returned nothing (origin unreachable or SSRF-blocked)`)
      skipped++
      continue
    }

    // Also skip if the new value would re-introduce the same placeholder
    // (means the nginx fix hasn't deployed yet on this host).
    const stillBroken = [metadata.title, metadata.description, metadata.imageUrl, metadata.siteName]
      .some(v => typeof v === 'string' && v.includes('__CAW_PUBLIC_URL__'))
    if (stillBroken) {
      console.log(`    SKIP: new metadata still contains __CAW_PUBLIC_URL__ — deploy nginx fix first`)
      skipped++
      continue
    }

    console.log(`    after:  title=${JSON.stringify(metadata.title)} image=${JSON.stringify(metadata.imageUrl)}`)

    if (!args.dryRun) {
      await prisma.shortUrl.update({
        where: { code: row.code },
        data: {
          title: metadata.title ?? null,
          description: metadata.description ?? null,
          imageUrl: metadata.imageUrl ?? null,
          siteName: metadata.siteName ?? null,
        },
      })
    }
    updated++
  }

  console.log(`\n[refetch-shorturl] done. updated=${updated} skipped=${skipped} failed=${failed}${args.dryRun ? ' (dry-run, no writes)' : ''}`)
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
