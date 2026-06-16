// CawAI/rag/embed.ts
//
// Local embedding via @xenova/transformers (sentence-transformers-compatible).
// Model: Xenova/all-MiniLM-L6-v2, 384-dim output.
//
// Replaces the Voyage AI embedding call. No third-party key required.
// The pipeline is lazily loaded on first call and cached as a singleton
// so the model weights are only loaded once per process.
//
// inputType follows the sentence-transformers convention:
//   'document' — used at index-build time
//   'query'    — used at query time in claude.ts
//
// Note: @xenova/transformers must be installed in the runtime environment.
// It is a runtime dependency, not a devDependency, because build-index.ts
// and claude.ts both call embedTexts() in production.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipeline: any | null = null

// bge-base-en-v1.5 (768-dim) retrieves noticeably better than the smaller
// MiniLM-L6 (384-dim) on this code/docs corpus. It is an ASYMMETRIC retrieval
// model: queries must be prefixed with a fixed instruction, documents must NOT.
// Getting that prefix right is what makes query↔passage matching work.
const MODEL_NAME = 'Xenova/bge-base-en-v1.5'

// BGE's canonical query instruction. Prepended to query-side inputs only.
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

async function getPipeline() {
  if (_pipeline) return _pipeline
  // Dynamic import so the rest of the codebase compiles even when
  // @xenova/transformers is not yet installed (module-not-found is only
  // raised at runtime when embedTexts() is actually called).
  const { pipeline } = await import('@xenova/transformers')
  _pipeline = await pipeline('feature-extraction', MODEL_NAME, { quantized: true })
  return _pipeline
}

/**
 * Embed an array of texts using the local bge-base-en-v1.5 model.
 *
 * Returns one 768-dim unit-normalized float vector per input string.
 * The vectors are compatible with cosine similarity in search.ts (since
 * normalize=true, dot product == cosine sim).
 *
 * @param texts     Array of strings to embed.
 * @param inputType 'document' for corpus chunks (embedded verbatim), 'query'
 *                  for search queries (prefixed with the BGE query instruction).
 *                  This asymmetry is required for correct retrieval — unlike the
 *                  prior symmetric MiniLM setup, the parameter is now load-bearing.
 */
export async function embedTexts(
  texts: string[],
  inputType: 'document' | 'query',
): Promise<number[][]> {
  if (texts.length === 0) return []

  const pipe = await getPipeline()
  const prepared = inputType === 'query'
    ? texts.map(t => QUERY_PREFIX + t)
    : texts

  // Process one text at a time to avoid OOM on large batches; the pipeline
  // supports batch input but memory behaviour is unpredictable on constrained
  // hosts (e.g., the 5.9 GB VPS noted in the ZK path docs). Pooling+normalize
  // are passed per-call (the model is loaded without them).
  const results: number[][] = []
  for (const text of prepared) {
    const output = await pipe(text, { pooling: 'mean', normalize: true })
    // output.data is a Float32Array; convert to plain number[] for JSON
    // serialisation and for compatibility with search.ts's number[] type.
    results.push(Array.from(output.data as Float32Array))
  }
  return results
}
