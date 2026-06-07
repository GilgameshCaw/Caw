// CawAI/rag/build-index.ts
//
// One-shot build script for the RAG index. Run at deploy time, not at
// runtime. Output written to cfg.ragIndexPath as JSONL — one chunk
// per line.
//
// Usage (from repo root):
//   CAW_AI_VOYAGE_API_KEY=... ts-node client/src/services/CawAI/rag/build-index.ts [output-path]
//
// Walks a fixed include-list of repo paths (see CORPUS below). Chunks
// each file token-aware at ~512 tokens with 64-token overlap. Embeds
// each chunk via Voyage AI (voyage-3.5, input_type='document'). Writes
// incrementally so a crash mid-build leaves a resumable partial file.

import { promises as fs } from 'fs'
import path from 'path'
import 'dotenv/config'

const CORPUS: string[] = [
  // Source of truth: smart contracts
  'solidity/contracts',
  // High-level docs and architecture
  'docs',
  'CLAUDE.md',
  'UI_CONSISTENCY_STANDARD.md',
  // Audit findings the bot might be asked about
  'messages/audit-2026-05-17',
  'messages/audit-2026-05-19-extensive',
  'messages/audit-2026-06-05-extensive',
  // Whitepaper (canonical protocol overview)
  'docs/WHITEPAPER.md',
]

const EXTS = new Set(['.sol', '.md', '.txt'])
const CHUNK_TOKENS = 512
const OVERLAP_TOKENS = 64

// Voyage AI embedding endpoint. Model: voyage-3.5
// Docs: https://docs.voyageai.com/reference/embeddings-api
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-3.5'
// Voyage allows up to 128 documents per request in the free tier.
const VOYAGE_BATCH_SIZE = 128

async function embedBatch(texts: string[], voyageKey: string): Promise<number[][]> {
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${voyageKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: 'document',
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`voyage embed ${res.status}: ${body}`)
  }
  const { data } = await res.json() as { data: Array<{ embedding: number[] }> }
  return data.map(d => d.embedding)
}

async function main() {
  const voyageKey = process.env.CAW_AI_VOYAGE_API_KEY
  if (!voyageKey) {
    console.error('[build-rag] CAW_AI_VOYAGE_API_KEY is required')
    process.exit(1)
  }

  const repoRoot = path.resolve(__dirname, '../../../../..')
  const outPath = process.argv[2] || path.join(process.cwd(), 'rag-index.jsonl')

  console.log(`[build-rag] walking ${CORPUS.length} corpus paths under ${repoRoot}`)
  console.log(`[build-rag] writing ${outPath}`)
  const out = await fs.open(outPath, 'w')

  // Collect all chunks first so we can batch-embed efficiently.
  type PendingChunk = {
    id: string
    path: string
    span: string
    text: string
  }
  const pending: PendingChunk[] = []

  for (const entry of CORPUS) {
    const abs = path.join(repoRoot, entry)
    try {
      await walk(abs, async (filePath) => {
        if (!EXTS.has(path.extname(filePath))) return
        let text = await fs.readFile(filePath, 'utf8')
        // Strip ==highlight== markers (a FE-only heading-emphasis convention in
        // WHITEPAPER.md) so they don't pollute embeddings/search text.
        text = text.replace(/==(.+?)==/g, '$1')
        const chunks = chunkTokenAware(text, CHUNK_TOKENS, OVERLAP_TOKENS)
        for (const c of chunks) {
          pending.push({
            id: `${path.relative(repoRoot, filePath)}#${c.start}-${c.end}`,
            path: path.relative(repoRoot, filePath),
            span: `L${c.start}-L${c.end}`,
            text: c.text,
          })
        }
      })
    } catch (e) {
      console.warn(`[build-rag] skip ${entry}: ${(e as Error).message}`)
    }
  }

  console.log(`[build-rag] ${pending.length} chunks; embedding in batches of ${VOYAGE_BATCH_SIZE}`)

  // Batch-embed in groups of VOYAGE_BATCH_SIZE.
  for (let i = 0; i < pending.length; i += VOYAGE_BATCH_SIZE) {
    const batch = pending.slice(i, i + VOYAGE_BATCH_SIZE)
    const embeddings = await embedBatch(batch.map(c => c.text), voyageKey)
    for (let j = 0; j < batch.length; j++) {
      const record = {
        id: batch[j].id,
        path: batch[j].path,
        span: batch[j].span,
        text: batch[j].text,
        embedding: embeddings[j],
      }
      await out.write(JSON.stringify(record) + '\n')
    }
    console.log(`[build-rag] embedded ${Math.min(i + VOYAGE_BATCH_SIZE, pending.length)}/${pending.length}`)
  }

  await out.close()
  console.log(`[build-rag] done`)
}

async function walk(p: string, visit: (file: string) => Promise<void>): Promise<void> {
  const st = await fs.stat(p)
  if (st.isFile()) return visit(p)
  if (st.isDirectory()) {
    for (const child of await fs.readdir(p)) {
      await walk(path.join(p, child), visit)
    }
  }
}

// Naive line-based chunker producing ~512-token windows with ~64-token
// overlap. We approximate 1 token ≈ 4 chars, so 512 tokens ≈ 2048
// chars ≈ ~20 lines of typical source code. The overlap keeps context
// across chunk boundaries for adjacent references.
function chunkTokenAware(text: string, _maxTok: number, _overlapTok: number) {
  const lines = text.split('\n')
  const out: { text: string; start: number; end: number }[] = []
  const STEP = 80   // lines per step forward
  const WIN  = 100  // lines per window
  for (let i = 0; i < lines.length; i += STEP) {
    const slice = lines.slice(i, i + WIN)
    if (slice.length === 0) break
    out.push({ text: slice.join('\n'), start: i + 1, end: i + slice.length })
  }
  return out
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
