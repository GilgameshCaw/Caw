import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { ensurePostgresDatabase, probeDatabase } from '../src/steps/ensureManualSql.js'

test('readiness queries the selected database through libpq with routing overrides intact', () => {
  for (const route of ['host=other', 'hostaddr=192.0.2.1', 'port=5432&port=6432', 'service=managed', 'sslmode=verify-full', 'dbname=other']) {
    let calls = 0
    const run = (command, args, options) => {
      calls++
      assert.equal(command, 'psql')
      assert.ok(args.includes('postgresql://reader@localhost/selected?' + route))
      assert.equal(args.at(-1), 'SELECT 1')
      assert.equal(options.timeout, 800)
      return '1\n'
    }
    assert.equal(probeDatabase('postgresql://reader@localhost/selected?' + route + '&pool_timeout=2', '.', 800, run), true)
    assert.equal(calls, 1)
  }
})

test('readiness requires the expected SQL result and rejects failed authentication', () => {
  const url = 'postgresql://reader:first@localhost/selected?password=final&host=managed'
  for (const out of ['','0\n', '1\n1\n', null]) {
    let calls = 0
    assert.equal(probeDatabase(url, '.', 100, (command, args, options) => {
      calls++
      assert.equal(command, 'psql')
      assert.equal(options.env.PGPASSWORD, 'final')
      assert.ok(args.includes('postgresql://reader@localhost/selected?host=managed'))
      if (out === null) throw Error('credential refused')
      return out
    }), false)
    assert.equal(calls, 1)
  }
  assert.throws(() => probeDatabase(url, '.', 100, () => {throw Object.assign(Error(), {code:'ENOENT'})}), /on this host/)
})

test('Docker fallback requires matching project and running-container port bindings', {skip:process.platform!=='linux'}, () => {
  const id='1'.repeat(64)
  const url='postgresql://reader:sample@127.0.0.1:5432/caw'
  for(const [name, published, livePort, liveIp, ids, expected] of [
    ['matching port', '5432','5432','127.0.0.1',id,true],
    ['wildcard on IPv4','5432','5432','0.0.0.0',id,true],
    ['different published port','6543','5432','127.0.0.1',id,false],
    ['stale container','5432','6543','127.0.0.1',id,false],
    ['different address','5432','5432','127.0.0.2',id,false],
    ['no running container','5432','5432','127.0.0.1','',false],
    ['ambiguous replicas','5432','5432','127.0.0.1',id+'\n'+'2'.repeat(64),false]
  ]){
    let queries=0
    const run=(cmd,args,options)=>{
      if(cmd==='psql')throw Object.assign(Error(),{code:'ENOENT'})
      assert.equal(cmd,'docker')
      assert.deepEqual(args.slice(0,2),['--host','unix:///var/run/docker.sock'])
      const sub=args.slice(2)
      if(sub[1]==='config')return JSON.stringify({services:{postgres:{ports:[{target:5432,published,protocol:'tcp'}]}}})
      if(sub[1]==='ps')return ids
      if(sub[0]==='inspect')return JSON.stringify([{HostPort:livePort,HostIp:liveIp}])
      assert.deepEqual(sub.slice(0,5),['exec','-e','PGPASSWORD',id,'psql'])
      assert.equal(options.env.PGPASSWORD,'sample')
      assert.equal(sub.at(-1),'SELECT 1')
      queries++;return '1\n'
    }
    assert.equal(probeDatabase(url,'.',1000,run),expected,name)
    assert.equal(queries,expected?1:0,name)
  }
})

function recordingPsql(exists) {
  const calls = []
  return {
    calls,
    run(command, args, options) {
      calls.push({ command, args, options })
      return calls.length === 1 ? exists : 'CREATE DATABASE\n'
    },
  }
}

test('skips the default or unspecified database', () => {
  for (const url of [undefined, 'postgresql://localhost', 'postgresql://localhost/postgres?schema=public']) {
    assert.deepEqual(ensurePostgresDatabase(url, assert.fail), { status: 'skipped' })
  }
})

test('leaves an existing per-domain database in place', () => {
  const psql = recordingPsql('1\n')
  const result = ensurePostgresDatabase('postgresql://operator@localhost:5432/caw_test1_caw_social', psql.run)
  assert.deepEqual(result, { status: 'present', database: 'caw_test1_caw_social' })
  assert.equal(psql.calls.length, 1)
  assert.equal(psql.calls[0].args.at(-1), 'postgresql://operator@localhost:5432/postgres')
})

