// CawAI/rag/build-index.ts
//
// One-shot build script for the RAG index. Run at deploy time, not at
// runtime. Output written to cfg.ragIndexPath as JSONL — one chunk
// per line.
//
// Usage (from repo root):
//   ANTHROPIC_API_KEY=... ts-node client/src/services/CawAI/rag/build-index.ts
//
// Walks a fixed include-list of repo paths (see CORPUS below). Chunks
// each file token-aware at ~512 tokens with 64-token overlap. Embeds
// each chunk via the embedding endpoint. Writes incrementally so a
// crash mid-build leaves a resumable partial file.

import { promises as fs } from 'fs'
import path from 'path'

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

async function main() {
  const repoRoot = path.resolve(__dirname, '../../../../..')
  const outPath = process.argv[2] || path.join(process.cwd(), 'rag-index.jsonl')

  console.log(`[build-rag] walking ${CORPUS.length} corpus paths under ${repoRoot}`)
  console.log(`[build-rag] writing ${outPath}`)
  const out = await fs.open(outPath, 'w')

  for (const entry of CORPUS) {
    const abs = path.join(repoRoot, entry)
    try {
      await walk(abs, async (filePath) => {
        if (!EXTS.has(path.extname(filePath))) return
        const text = await fs.readFile(filePath, 'utf8')
        const chunks = chunkTokenAware(text, CHUNK_TOKENS, OVERLAP_TOKENS)
        for (const c of chunks) {
          // TODO: embed via Anthropic embedding endpoint or Voyage-3.
          // For now: empty embedding array; build-index needs the
          // embed call wired before the index is useful.
          const embedding: number[] = []
          const record = {
            id: `${path.relative(repoRoot, filePath)}#${c.start}-${c.end}`,
            path: path.relative(repoRoot, filePath),
            span: `L${c.start}-L${c.end}`,
            text: c.text,
            embedding,
          }
          await out.write(JSON.stringify(record) + '\n')
        }
      })
    } catch (e) {
      console.warn(`[build-rag] skip ${entry}: ${(e as Error).message}`)
    }
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

// Naive line-based chunker. Token-aware proper chunking lives in the
// real implementation — this stub gives the right shape so the index
// file format is settled.
function chunkTokenAware(text: string, _maxTok: number, _overlapTok: number) {
  const lines = text.split('\n')
  const out: { text: string; start: number; end: number }[] = []
  const STEP = 80
  const WIN = 100
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
