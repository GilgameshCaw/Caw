#!/usr/bin/env node
/**
 * One-shot i18n fix: replace the hardcoded "Gemini" brand name in
 *   settings.ai_provider.get_key
 * across every locale with a {{provider}} placeholder, so the same key
 * works for OpenAI/Grok/etc. without adding new keys.
 *
 * Run from anywhere:
 *   node client/src/services/FrontEnd/scripts/i18n-provider-placeholder.mjs
 *
 * Idempotent — re-running is a no-op once every file already has the
 * placeholder. Preserves the existing JSON formatting (2-space indent,
 * trailing newline) so the diff stays small.
 */
import { promises as fs } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = path.resolve(__dirname, '../src/i18n/locales')
const KEY = 'settings.ai_provider.get_key'

// "Gemini" verbatim covers 21/22 locales. Hindi transliterates to
// "जेमिनी" (devanagari for "jemini"). Add more variants here if a
// future translator picks a different surface form.
const VARIANTS = ['Gemini', 'जेमिनी']

async function main() {
  const files = (await fs.readdir(LOCALES_DIR)).filter(f => f.endsWith('.json')).sort()
  let changed = 0
  let skipped = 0
  for (const file of files) {
    const full = path.join(LOCALES_DIR, file)
    const raw = await fs.readFile(full, 'utf8')
    const json = JSON.parse(raw)
    const before = json[KEY]
    if (typeof before !== 'string') {
      console.log(`-- ${file}: key missing, skipping`)
      skipped++
      continue
    }
    if (before.includes('{{provider}}')) {
      console.log(`-- ${file}: already has placeholder, skipping`)
      skipped++
      continue
    }
    let after = before
    for (const v of VARIANTS) {
      after = after.split(v).join('{{provider}}')
    }
    if (after === before) {
      console.log(`!! ${file}: no variant matched — manual review needed: "${before}"`)
      skipped++
      continue
    }
    json[KEY] = after
    // 2-space indent + trailing newline matches the existing file style.
    await fs.writeFile(full, JSON.stringify(json, null, 2) + '\n', 'utf8')
    console.log(`✓  ${file}: "${before}" → "${after}"`)
    changed++
  }
  console.log(`\nDone. changed=${changed}, skipped=${skipped}, total=${files.length}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
