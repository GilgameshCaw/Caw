/**
 * GET /api/notifications is behind requireAuth({ verifyOwnership: true }).
 * The CawAI watcher fetched it with no session, so every poll got 401.
 * It now signs in through POST /api/auth/verify with the bot owner's key
 * and sends the session as x-session-token.
 *
 * fetch is replaced by a fake mirror that applies the same message checks
 * as routes/auth.ts (prefix, Host, ChainId, freshness, one use per
 * signature) and answers 401 to a notifications request without a live
 * session. No network, DB or Redis.
 *
 * The watcher keeps one session token for the process, so the cases run
 * in order and build on each other.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { ethers } from 'ethers'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fetchNewMentions, endSession } from '../../../src/services/CawAI/mentionWatcher'
import type { CawAIConfig } from '../../../src/services/CawAI/config'

const OWNER_KEY = '0x' + '11'.repeat(32)
const OWNER = new ethers.Wallet(OWNER_KEY).address.toLowerCase()
const BOT = 4242
const API = 'http://mirror.test:8443'

const cfg = {
  profileTokenId: BOT,
  deployerPrivateKey: OWNER_KEY,
  apiUrl: API,
  chainId: 84532,
} as CawAIConfig

const mirror = {
  verifyStatus: 200,
  live: new Set<string>(),
  acceptNewSessions: true,
  usedSigs: new Set<string>(),
  signIns: 0,
  notificationCalls: 0,
  nextToken: 1,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  if (url.pathname === '/api/auth/verify' && init?.method === 'POST') {
    mirror.signIns++
    if (mirror.verifyStatus !== 200) return json(mirror.verifyStatus, { error: 'ownership not yet indexed' })
    const { message, signature } = JSON.parse(String(init.body))
    const lines = String(message).split('\n')
    if (lines[0] !== 'Verify wallet ownership for CAW') return json(400, { error: 'Invalid message format' })
    if (lines[1] !== `Host: ${url.host}`) return json(400, { error: 'Message host does not match this API origin' })
    if (lines[2] !== 'ChainId: 84532') return json(400, { error: 'Invalid chainId' })
    const age = Date.now() - Number(lines[3].slice('Timestamp: '.length)) * 1000
    if (!(age <= 5 * 60_000 && age >= -60_000)) return json(400, { error: 'expired' })
    if (ethers.verifyMessage(message, signature).toLowerCase() !== OWNER) return json(200, { sessionToken: 'x', authorizedTokenIds: [] })
    if (mirror.usedSigs.has(signature)) return json(400, { error: 'Signature already used. Please sign again.' })
    mirror.usedSigs.add(signature)
    const token = `t${mirror.nextToken++}`
    if (mirror.acceptNewSessions) mirror.live.add(token)
    return json(200, { sessionToken: token, authorizedTokenIds: [BOT] })
  }
  if (url.pathname === '/api/auth/logout' && init?.method === 'POST') {
    const token = new Headers(init.headers).get('x-session-token')
    if (token) mirror.live.delete(token)
    return json(200, { success: true })
  }
  if (url.pathname === '/api/notifications') {
    mirror.notificationCalls++
    const token = new Headers(init?.headers).get('x-session-token')
    if (!token || !mirror.live.has(token)) return json(401, { error: 'AUTH_REQUIRED' })
    expect(url.searchParams.get('userId')).to.equal(String(BOT))
    return json(200, {
      notifications: [
        { id: 7, type: 'MENTION', actor: { tokenId: 5, username: 'alice' }, caw: { id: 70, content: '@cawai gm' }, createdAt: '2026-10-28T00:00:00Z' },
      ],
    })
  }
  throw new Error(`unexpected request ${url}`)
}

describe('CawAI mentionWatcher: signs in for GET /api/notifications', () => {
  const realFetch = globalThis.fetch
  const realCwd = process.cwd()
  let dir = ''

  before(() => {
    globalThis.fetch = fakeFetch as typeof fetch
    // fetchNewMentions writes ./state/cawai-cursor.json.
    dir = mkdtempSync(path.join(tmpdir(), 'cawai-watcher-'))
    process.chdir(dir)
  })
  after(() => {
    globalThis.fetch = realFetch
    process.chdir(realCwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a 202 from sign-in is an error, and notifications are not requested', async () => {
    mirror.verifyStatus = 202
    let err: Error | undefined
    try { await fetchNewMentions(cfg, { lastSeenNotificationId: 0 }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/auth\/verify 202/)
    expect(mirror.notificationCalls).to.equal(0)
    mirror.verifyStatus = 200
  })

  it('a 401 right after a fresh sign-in is an error, without signing the same message again', async () => {
    mirror.acceptNewSessions = false
    const before = mirror.signIns
    let err: Error | undefined
    try { await fetchNewMentions(cfg, { lastSeenNotificationId: 0 }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/notifications fetch 401/)
    expect(mirror.signIns - before).to.equal(1)
    mirror.acceptNewSessions = true
  })

  it('a reused token that gets 401 is replaced by one new sign-in, and the mentions come back', async function () {
    // The previous case signed in a moment ago. A message signed in the
    // same second would be byte-identical and refused as already used;
    // between real polls (>= 60 s apart) that can't happen.
    this.timeout(5000)
    await new Promise(r => setTimeout(r, 1100))
    const before = mirror.signIns
    const { mentions, newCursor } = await fetchNewMentions(cfg, { lastSeenNotificationId: 0 })
    expect(mirror.signIns - before).to.equal(1)
    expect(mentions.map(m => m.notificationId)).to.deep.equal([7])
    expect(mentions[0]).to.include({ cawId: 70, cawText: '@cawai gm', authorTokenId: 5, authorUsername: 'alice' })
    expect(newCursor.lastSeenNotificationId).to.equal(7)
  })

  it('the next poll reuses the session', async () => {
    const before = mirror.signIns
    await fetchNewMentions(cfg, { lastSeenNotificationId: 7 })
    expect(mirror.signIns - before).to.equal(0)
  })

  it('endSession logs the session out on the mirror; the next poll signs in again', async function () {
    this.timeout(5000)
    expect(mirror.live.size).to.equal(1)
    await endSession(cfg)
    expect(mirror.live.size).to.equal(0)
    await endSession(cfg) // no session held: no request
    await new Promise(r => setTimeout(r, 1100)) // see the case above
    const before = mirror.signIns
    await fetchNewMentions(cfg, { lastSeenNotificationId: 7 })
    expect(mirror.signIns - before).to.equal(1)
    expect(mirror.live.size).to.equal(1)
  })
})
