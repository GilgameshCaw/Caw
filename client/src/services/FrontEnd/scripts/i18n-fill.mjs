#!/usr/bin/env node
// Fills missing keys (keys present in en.json but not in other locales)
// using Google Translate's public endpoint. {{vars}} are preserved.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = join(__dirname, '..', 'src', 'i18n', 'locales')
const GTX = 'https://translate.googleapis.com/translate_a/single'

const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'))

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

const files = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json') && f !== 'en.json' && f !== 'es.json')

for (const file of files) {
  const code = file.replace('.json', '')
  const path = join(LOCALES_DIR, file)
  const cat = JSON.parse(readFileSync(path, 'utf8'))
  const missing = Object.keys(en).filter(k => !k.startsWith('_') && !(k in cat))
  if (missing.length === 0) {
    console.log(`[${code}] ok`)
    continue
  }
  console.log(`[${code}] filling ${missing.length} keys...`)
  for (const key of missing) {
    try {
      const src = en[key]
      const tokens = []
      const masked = src.replace(/\{\{(\w+)\}\}/g, (_, n) => {
        tokens.push(n)
        return `__VAR${tokens.length - 1}__`
      })
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
}

console.log('done')
