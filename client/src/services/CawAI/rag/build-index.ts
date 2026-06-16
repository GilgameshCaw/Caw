// CawAI/rag/build-index.ts
//
// One-shot build script for the RAG index. Run at deploy time, not at
// runtime. Output written to the given path as JSONL — one chunk per line.
//
// Usage (from repo root):
//   ts-node client/src/services/CawAI/rag/build-index.ts [output-path]
//
// Corpus: every file tracked by `git ls-files` at the current HEAD in
// the repo root. Untracked files (.env, messages/, deploy-state, local
// scratch, the memory directory) are structurally excluded — git does
// not know about them.
//
// Only .sol, .md, and .txt extensions are embedded (same as before).
// Each file is chunked (~512 tokens with 64-token overlap, approximated
// as 100-line windows with 80-line steps). Every chunk passes through
// scrubChunk() before embedding; any flagged chunk halts the build.
//
// Embeddings are produced locally via @xenova/transformers
// (Xenova/bge-base-en-v1.5, 768-dim). No Voyage API key required.
//
// SCRUB ESCAPE HATCH
// Set SCRUB_REDACT_AND_CONTINUE=1 to replace flagged text with
// [REDACTED] and continue building rather than halting. Default: halt.
// This exists for CI environments where a known-safe redacted corpus is
// acceptable. Do NOT use in production without human review of
// SCRUB_REVIEW.txt first.

import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { embedTexts } from './embed'
import { scrubChunk } from './scrub'
import 'dotenv/config'

const EXTS = new Set(['.sol', '.md', '.txt'])

// SCRUB_REVIEW.txt holds the FULL text of every flagged chunk — i.e. it
// deliberately contains the very pseudonymity strings we're scrubbing. It must
// NEVER land in the repo tree: a committed copy would both leak directly AND be
// re-ingested by the next `git ls-files` corpus build (it ends in .txt). So we
// write it to the OS temp dir, outside the working tree entirely.
const SCRUB_REVIEW_PATH = path.join(os.tmpdir(), `cawai-scrub-review-${process.pid}.txt`)

// Belt-and-suspenders against self-reinfection: even if a RAG build artifact
// somehow becomes git-tracked, these patterns exclude it from the corpus so it
// can never feed its own (potentially leaked) content back into the index.
const CORPUS_EXCLUDE = [
  /(^|\/)cawai-scrub-review-.*\.txt$/,
  /(^|\/)SCRUB_REVIEW\.txt$/,
  /(^|\/)cawai-rag-index\.jsonl$/,
  /(^|\/)rag-index\.jsonl$/,
]

// SENSITIVE-DOC exclusion. Unlike the scrub gate (which matches a single
// string), some whole DOCUMENTS are sensitive in their entirety — security
// audits, threat models, pentest notes, vuln findings, internal design notes.
// The bot is public-facing: indexing these means anyone who asks a topically
// related question ("how do tips work") can pull a chunk that names a file:line
// auth bypass. Even a since-FIXED finding shouldn't be advertised to the world.
// These patterns drop such files from the corpus by path. Err toward exclusion:
// a missing internal doc costs the bot a little knowledge; an included one can
// leak an exploit recipe.
const SENSITIVE_DOC_EXCLUDE = [
  /AUDIT/i,
  /SECURITY/i,
  /\bVULN/i,
  /PENTEST/i,
  /THREAT[_-]?MODEL/i,
  /FINDINGS/i,
  /INCIDENT/i,
  /(^|\/)native\/docs\/.*NOTES/i,   // internal native-app design notes
]

type PendingChunk = {
  id: string
  path: string
  span: string
  text: string
}

