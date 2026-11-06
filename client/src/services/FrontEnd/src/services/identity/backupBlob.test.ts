import { describe, it, expect, vi, beforeEach } from 'vitest'

const argon2 = vi.hoisted(() => ({ broken: false }))

// Deterministic while it works, and throws the error seen from argon2-browser's
// embedded WASM when it can't load.
vi.mock('argon2-browser', () => ({
  ArgonType: { Argon2id: 2 },
  hash: vi.fn(async ({ pass, salt }: { pass: string; salt: Uint8Array }) => {
    if (argon2.broken) throw new Error("Failed to execute 'atob': string not correctly encoded")
    const data = new Uint8Array([...new TextEncoder().encode(pass), ...salt])
    return { hash: new Uint8Array(await crypto.subtle.digest('SHA-256', data)) }
  }),
}))
vi.mock('~/utils/secureContext', () => ({ requireSecureCrypto: () => {} }))

import { encryptBackupBlob, decryptBackupBlob } from './backupBlob'
import { Argon2UnavailableError } from './vaultPassword'

const key = crypto.getRandomValues(new Uint8Array(32))
const ADDRESS = `0x${'11'.repeat(20)}` as `0x${string}`

describe('decryptBackupBlob', () => {
  beforeEach(() => {
    argon2.broken = false
  })

  it('opens an Argon2id blob with the right password', async () => {
    const blob = await encryptBackupBlob(key, 'right-password', ADDRESS)
    expect(blob.argon2.memorySize).toBeGreaterThan(0)
    expect(await decryptBackupBlob(blob, 'right-password')).toEqual(key)
  })

  it('reports a wrong password as a wrong password', async () => {
    const blob = await encryptBackupBlob(key, 'right-password', ADDRESS)
    await expect(decryptBackupBlob(blob, 'wrong')).rejects.toThrow('Incorrect vault password')
  })

  it("doesn't call it a wrong password when Argon2id can't load", async () => {
    const blob = await encryptBackupBlob(key, 'right-password', ADDRESS)
    argon2.broken = true
    const err = await decryptBackupBlob(blob, 'right-password').catch(e => e)
    expect(err).toBeInstanceOf(Argon2UnavailableError)
    expect(err.message).not.toContain('Incorrect vault password')
    expect(err.message).not.toContain('corrupted')
  })

  it('opens the blob once Argon2id can load again', async () => {
    const blob = await encryptBackupBlob(key, 'right-password', ADDRESS)
    argon2.broken = true
    await decryptBackupBlob(blob, 'right-password').catch(() => {})
    argon2.broken = false
    expect(await decryptBackupBlob(blob, 'right-password')).toEqual(key)
  })

  it('still falls back to PBKDF2 when encrypting, and opens that blob without Argon2id', async () => {
    argon2.broken = true
    const blob = await encryptBackupBlob(key, 'right-password', ADDRESS)
    expect(blob.argon2.memorySize).toBe(0)
    expect(await decryptBackupBlob(blob, 'right-password')).toEqual(key)
  })
})
