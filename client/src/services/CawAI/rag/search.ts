// CawAI/rag/search.ts
//
// Cosine retrieval over the prebuilt RAG index.
//
// The index is a JSONL file at cfg.ragIndexPath (default
// ./rag-index.jsonl), with one record per chunk:
//   { id, path, span, text, embedding: number[] }
//
// At service start, the whole file is loaded into RAM (typical size
// ~5-30 MB for the CAW codebase). Query embeds the user's question,
// computes cosine sim against every chunk, returns top-K.
//
// Why not a real vector DB: the corpus is small (<50K chunks even
// with very fine-grained chunking), brute-force cosine on a single
// host runs in ~20ms. Adding a DB would mean another moving part for
// forkers to set up. JSONL + in-RAM cosine wins on simplicity.

import { createReadStream } from 'fs'
import { createInterface } from 'readline'

export type IndexedChunk = {
  id: string
  path: string         // source file relative to repo root
  span: string         // e.g. "L120-L168"
  text: string
  embedding: number[]
  _norm?: number       // precomputed L2 norm; not stored on disk
}

export class RagIndex {
  private chunks: IndexedChunk[] = []

  async load(filePath: string): Promise<void> {
    this.chunks = []
    // Stream the JSONL line-by-line so a large index (~30 MB) doesn't
    // require slurping the whole file at once before parsing starts.
    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      rl.on('line', (line) => {
        if (!line.trim()) return
        try {
          const chunk = JSON.parse(line) as IndexedChunk
          // Precompute L2 norm once at load time so search() doesn't
          // redo it per query.
          chunk._norm = l2Norm(chunk.embedding)
          this.chunks.push(chunk)
        } catch {
          // Malformed line — skip silently (partial write from a
          // crashed build-index run)
        }
      })
      rl.on('close', resolve)
      rl.on('error', reject)
    })
    console.log(`[RagIndex] loaded ${this.chunks.length} chunks from ${filePath}`)
  }

  search(queryEmbedding: number[], topK: number = 8): IndexedChunk[] {
    if (this.chunks.length === 0 || queryEmbedding.length === 0) return []

    const queryNorm = l2Norm(queryEmbedding)
    if (queryNorm === 0) return []

    // Score every chunk; keep a running top-K heap by brute force
    // (acceptable for <50K chunks — measured ~20ms on M1).
    const scored = this.chunks.map((c) => ({
      chunk: c,
      score: cosineSim(queryEmbedding, c.embedding, queryNorm, c._norm ?? l2Norm(c.embedding)),
    }))

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK).map(s => s.chunk)
  }

  // Concatenate top-K chunks into a single string for the Claude
  // prompt. Hard cap on total chars so a runaway retrieval can't
  // explode the prompt budget.
  formatForPrompt(chunks: IndexedChunk[], maxChars: number = 6000): string {
    let acc = ''
    for (const c of chunks) {
      const block = `// ${c.path} (${c.span})\n${c.text}\n\n`
      if (acc.length + block.length > maxChars) break
      acc += block
    }
    return acc.trim()
  }
}

function l2Norm(vec: number[]): number {
  let sum = 0
  for (const v of vec) sum += v * v
  return Math.sqrt(sum)
}

function cosineSim(a: number[], b: number[], aNorm: number, bNorm: number): number {
  if (aNorm === 0 || bNorm === 0) return 0
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) dot += a[i] * b[i]
  return dot / (aNorm * bNorm)
}
