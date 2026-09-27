// Verifies utils/dataCleanerLogger.ts and utils/scheduledPostLogger.ts:
//
//   rollover     the file follows the UTC date of each line, not the date the
//                process started (both loggers are module-level singletons)
//   write error  a stream error (here: the day's file path is a directory)
//                doesn't take the process down
//
// Each case runs the real module in its own child process with a pinned clock
// and a throwaway working directory, because the loggers open their file at
// import time under process.cwd()/logs.
//
// Run (from client/): npx tsx scripts/verify-daily-log-rollover.ts [path-to-utils-dir]
// The optional path runs the same checks against another copy of the two
// loggers (e.g. the pre-fix versions) to confirm they fail there.

import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'url'

const LOGGERS = [
  { file: 'dataCleanerLogger.ts', exportName: 'dataCleanerLogger', stem: 'data-cleaner' },
  { file: 'scheduledPostLogger.ts', exportName: 'scheduledPostLogger', stem: 'scheduled-posts' },
]
const DAY1 = '2026-09-25'
const DAY2 = '2026-09-26'

async function child() {
  const [, , , mode, modPath, exportName, stem, dir] = process.argv
  process.chdir(dir)
  const RealDate = Date
  let now = RealDate.parse(`${DAY1}T23:59:59.000Z`)
  ;(globalThis as any).Date = class extends RealDate {
    constructor(...args: any[]) { if (args.length) super(...(args as [any])); else super(now) }
    static now() { return now }
  }
  if (mode === 'error') fs.mkdirSync(path.join(dir, 'logs', `${stem}-${DAY1}.log`), { recursive: true })
  const mod = await import(pathToFileURL(modPath).href)
  const logger = mod[exportName]
  logger.log('line-on-day1')
  now = RealDate.parse(`${DAY2}T00:00:01.000Z`)
  logger.log('line-on-day2')
  await new Promise(r => setTimeout(r, 300))
  logger.close()
  await new Promise(r => setTimeout(r, 100))
  console.log('CHILD-ALIVE')
}

let failures = 0
function check(label: string, pass: boolean, detail: string) {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> ${detail}`)
}

function run(mode: string, modPath: string, exportName: string, stem: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logroll-'))
  const r = spawnSync(process.execPath, [...process.execArgv, __filename, '--child', mode, modPath, exportName, stem, dir], {
    encoding: 'utf8', env: { ...process.env, TZ: 'UTC' },
  })
  return { dir, alive: (r.stdout || '').includes('CHILD-ALIVE'), status: r.status }
}

async function main() {
  const utilsDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../src/utils')
  console.log(`loggers: ${utilsDir}`)
  for (const l of LOGGERS) {
    const modPath = path.join(utilsDir, l.file)

    const a = run('rollover', modPath, l.exportName, l.stem)
    const read = (d: string) => { const f = path.join(a.dir, 'logs', `${l.stem}-${d}.log`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }
    const d1 = read(DAY1), d2 = read(DAY2)
    check(`${l.file}: day-1 line in ${l.stem}-${DAY1}.log`, !!d1 && d1.includes('line-on-day1') && !d1.includes('line-on-day2'), d1 === null ? 'file missing' : JSON.stringify(d1.trim().split('\n').map(x => x.slice(-12))))
    check(`${l.file}: day-2 line in ${l.stem}-${DAY2}.log`, !!d2 && d2.includes('line-on-day2'), d2 === null ? 'file missing' : JSON.stringify(d2.trim().split('\n').map(x => x.slice(-12))))

    const b = run('error', modPath, l.exportName, l.stem)
    check(`${l.file}: process survives a log write error`, b.alive, `exit=${b.status} alive=${b.alive}`)
  }
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv[2] === '--child') child().catch(e => { console.error(e); process.exit(3) })
else main().catch(e => { console.error(e); process.exit(2) })
