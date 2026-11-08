/**
 * Regression guard for the passive-auth replay hijack in POST /api/actions.
 *
 * An action signature is public once it lands in L2 calldata. If the route
 * authorizes the caller's x-session-token for the owner BEFORE it knows the
 * request is a new action, an attacker replays a victim's past action with
 * their own session token and that session becomes authorized as the victim
 * (even when no cookie or `auth` body is returned to them).
 *
 * The route needs a database and an L2 RPC, so this test checks the source
 * structure that keeps the fix in place:
 *   1. Sessions are only created / authorized inside grantPassiveAuth().
 *   2. In the single-action handler, grantPassiveAuth() runs only after the
 *      TxQueue row was created and after every replay / dedup early return.
 *   3. It is gated on cawonceUnusedOnChain(), which fails closed.
 *   4. The x-session-token header is not read before that point.
 */

import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '../../../src/api/routes/actions.ts'), 'utf8')

function functionBody(name: string): string {
  const start = src.indexOf(`async function ${name}(`)
  expect(start, `${name} must exist`).to.be.greaterThan(-1)
  // Body ends at the first top-level closing brace.
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end)
}

const handlerStart = src.indexOf("router.post('/', async")
const handlerEnd = src.indexOf("router.post('/batch'")
const handler = src.slice(handlerStart, handlerEnd)

describe('POST /api/actions passive auth (replay hijack guard)', () => {
  it('finds the single-action handler', () => {
    expect(handlerStart).to.be.greaterThan(-1)
    expect(handlerEnd).to.be.greaterThan(handlerStart)
  })

  it('creates and authorizes sessions only inside grantPassiveAuth', () => {
    const helper = functionBody('grantPassiveAuth')
    const outside = src.replace(helper, '')
    // Ignore the import line.
    const calls = (s: string, fn: string) => (s.match(new RegExp(`\\b${fn}\\(`, 'g')) || []).length
    expect(calls(helper, 'addAuthorization')).to.be.greaterThan(0)
    expect(calls(outside, 'addAuthorization'), 'addAuthorization outside helper').to.equal(0)
    expect(calls(outside, 'createSession'), 'createSession outside helper').to.equal(0)
  })

  it('grants passive auth only after the TxQueue row is created and all replay/dedup returns', () => {
    const grantAt = handler.indexOf('grantPassiveAuth(')
    expect(grantAt, 'handler must call grantPassiveAuth').to.be.greaterThan(-1)
    expect(handler.indexOf('grantPassiveAuth(', grantAt + 1), 'single call site').to.equal(-1)

    const createAt = handler.indexOf('tx.txQueue.create(')
    expect(createAt).to.be.greaterThan(-1)
    expect(grantAt).to.be.greaterThan(createAt)

    for (const marker of [
      'Duplicate submission for txQueue',
      "error: 'cawonce_collision'",
      'Duplicate content guard',
      'err.retryConflict',
      'Too many actions waiting for deposit',
      'Too many actions waiting for session registration',
    ]) {
      const at = handler.lastIndexOf(marker)
      expect(at, `marker "${marker}" must exist`).to.be.greaterThan(-1)
      expect(grantAt, `grantPassiveAuth must come after "${marker}"`).to.be.greaterThan(at)
    }

    // And before the success response.
    expect(grantAt).to.be.lessThan(handler.indexOf('res.status(201)'))
  })

  it('gates passive auth on an on-chain unused-cawonce check', () => {
    const grantAt = handler.indexOf('grantPassiveAuth(')
    const window = handler.slice(Math.max(0, grantAt - 200), grantAt)
    expect(window).to.contain('cawonceUnusedOnChain(data.senderId, data.cawonce)')
  })

  it('requires a verified signer (no parked or fail-open session check)', () => {
    const grantAt = handler.indexOf('grantPassiveAuth(')
    const window = handler.slice(Math.max(0, grantAt - 200), grantAt)
    expect(window).to.contain('signerVerified &&')
    // signerVerified starts as isOwner and is only set true by a non-fail-open session check.
    expect(handler).to.contain('let signerVerified = isOwner')
    expect(handler).to.contain('signerVerified = sessionCheck.unverified !== true')
    const sets = handler.match(/(?<!let )signerVerified = /g) || []
    expect(sets.length, 'no other assignments').to.equal(1)
    // The fail-open branch of checkSessionKeyOnChain marks itself unverified.
    expect(src).to.contain('return { valid: true, unverified: true }')
  })

  it('cawonceUnusedOnChain asks CawActions.isCawonceUsed and fails closed', () => {
    const body = functionBody('cawonceUnusedOnChain')
    expect(body).to.contain('getCawActionsContract()')
    expect(body).to.contain('isCawonceUsed(senderId, cawonce)')
    const catchAt = body.indexOf('catch')
    expect(catchAt).to.be.greaterThan(-1)
    expect(body.slice(catchAt)).to.contain('return false')
  })

  it('does not read x-session-token before the action is enqueued', () => {
    const createAt = handler.indexOf('tx.txQueue.create(')
    expect(handler.slice(0, createAt)).to.not.contain("'x-session-token'")
  })
})