async function main() {
  const repoRoot = path.resolve(__dirname, '../../../../..')
  const outPath = process.argv[2] || path.join(os.tmpdir(), 'cawai-rag-index.jsonl')
  const redactAndContinue = process.env.SCRUB_REDACT_AND_CONTINUE === '1'

  console.log(`[build-rag] repo root: ${repoRoot}`)
  console.log(`[build-rag] output:    ${outPath}`)
  console.log(`[build-rag] embedding: Xenova/bge-base-en-v1.5 (local, no API key)`)

  // ----------------------------------------------------------------
  // 1. Enumerate corpus: git ls-files (current tree only, no history).
  //    Untracked files are structurally excluded.
  // ----------------------------------------------------------------
  let gitFiles: string[]
  try {
    const raw = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' })
    gitFiles = raw.split('\n').filter(f => f.trim() !== '')
  } catch (e) {
    console.error('[build-rag] git ls-files failed:', (e as Error).message)
    process.exit(1)
  }

  // Filter to only the extensions we embed, excluding (a) our own RAG build
  // artifacts (CORPUS_EXCLUDE) so a stray tracked review/index file can never
  // re-enter the corpus, and (b) sensitive whole documents (SENSITIVE_DOC_EXCLUDE)
  // — security audits, threat models, findings — that must never be retrievable
  // by a public bot.
  const extEligible = gitFiles.filter(
    f => EXTS.has(path.extname(f)) && !CORPUS_EXCLUDE.some(re => re.test(f)),
  )
  const droppedSensitive = extEligible.filter(f => SENSITIVE_DOC_EXCLUDE.some(re => re.test(f)))
  const eligible = extEligible.filter(f => !SENSITIVE_DOC_EXCLUDE.some(re => re.test(f)))
  if (droppedSensitive.length > 0) {
    console.log(`[build-rag] excluded ${droppedSensitive.length} sensitive doc(s) from corpus:`)
    for (const f of droppedSensitive) console.log(`             - ${f}`)
  }
  console.log(`[build-rag] git-tracked files: ${gitFiles.length} total, ${eligible.length} eligible (${[...EXTS].join('/')})`)

  // ----------------------------------------------------------------
  // 2. Chunk all eligible files.
  // ----------------------------------------------------------------
  const pending: PendingChunk[] = []

  for (const relPath of eligible) {
    const absPath = path.join(repoRoot, relPath)
    let raw: string
    try {
      raw = await fs.readFile(absPath, 'utf8')
    } catch (e) {
      console.warn(`[build-rag] skip (unreadable) ${relPath}: ${(e as Error).message}`)
      continue
    }
    // Strip ==highlight== markers (FE heading-emphasis in WHITEPAPER.md).
    raw = raw.replace(/==(.+?)==/g, '$1')
    const chunks = chunkTokenAware(raw)
    for (const c of chunks) {
      pending.push({
        id: `${relPath}#${c.start}-${c.end}`,
        path: relPath,
        span: `L${c.start}-L${c.end}`,
        text: c.text,
      })
    }
  }

  console.log(`[build-rag] ${pending.length} chunks from ${eligible.length} files`)

  // ----------------------------------------------------------------
  // 3. Pseudonymity scrub gate.
  //    Any flagged chunk: write to SCRUB_REVIEW.txt and HALT (unless
  //    SCRUB_REDACT_AND_CONTINUE=1).
  // ----------------------------------------------------------------
  type FlaggedEntry = {
    path: string
    span: string
    matches: string[]
    text: string
  }
  const flagged: FlaggedEntry[] = []
  const cleanChunks: Array<PendingChunk & { textToEmbed: string }> = []

  for (const chunk of pending) {
    const result = scrubChunk(chunk.text, chunk.path)
    if (!result.clean) {
      flagged.push({
        path: chunk.path,
        span: chunk.span,
        matches: result.matches,
        text: chunk.text,
      })
      if (redactAndContinue) {
        cleanChunks.push({ ...chunk, textToEmbed: result.redacted })
      }
      // If not redactAndContinue, we collect all flagged entries first
      // before halting so the review file is complete.
    } else {
      cleanChunks.push({ ...chunk, textToEmbed: chunk.text })
    }
  }

  if (flagged.length > 0) {
    // Write SCRUB_REVIEW.txt regardless of redactAndContinue.
    const lines: string[] = [
      `SCRUB REVIEW — ${new Date().toISOString()}`,
      `${flagged.length} chunk(s) flagged for pseudonymity patterns.`,
      `Resolve each entry below, then re-run build-index.ts.`,
      ``,
    ]
    for (const entry of flagged) {
      lines.push(`--- ${entry.path} ${entry.span} ---`)
      lines.push(`MATCHED: ${entry.matches.join(', ')}`)
      lines.push(`TEXT:`)
      lines.push(entry.text)
      lines.push(``)
    }
    await fs.writeFile(SCRUB_REVIEW_PATH, lines.join('\n'), 'utf8')

    if (!redactAndContinue) {
      console.error(
        `[build-rag] HALTED — ${flagged.length} chunk(s) flagged for pseudonymity review.\n` +
        `  See: ${SCRUB_REVIEW_PATH}\n` +
        `  Resolve all flagged entries and re-run.\n` +
        `  To embed with redacted text instead, set SCRUB_REDACT_AND_CONTINUE=1.`
      )
      process.exit(1)
    }

    console.warn(
      `[build-rag] WARNING: ${flagged.length} chunk(s) flagged; ` +
      `SCRUB_REDACT_AND_CONTINUE=1 — embedding redacted text. ` +
      `Review ${SCRUB_REVIEW_PATH} before shipping.`
    )
  }

  // ----------------------------------------------------------------
  // 4. Embed clean (or redacted) chunks using local model.
  // ----------------------------------------------------------------
  console.log(`[build-rag] embedding ${cleanChunks.length} chunks via Xenova/bge-base-en-v1.5…`)

  const out = await fs.open(outPath, 'w')

  // Embed in batches so progress is visible and OOM risk on large corpora
  // is bounded (embedTexts processes one at a time internally but accepts
  // batches for future optimization).
  const BATCH_SIZE = 32
  for (let i = 0; i < cleanChunks.length; i += BATCH_SIZE) {
    const batch = cleanChunks.slice(i, i + BATCH_SIZE)
    const embeddings = await embedTexts(batch.map(c => c.textToEmbed), 'document')
    for (let j = 0; j < batch.length; j++) {
      const record = {
        id:        batch[j].id,
        path:      batch[j].path,
        span:      batch[j].span,
        text:      batch[j].textToEmbed,
        embedding: embeddings[j],
      }
      await out.write(JSON.stringify(record) + '\n')
    }
    const done = Math.min(i + BATCH_SIZE, cleanChunks.length)
    console.log(`[build-rag] embedded ${done}/${cleanChunks.length}`)
  }

  await out.close()
  console.log(`[build-rag] done — index written to ${outPath}`)
}

// Line-based chunker with small, heavily-overlapping windows. Small chunks
// keep each embedding vector focused on a single topic so a term-specific
// query (e.g. "optimistic archive") matches the chunk that defines it rather
// than being averaged out across 100 lines of unrelated content. The 50%
// overlap guarantees any line — and any term spanning a window boundary —
// appears whole in at least one chunk.
//
// ~18 lines ≈ 200-400 tokens of code/docs, comfortably under bge-base's
// 512-token limit. Empty/whitespace-only windows are skipped so blank runs
// between sections don't produce useless chunks.
function chunkTokenAware(text: string) {
  const lines = text.split('\n')
  const out: { text: string; start: number; end: number }[] = []
  const WIN  = 18
  const STEP = 9   // 50% overlap
  for (let i = 0; i < lines.length; i += STEP) {
    const slice = lines.slice(i, i + WIN)
    if (slice.length === 0) break
    const joined = slice.join('\n')
    if (joined.trim().length === 0) continue   // skip blank windows
    out.push({ text: joined, start: i + 1, end: i + slice.length })
    if (i + WIN >= lines.length) break          // last window reached EOF
  }
  return out
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
