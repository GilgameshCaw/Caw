#!/usr/bin/env node
// One-shot, SCOPED variant of i18n-fill.mjs: fills ONLY the AI-feature keys
// (post_form.ai.* and settings.ai_provider.*) that are missing in a locale.
// Same gtx endpoint, same {{var}} preservation, same missing-only / non-
// destructive behavior — it just never touches the rest of the backlog.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = join(__dirname, '..', 'src', 'i18n', 'locales')
const GTX = 'https://translate.googleapis.com/translate_a/single'

const isAiKey = k => k.startsWith('post_form.ai.') || k.startsWith('settings.ai_provider.')

const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'))
const aiKeys = Object.keys(en).filter(isAiKey)
console.log(`AI keys in en.json: ${aiKeys.length}`)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function translate(text, tl) {
  if (!text.trim()) return text
  const url = `${GTX}?client=gtx&sl=en&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${tl}`)
  const data = await res.json()
  if (!Array.isArray(data?.[0])) throw new Error('Bad shape')
  return data[0].map(seg => Array.isArray(seg) ? seg[0] : '').filter(s => typeof s === 'string').join('')
}

// Same as the official script: en.json is source, es.json is curated — skip both.
const files = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json') && f !== 'en.json')

for (const file of files) {
  const code = file.replace('.json', '')
  const path = join(LOCALES_DIR, file)
  const cat = JSON.parse(readFileSync(path, 'utf8'))
  const missing = aiKeys.filter(k => !(k in cat))
  if (missing.length === 0) { console.log(`[${code}] ok (already has all AI keys)`); continue }
  console.log(`[${code}] filling ${missing.length} AI keys...`)
  for (const key of missing) {
    try {
      const src = en[key]
      const tokens = []
      const masked = src.replace(/\{\{(\w+)\}\}/g, (_, n) => { tokens.push(n); return `__VAR${tokens.length - 1}__` })
      let out = masked.trim() ? await translate(masked, code) : src
      out = out.replace(/__VAR(\d+)__/g, (_, i) => `{{${tokens[Number(i)]}}}`)
      cat[key] = out
      await sleep(60)
    } catch (err) {
      console.error(`[${code}] ${key}: ${err.message} — keeping EN`)
      cat[key] = en[key]
    }
  }
  writeFileSync(path, JSON.stringify(cat, null, 2) + '\n')
  console.log(`[${code}] done`)
}
console.log('ALL DONE')
