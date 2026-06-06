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

export type IndexedChunk = {
  id: string
  path: string         // source file relative to repo root
  span: string         // e.g. "L120-L168"
  text: string
  embedding: number[]
}

export class RagIndex {
  private chunks: IndexedChunk[] = []

  async load(path: string): Promise<void> {
    void path
    // TODO: stream-read JSONL, push each parsed line into this.chunks
  }

  async search(queryEmbedding: number[], topK: number = 8): Promise<IndexedChunk[]> {
    void queryEmbedding; void topK
    // TODO: cosine sim against this.chunks, return top-K.
    return []
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
