/**
 * Per-address serial send queue + replacement-underpriced retry.
 *
 * THE PROBLEM this solves: on a single-operator deploy the SAME wallet
 * (0xF713… on test2) is the validator signer AND the Quick-Sign session
 * registrar AND the sponsor relayer. When two of those fire concurrently,
 * ethers auto-assigns each the same "pending" nonce, and the second tx comes
 * back `REPLACEMENT_UNDERPRICED` ("replacement transaction underpriced") — it's
 * silently dropped. On test2 this is exactly why Quick-Sign registration
 * intermittently failed ("Something went wrong"), forcing every Pop-B action
 * onto the passkey path.
 *
 * THE FIX: funnel every send from a given address through an in-process promise
 * chain so they execute strictly one-at-a-time (no two grabbing the same
 * nonce). If a collision still slips through (e.g. an external tx from the same
 * key, or a node restart mid-flight), retry with a bumped gas price.
 *
 * Scope: in-memory, per-process. Sufficient because the validator + sessions +
 * sponsor all run in the SAME node process. A multi-process operator would need
 * the DB-backed lock (see challengeLock.ts) — out of scope here; the real
 * mainnet answer is separate keys per role (tracked on the mainnet checklist).
 */

// One tail promise per lowercased address. New sends chain off the tail, so
// they run in submission order and never overlap.
const chains = new Map<string, Promise<unknown>>()

/**
 * Run `fn` exclusively with respect to other enqueued work for `address`.
 * Serializes the *whole* send→wait, so nonce N+1 isn't requested until N has
 * been broadcast and its nonce consumed.
 */
export function withWalletLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const key = address.toLowerCase()
  const prev = chains.get(key) ?? Promise.resolve()
  // Swallow the predecessor's rejection so one failed send doesn't poison the
  // chain for everyone behind it — each caller still gets its own result.
  const run = prev.catch(() => {}).then(fn)
  chains.set(key, run)
  // Clean the map entry once this is the tail and it settles, to avoid leaking
  // a resolved promise per address forever (negligible, but tidy).
  run.finally(() => { if (chains.get(key) === run) chains.delete(key) }).catch(() => {})
  return run
}

/** ethers/RPC error codes + messages that mean "nonce collided, safe to retry". */
function isReplacementUnderpriced(err: any): boolean {
  const code = err?.code
  if (code === 'REPLACEMENT_UNDERPRICED' || code === 'NONCE_EXPIRED') return true
  const msg = (err?.shortMessage || err?.reason || err?.message || '').toLowerCase()
  return (
    msg.includes('replacement transaction underpriced') ||
    msg.includes('replacement fee too low') ||
    (msg.includes('nonce') && msg.includes('too low'))
  )
}

/**
 * Send a tx (serialized per-address) with retry on the replacement-underpriced
 * / nonce-too-low class of collisions.
 *
 * `send()` should perform ONE contract call / sendTransaction and return the tx
 * response (the thing with `.hash`). The serialization (one in-flight send per
 * address) is what actually prevents the collision — two sends never request
 * the same pending nonce. The retry is a belt-and-suspenders for the rare case
 * a collision still slips through (an external tx from the same key, a restart
 * mid-flight): we simply re-invoke `send()`, and because the prior tx has now
 * settled, the provider hands back a fresh, higher pending nonce + re-estimated
 * gas — so the replacement lands cleanly.
 *
 * @param address  the sending wallet address (lock key)
 * @param send     () => Promise<txResponse>
 * @param opts.maxRetries  collision retries (default 4)
 */
export async function sendSerialized<T extends { hash: string }>(
  address: string,
  send: () => Promise<T>,
  opts: { maxRetries?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4
  return withWalletLock(address, async () => {
    let lastErr: any
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await send()
      } catch (err: any) {
        lastErr = err
        if (!isReplacementUnderpriced(err) || attempt === maxRetries) throw err
        // Wait a beat so the prior tx's nonce settles in the mempool / the
        // provider returns a fresh higher pending nonce, then re-send.
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
      }
    }
    throw lastErr
  })
}
