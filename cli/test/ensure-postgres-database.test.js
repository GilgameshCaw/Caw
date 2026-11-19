import assert from 'node:assert/strict'
import test from 'node:test'
import { ensurePostgresDatabase } from '../src/steps/ensureManualSql.js'

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
