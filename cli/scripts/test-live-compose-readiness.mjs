// Run on a disposable Linux Docker host with 127.0.0.1:5432 and :6543 free.
// node scripts/test-live-compose-readiness.mjs (from cli)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { probeDatabase } from '../src/steps/ensureManualSql.js'

const docker = process.env.PATH.split(':').map(p => path.resolve(p, 'docker')).find(p => fs.existsSync(p))
assert(docker, 'Docker CLI required')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-readiness-'))
const project = 'caw-readiness-' + randomBytes(6).toString('hex')
const password = randomBytes(24).toString('hex')
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, POSTGRES_PASSWORD: password }
for (const key of Object.keys(env)) if (key.startsWith('PG') || ['DOCKER_CONTEXT','DOCKER_HOST','COMPOSE_FILE'].includes(key)) delete env[key]
const image = process.env.CAW_TEST_POSTGRES_IMAGE || 'postgres:16-alpine'
const compose = (...args) => execFileSync(docker, ['--host','unix:///var/run/docker.sock','compose',...args], { cwd:dir, env, stdio:'pipe',timeout:90000 })
const writePort = port => fs.writeFileSync(path.join(dir,'compose.yaml'), JSON.stringify({services:{postgres:{
  image, environment:{POSTGRES_PASSWORD:'${POSTGRES_PASSWORD:?required}'}, ports:[`127.0.0.1:${port}:5432`],
  healthcheck:{test:['CMD','pg_isready','-U','postgres'],interval:'1s',timeout:'3s',retries:40}
}}}))
function check(label, secret, expected, expectedQueries) {
  let queries = 0, missingHostClient = false
  const run = (program,args,opts) => {
    if (program === 'docker' && (args.includes('run') || args.includes('exec'))) queries++
    try { return execFileSync(program,args,{...opts, env:{...env,PGPASSWORD:opts.env.PGPASSWORD,PATH:dir}}) }
    catch (e) { if(program==='psql' && e.code==='ENOENT') missingHostClient=true; throw e }
  }
  const result=probeDatabase(`postgresql://postgres:${secret}@127.0.0.1:5432/postgres`, dir, 3000, run)
  assert.equal(missingHostClient,true,label)
  assert.equal(result,expected,label)
  assert.equal(queries,expectedQueries,label)
  console.log('PASS',label,'container SQL attempts',queries)
}
try {
  fs.symlinkSync(docker,path.join(dir,'docker'))
  writePort(5432)
  compose('up','-d','--wait','--wait-timeout','60')
  check('matching configured and running port',password,true,1)
  check('wrong password on matching port','wrong-'+password,false,1)
  writePort(6543)
  check('configured port differs from URI',password,false,0)
  compose('up','-d','--wait','--wait-timeout','60')
  writePort(5432)
  check('running port differs from configuration',password,false,0)
} finally {
  try { compose('down','-v','--remove-orphans') }
  finally { fs.rmSync(dir,{recursive:true,force:true}) }
}