test('checks the UTF-8 byte limit before invoking psql', () => {
  for (const name of ['a'.repeat(64), 'é'.repeat(32)]) {
    assert.throws(() => ensurePostgresDatabase('postgresql://localhost/' + encodeURIComponent(name), assert.fail), /63-byte/)
  }
  const name = 'é'.repeat(31) + 'a'
  assert.deepEqual(ensurePostgresDatabase('postgresql://localhost/' + encodeURIComponent(name), recordingPsql('1').run), { status: 'present', database: name })
})

test('rejects ambiguous service and explicit password before invoking psql', () => {
  assert.throws(() => ensurePostgresDatabase('postgresql://operator:sample@localhost/caw?service=local', assert.fail), { code: 'CAW_DB_CONFIG' })
})

test('passes a custom name separately and retains libpq connection options', () => {
  const psql = recordingPsql('')
  const url = 'postgresql://reviewer@first:5432,second:5432/O%27Brien%20Archive' +
    '?schema=public&sslmode=verify-full&sslrootcert=/certs/root.crt&connection_limit=4'
  const result = ensurePostgresDatabase(url, psql.run)
  assert.deepEqual(result, { status: 'created', database: "O'Brien Archive" })
  assert.deepEqual(psql.calls.map(call => call.options.input), [
    "SELECT 1 FROM pg_database WHERE datname = :'target_db';\n",
    'CREATE DATABASE :"target_db";\n',
  ])
  for (const { command, args, options } of psql.calls) {
    assert.equal(command, 'psql')
    assert.equal(options.shell, undefined)
    assert.ok(args.includes("target_db=O'Brien Archive"))
    assert.equal(args.at(-1), 'postgresql://reviewer@first:5432,second:5432/postgres?sslmode=verify-full&sslrootcert=/certs/root.crt')
  }
})

test('the URI password is decoded only into the psql child environment', () => {
  const psql = recordingPsql('1\n')
  const original = process.env.PGPASSWORD
  ensurePostgresDatabase('postgresql://reviewer:sample%3Aone%2Btwo@localhost/caw', psql.run)
  const { args, options } = psql.calls[0]
  assert.equal(args.at(-1), 'postgresql://reviewer@localhost/postgres')
  assert.ok(args.every(arg => !arg.includes('sample')))
  assert.ok(options.env.PGPASSWORD === 'sample:one+two')
  assert.ok(process.env.PGPASSWORD === original)
})

test('a query password takes precedence and no credential enters arguments or SQL', () => {
  const psql = recordingPsql('')
  const uri = 'postgresql://reviewer:sample-one@localhost/caw?' +
    'password=sample-two&%70assword=sample%26three+four?five&application_name=installer'
  ensurePostgresDatabase(uri, psql.run)
  for (const { args, options } of psql.calls) {
    assert.equal(args.at(-1), 'postgresql://reviewer@localhost/postgres?application_name=installer')
    assert.ok(args.every(arg => !arg.includes('sample')))
    assert.ok(!options.input.includes('sample'))
    assert.ok(options.env.PGPASSWORD === 'sample&three+four?five')
  }
})

test('resolves an explicit libpq database option before connecting to postgres', () => {
  const psql = recordingPsql('1\n')
  const result = ensurePostgresDatabase('postgresql://localhost/?dbname=CAW+Archive&application_name=installer', psql.run)
  assert.deepEqual(result, { status: 'present', database: 'CAW+Archive' })
  assert.equal(psql.calls[0].args.at(-1), 'postgresql://localhost/postgres?application_name=installer')
})

test('a failed or inconclusive existence check never proceeds to creation', () => {
  let attempts = 0
  assert.throws(() => ensurePostgresDatabase('postgresql://localhost/caw_example', () => {
    attempts++
    throw new Error('database unavailable')
  }), /database unavailable/)
  assert.equal(attempts, 1)
  const psql = recordingPsql('unexpected result')
  assert.throws(() => ensurePostgresDatabase('postgresql://localhost/caw_example', psql.run), /Unexpected database existence result/)
  assert.equal(psql.calls.length, 1)
})
test('delivers the TLS passphrase privately and removes the service file', () => {
  let file
  ensurePostgresDatabase('postgresql://localhost/archive?sslmode=verify-full&sslpassword=fixture%2Bvalue', (_, args, opts) => {
    file = opts.env.PGSERVICEFILE
    assert.equal(fs.readFileSync(file, 'utf8'), '[caw_tls]\nsslpassword=fixture+value\n')
    assert.ok(args.at(-1).includes('sslmode=verify-full&service=caw_tls'))
    assert.ok(!args.join(' ').includes('fixture'))
    return '1'
  })
  assert.equal(fs.existsSync(file), false)
})
