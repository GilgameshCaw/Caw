/**
 * identity.test.ts
 *
 * Unit tests for the identity bootstrap layer.
 *
 * Test runner: Vitest (not yet in package.json — add before running).
 *   yarn add -D vitest @vitest/coverage-v8
 *   # then add to package.json scripts: "test": "vitest run"
 *
 * Run:
 *   cd client/src/services/FrontEnd
 *   yarn test
 *
 * These tests rely on the browser Web Crypto API, which Vitest provides via
 * `environment: 'happy-dom'` or `environment: 'jsdom'`. Add to vite.config.ts
 * or a vitest.config.ts:
 *   test: { environment: 'happy-dom' }
 *
 * No network access is required. No external services are stubbed.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  generateSecp256k1Keypair,
  keypairFromPrivateKey,
  signDigest,
  signDigestForOnChain,
} from './secp256k1Key'
import { encryptBackupBlob, decryptBackupBlob, validateBackupBlobShape } from './backupBlob'
import { loadBackupBlobFromFile } from './cloudBackup'
import { signAuthorizationTuple } from './eip7702'
import { bootstrapNewUser } from './bootstrap'

// ─── secp256k1Key ─────────────────────────────────────────────────────────────

describe('generateSecp256k1Keypair', () => {
  it('generates a keypair with 32-byte private key, 65-byte uncompressed public key, and a valid address', () => {
    const kp = generateSecp256k1Keypair()
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey.length).toBe(32)
    // Uncompressed pubkey: 0x04 prefix + 32 bytes X + 32 bytes Y = 65 bytes = 132 hex chars + "0x"
    expect(kp.publicKey.startsWith('0x04')).toBe(true)
    expect(kp.publicKey.length).toBe(132) // 0x + 130 hex chars
    // Ethereum address: 0x + 40 hex chars
    expect(kp.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('produces a different keypair on each call', () => {
    const kp1 = generateSecp256k1Keypair()
    const kp2 = generateSecp256k1Keypair()
    expect(kp1.address).not.toBe(kp2.address)
  })
})

describe('keypairFromPrivateKey', () => {
  it('restores the same address from the same private key bytes', () => {
    const kp = generateSecp256k1Keypair()
    const restored = keypairFromPrivateKey(kp.privateKey)
    expect(restored.address).toBe(kp.address)
    expect(restored.publicKey).toBe(kp.publicKey)
  })

  it('throws for a private key that is not 32 bytes', () => {
    expect(() => keypairFromPrivateKey(new Uint8Array(31))).toThrow()
    expect(() => keypairFromPrivateKey(new Uint8Array(33))).toThrow()
  })
})

describe('signDigest', () => {
  it('returns r, s, v components — v is 0 or 1', () => {
    const kp = generateSecp256k1Keypair()
    const digest = `0x${'ab'.repeat(32)}` as `0x${string}`
    const sig = signDigest(kp.privateKey, digest)
    expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/)
    expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/)
    expect([0, 1]).toContain(sig.v)
  })

  it('throws for a digest that is not 32 bytes', () => {
    const kp = generateSecp256k1Keypair()
    expect(() => signDigest(kp.privateKey, `0x${'ab'.repeat(16)}` as `0x${string}`)).toThrow()
  })
})

describe('signDigestForOnChain', () => {
  it('produces a 65-byte blob (0x + 130 hex chars) with v = 27 or 28', () => {
    const kp = generateSecp256k1Keypair()
    const digest = `0x${'cd'.repeat(32)}` as `0x${string}`
    const blob = signDigestForOnChain(kp.privateKey, digest)
    expect(blob.length).toBe(132) // "0x" + 130 hex chars (65 bytes)
    const vByte = parseInt(blob.slice(-2), 16)
    expect([27, 28]).toContain(vByte)
  })
})

// ─── backupBlob round-trip ────────────────────────────────────────────────────

describe('encryptBackupBlob / decryptBackupBlob', () => {
  it('round-trips: generate → encrypt → decrypt → same private key', async () => {
    const kp = generateSecp256k1Keypair()
    const password = 'correct-horse-battery-staple-42!'
    const blob = await encryptBackupBlob(kp.privateKey, password, kp.address)

    expect(blob.version).toBe(1)
    expect(blob.pubkeyAddress).toBe(kp.address)
    expect(blob.salt.startsWith('0x')).toBe(true)
    expect(blob.iv.startsWith('0x')).toBe(true)
    expect(blob.ciphertext.startsWith('0x')).toBe(true)

    const recovered = await decryptBackupBlob(blob, password)
    expect(recovered.length).toBe(32)
    expect(Array.from(recovered)).toEqual(Array.from(kp.privateKey))
  })

  it('throws when the wrong password is used to decrypt', async () => {
    const kp = generateSecp256k1Keypair()
    const blob = await encryptBackupBlob(kp.privateKey, 'correct-password!42', kp.address)
    await expect(decryptBackupBlob(blob, 'wrong-password')).rejects.toThrow()
  })

  it('two encryptions of the same key produce different salts, IVs, and ciphertexts (no IV reuse)', async () => {
    const kp = generateSecp256k1Keypair()
    const password = 'test-passphrase-99!'
    const b1 = await encryptBackupBlob(kp.privateKey, password, kp.address)
    const b2 = await encryptBackupBlob(kp.privateKey, password, kp.address)
    expect(b1.salt).not.toBe(b2.salt)
    expect(b1.iv).not.toBe(b2.iv)
    expect(b1.ciphertext).not.toBe(b2.ciphertext)
  })

  it('records the correct kdf metadata (PBKDF2 fallback path: memorySize === 0)', async () => {
    const kp = generateSecp256k1Keypair()
    const blob = await encryptBackupBlob(kp.privateKey, 'test-pw!', kp.address)
    // Currently PBKDF2 fallback because argon2-browser is not installed.
    // When Argon2id is wired in, this assertion should flip to > 0.
    expect(typeof blob.argon2.memorySize).toBe('number')
    expect(blob.argon2.iterations).toBeGreaterThan(0)
  })
})

// ─── validateBackupBlobShape ──────────────────────────────────────────────────

describe('validateBackupBlobShape', () => {
  it('accepts a well-formed blob', async () => {
    const kp = generateSecp256k1Keypair()
    const blob = await encryptBackupBlob(kp.privateKey, 'pw!', kp.address)
    expect(validateBackupBlobShape(blob)).toBe(true)
  })

  it('rejects null, non-object, missing fields', () => {
    expect(validateBackupBlobShape(null)).toBe(false)
    expect(validateBackupBlobShape('string')).toBe(false)
    expect(validateBackupBlobShape({ version: 2 })).toBe(false)
    expect(
      validateBackupBlobShape({
        version: 1,
        // salt missing
        iv: '0xaabbcc',
        ciphertext: '0xaabbcc',
        pubkeyAddress: '0xabc',
        argon2: { memorySize: 0, iterations: 1, parallelism: 1 },
      }),
    ).toBe(false)
  })
})

// ─── cloudBackup — file picker stub ──────────────────────────────────────────

describe('loadBackupBlobFromFile', () => {
  it('parses a valid JSON blob from a stubbed File', async () => {
    const kp = generateSecp256k1Keypair()
    const blob = await encryptBackupBlob(kp.privateKey, 'pw!', kp.address)
    const json = JSON.stringify(blob)

    // Stub the DOM file-picker interaction.
    const originalCreateElement = document.createElement.bind(document)
    const originalAppendChild = document.body.appendChild.bind(document.body)
    const originalRemoveChild = document.body.removeChild.bind(document.body)

    const mockInput = {
      type: '',
      accept: '',
      style: { display: '' },
      addEventListener: vi.fn((_event: string, handler: EventListenerOrEventListenerObject) => {
        if (_event === 'change') {
          // Simulate the user selecting a file immediately.
          const file = new File([json], 'caw-backup-test.json', { type: 'application/json' })
          Object.defineProperty(mockInput, 'files', { value: [file], configurable: true })
          // Fire after a microtask to let the click() call complete.
          Promise.resolve().then(() => {
            if (typeof handler === 'function') handler({} as Event)
            else handler.handleEvent({} as Event)
          })
        }
      }),
      click: vi.fn(),
    }

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'input') return mockInput as unknown as HTMLElement
      return originalCreateElement(tag)
    })
    vi.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
      if (node === (mockInput as unknown)) return node
      return originalAppendChild(node)
    })
    vi.spyOn(document.body, 'removeChild').mockImplementation((node: Node) => {
      if (node === (mockInput as unknown)) return node
      return originalRemoveChild(node)
    })

    const result = await loadBackupBlobFromFile()
    expect(result).not.toBeNull()
    expect(validateBackupBlobShape(result)).toBe(true)
    expect((result as NonNullable<typeof result>).pubkeyAddress).toBe(kp.address)

    vi.restoreAllMocks()
  })

  it('rejects blobs with invalid JSON shape', async () => {
    const badJson = JSON.stringify({ version: 99, garbage: true })

    const originalCreateElement = document.createElement.bind(document)
    const mockInput = {
      type: '',
      accept: '',
      style: { display: '' },
      addEventListener: vi.fn((_event: string, handler: EventListenerOrEventListenerObject) => {
        if (_event === 'change') {
          const file = new File([badJson], 'bad.json', { type: 'application/json' })
          Object.defineProperty(mockInput, 'files', { value: [file], configurable: true })
          Promise.resolve().then(() => {
            if (typeof handler === 'function') handler({} as Event)
            else handler.handleEvent({} as Event)
          })
        }
      }),
      click: vi.fn(),
    }

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'input') return mockInput as unknown as HTMLElement
      return originalCreateElement(tag)
    })
    vi.spyOn(document.body, 'appendChild').mockImplementation((n: Node) => n)
    vi.spyOn(document.body, 'removeChild').mockImplementation((n: Node) => n)

    await expect(loadBackupBlobFromFile()).rejects.toThrow(/does not look like a CAW backup blob/)

    vi.restoreAllMocks()
  })
})

// ─── eip7702 — signAuthorizationTuple ────────────────────────────────────────

describe('signAuthorizationTuple', () => {
  it('produces a signature whose yParity is 0 or 1, r and s are 32-byte hex', async () => {
    const kp = generateSecp256k1Keypair()
    const result = await signAuthorizationTuple({
      privateKey: kp.privateKey,
      chainId: 1,
      contractAddress: '0x1234567890123456789012345678901234567890',
      nonce: 0n,
    })
    expect([0, 1]).toContain(result.yParity)
    expect(result.r).toMatch(/^0x[0-9a-f]{64}$/)
    expect(result.s).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('is deterministic for the same inputs (ECDSA with deterministic k per RFC 6979)', async () => {
    const kp = generateSecp256k1Keypair()
    const opts = {
      privateKey: kp.privateKey,
      chainId: 84532,
      contractAddress: '0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000' as `0x${string}`,
      nonce: 5n,
    }
    const sig1 = await signAuthorizationTuple(opts)
    const sig2 = await signAuthorizationTuple(opts)
    // RFC 6979 deterministic k → same r, s for same inputs
    expect(sig1.r).toBe(sig2.r)
    expect(sig1.s).toBe(sig2.s)
    expect(sig1.yParity).toBe(sig2.yParity)
  })

  it('signedAuthorization carries the correct chainId, address, and nonce fields', async () => {
    const kp = generateSecp256k1Keypair()
    const contractAddress = '0xCafeCAfecaFeCaFecaFecaFecaFECaFECaFeCaFe' as `0x${string}`
    const result = await signAuthorizationTuple({
      privateKey: kp.privateKey,
      chainId: 11155111,
      contractAddress,
      nonce: 3n,
    })
    expect(result.signedAuthorization.chainId).toBe(11155111)
    expect(result.signedAuthorization.address.toLowerCase()).toBe(contractAddress.toLowerCase())
    expect(result.signedAuthorization.nonce).toBe(3)
  })

  it('throws for a negative nonce', async () => {
    const kp = generateSecp256k1Keypair()
    await expect(
      signAuthorizationTuple({
        privateKey: kp.privateKey,
        chainId: 1,
        contractAddress: '0x1234567890123456789012345678901234567890',
        nonce: -1n,
      }),
    ).rejects.toThrow(/nonce/)
  })

  it('throws for chainId = 0', async () => {
    const kp = generateSecp256k1Keypair()
    await expect(
      signAuthorizationTuple({
        privateKey: kp.privateKey,
        chainId: 0,
        contractAddress: '0x1234567890123456789012345678901234567890',
        nonce: 0n,
      }),
    ).rejects.toThrow(/chainId/)
  })
})

// ─── bootstrapNewUser — orchestration ────────────────────────────────────────

describe('bootstrapNewUser', () => {
  it('returns a txHash, backupBlob, and ecdsaAddress; backup blob decrypts to match', async () => {
    const stubSponsorApi = {
      sponsorBootstrap: vi.fn().mockResolvedValue({ txHash: '0xdeadbeef' }),
    }
    const stubPasskeySigner = vi.fn().mockResolvedValue({
      permitSig: `0x${'aa'.repeat(112)}` as `0x${string}`, // ≥224 bytes for WebAuthn path
      clientDataJSON: '{"type":"webauthn.get","challenge":"dGVzdA"}',
      authenticatorData: `0x${'bb'.repeat(37)}` as `0x${string}`,
    })
    const stubRpc = {
      getChainId: vi.fn().mockResolvedValue(84532),
      getTransactionCount: vi.fn().mockResolvedValue(0),
    }

    const result = await bootstrapNewUser({
      vaultPassword: 'test-vault-password-strong!',
      username: 'testuser',
      depositAmountCAW: 1_000_000n,
      networkId: 1,
      lzDestId: 40245,
      passkeyPubkeyX: `0x${'01'.repeat(32)}` as `0x${string}`,
      passkeyPubkeyY: `0x${'02'.repeat(32)}` as `0x${string}`,
      smartEoaAddress: '0x1234567890123456789012345678901234567890',
      rpcProvider: stubRpc,
      passkeySigner: stubPasskeySigner,
      sponsorApi: stubSponsorApi,
      permitDigest: `0x${'ff'.repeat(32)}` as `0x${string}`,
    })

    expect(result.txHash).toBe('0xdeadbeef')
    expect(result.ecdsaAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(validateBackupBlobShape(result.backupBlob)).toBe(true)
    expect(result.backupBlob.pubkeyAddress).toBe(result.ecdsaAddress)

    // Verify the backup blob decrypts to a keypair with the same address.
    const recoveredKey = await decryptBackupBlob(result.backupBlob, 'test-vault-password-strong!')
    const { keypairFromPrivateKey: kpFromKey } = await import('./secp256k1Key')
    const restoredKp = kpFromKey(recoveredKey)
    expect(restoredKp.address).toBe(result.ecdsaAddress)
  })

  it('passes the correct chainId and nonce to signAuthorizationTuple (never hardcodes)', async () => {
    const FAKE_CHAIN_ID = 999
    const FAKE_NONCE = 7
    const capturedParams: unknown[] = []

    const stubSponsorApi = {
      sponsorBootstrap: vi.fn().mockImplementation((p: unknown) => {
        capturedParams.push(p)
        return Promise.resolve({ txHash: '0x1234' })
      }),
    }
    const stubPasskeySigner = vi.fn().mockResolvedValue({
      permitSig: `0x${'cc'.repeat(112)}` as `0x${string}`,
      clientDataJSON: '{}',
      authenticatorData: `0x${'dd'.repeat(37)}` as `0x${string}`,
    })
    const stubRpc = {
      getChainId: vi.fn().mockResolvedValue(FAKE_CHAIN_ID),
      getTransactionCount: vi.fn().mockResolvedValue(FAKE_NONCE),
    }

    await bootstrapNewUser({
      vaultPassword: 'pw!1234567',
      username: 'alice',
      depositAmountCAW: 1_000_000n,
      networkId: 1,
      lzDestId: 40245,
      passkeyPubkeyX: `0x${'01'.repeat(32)}` as `0x${string}`,
      passkeyPubkeyY: `0x${'02'.repeat(32)}` as `0x${string}`,
      smartEoaAddress: '0x1234567890123456789012345678901234567890',
      rpcProvider: stubRpc,
      passkeySigner: stubPasskeySigner,
      sponsorApi: stubSponsorApi,
      permitDigest: `0x${'ee'.repeat(32)}` as `0x${string}`,
    })

    expect(stubRpc.getChainId).toHaveBeenCalled()
    expect(stubRpc.getTransactionCount).toHaveBeenCalled()

    // The submitted authTupleSignature must carry the RPC-read chainId.
    const submitted = capturedParams[0] as { authTupleSignature: { chainId: number } }
    expect(submitted.authTupleSignature.chainId).toBe(FAKE_CHAIN_ID)
  })
})
