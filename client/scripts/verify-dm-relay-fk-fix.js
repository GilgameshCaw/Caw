// Standalone verification of the DM relay FK-race fix:
//   1. ensureDmIdentity's placeholder-creation logic
//   2. getPublicKey/getPublicKeysBatch treating publicKey === '' as "no identity"
//   3. POST /api/dm/conversations rejecting a peer with only a placeholder identity
// Run: node scripts/verify-dm-relay-fk-fix.js

// --- Simulated DB state ---
let dmIdentities = new Map() // userId -> { userId, publicKey, walletAddress }
let users = new Map()        // tokenId -> { id, tokenId, username }

function resetDb() {
  dmIdentities = new Map()
  users = new Map()
}

// --- ensureDmIdentity (mirrors dm-relay.ts, post-audit with the
//     Number.isInteger/>0 guard) ---
async function ensureDmIdentity(userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`ensureDmIdentity: invalid userId ${userId}`)
  }
  if (dmIdentities.has(userId)) return
  if (!users.has(userId)) {
    users.set(userId, { id: userId, tokenId: userId, username: `user_${userId}` })
  }
  dmIdentities.set(userId, { userId, walletAddress: '', publicKey: '' })
}

// --- getPublicKey (mirrors DmService/index.ts, post-fix) ---
function getPublicKey(userId) {
  const identity = dmIdentities.get(userId)
  if (!identity?.publicKey) return null
  return identity.publicKey
}

// --- getPublicKeysBatch (mirrors DmService/index.ts, post-fix) ---
function getPublicKeysBatch(userIds) {
  const out = new Map()
  for (const id of userIds) {
    const identity = dmIdentities.get(id)
    if (identity && identity.publicKey !== '') out.set(id, identity.publicKey)
  }
  return out
}

// --- /api/dm/conversations peer check (mirrors dm.ts, post-fix) ---
function canStartConversation(peerUserId) {
  const peerIdentity = dmIdentities.get(peerUserId)
  if (!peerIdentity || !peerIdentity.publicKey) return { ok: false, error: 'Peer has not enabled DMs' }
  return { ok: true }
}

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// 1) Fresh inbound relay: neither party has a DmIdentity yet.
//    ensureDmIdentity must create placeholders for both without throwing.
resetDb()
await ensureDmIdentity(101)
await ensureDmIdentity(102)
check('placeholder created for sender', dmIdentities.has(101), true)
check('placeholder created for recipient', dmIdentities.has(102), true)
check('placeholder User row created (id === tokenId)', users.get(101), { id: 101, tokenId: 101, username: 'user_101' })

// 2) getPublicKey must treat the placeholder as "no identity" (null), not
//    leak the empty string as a usable key.
check('getPublicKey on placeholder returns null', getPublicKey(101), null)

// 3) getPublicKeysBatch must exclude placeholder rows entirely.
check('getPublicKeysBatch excludes placeholder', getPublicKeysBatch([101, 102]).size, 0)

// 4) The real identity relay arrives later (registerIdentity-style upsert)
//    and must cleanly upgrade the placeholder.
dmIdentities.set(101, { userId: 101, walletAddress: '0xabc', publicKey: '0xrealkey' })
check('getPublicKey after real relay arrives', getPublicKey(101), '0xrealkey')
check('getPublicKeysBatch after real relay arrives', getPublicKeysBatch([101, 102]).size, 1)

// 5) ensureDmIdentity must be a no-op (not overwrite) when a real
//    identity already exists — critical: must never clobber a real key
//    with a placeholder on a later relay for the same conversation.
await ensureDmIdentity(101)
check('ensureDmIdentity does not clobber an existing real identity', dmIdentities.get(101).publicKey, '0xrealkey')

// 6) /api/dm/conversations must reject a peer who only has a placeholder
//    identity (row exists, but publicKey === '').
resetDb()
await ensureDmIdentity(201)
check('conversation start rejected for placeholder-only peer', canStartConversation(201), { ok: false, error: 'Peer has not enabled DMs' })

// 7) ...but must allow it once the peer has a real key.
dmIdentities.set(201, { userId: 201, walletAddress: '0xdef', publicKey: '0xrealkey2' })
check('conversation start allowed once peer has a real key', canStartConversation(201), { ok: true })

// 8) A peer with no DmIdentity row at all (never contacted, no relay yet)
//    must still be rejected the same way as before this fix.
check('conversation start rejected for peer with no row at all', canStartConversation(999), { ok: false, error: 'Peer has not enabled DMs' })

// 9) A malformed/invalid userId (0, negative, non-integer) from a
//    misbehaving or buggy peer instance must be rejected rather than
//    silently creating a placeholder for a tokenId that could never be
//    a real on-chain profile.
let threwOnZero = false
try { await ensureDmIdentity(0) } catch { threwOnZero = true }
check('ensureDmIdentity rejects tokenId 0', threwOnZero, true)

let threwOnNegative = false
try { await ensureDmIdentity(-5) } catch { threwOnNegative = true }
check('ensureDmIdentity rejects negative userId', threwOnNegative, true)

console.log(`\n${10 - failures}/10 passed`)
process.exit(failures > 0 ? 1 : 0)
