import { PrismaClient } from '@prisma/client'

// Singleton Prisma client shared across every service in this process.
// Services previously each instantiated their own `new PrismaClient()`, but
// that meant a network blip (laptop sleep, WiFi drop, DB restart) could leave
// each engine stuck in "Engine is not yet connected" with no recovery.
//
// This module centralises:
//   1. ONE shared engine per process (no pool multiplication).
//   2. Auto-reconnect: any model call that sees "Engine is not yet connected"
//      or "Engine is not running" will disconnect + reconnect + retry once.
//   3. A neutered `$disconnect()` — individual service `stop()` handlers used
//      to call it on their own private client; with a shared client, honoring
//      those calls would kill DB access for every other service in the
//      process. Real teardown happens on process exit via `shutdownPrisma()`.
const basePrisma = new PrismaClient()

let reconnecting = false
const RECONNECT_ERRORS = ['Engine is not yet connected', 'Engine is not running']

async function reconnectOnce() {
  if (reconnecting) return
  reconnecting = true
  console.log('[Prisma] Engine disconnected — reconnecting...')
  try { await basePrisma.$disconnect() } catch {}
  try {
    await basePrisma.$connect()
    console.log('[Prisma] Reconnected successfully')
  } catch (connectErr: any) {
    console.error('[Prisma] Reconnection failed:', connectErr.message)
  } finally {
    reconnecting = false
  }
}

function wrapModelMethod(fn: Function, thisArg: any) {
  return async (...args: any[]) => {
    try {
      return await fn.apply(thisArg, args)
    } catch (err: any) {
      if (RECONNECT_ERRORS.some(e => err?.message?.includes(e))) {
        await reconnectOnce()
        return await fn.apply(thisArg, args)
      }
      throw err
    }
  }
}

export const prisma = new Proxy(basePrisma, {
  get(target, prop, receiver) {
    // Intercept `$disconnect` — individual services must not be able to
    // nuke the shared engine. Real shutdown goes through `shutdownPrisma()`.
    if (prop === '$disconnect') {
      return async () => { /* no-op for shared client */ }
    }

    const value = Reflect.get(target, prop, receiver)

    // Pass through $-prefixed APIs ($transaction, $executeRaw, $queryRaw,
    // $connect, $extends, etc.) and any non-object properties.
    if (typeof prop === 'string' && prop.startsWith('$')) return value
    if (value === null || typeof value !== 'object') return value

    // Model delegates (prisma.user, prisma.txQueue, ...) are objects whose
    // methods (findMany, create, update, ...) can throw "Engine is not yet
    // connected" after a network blip. Wrap each method to auto-reconnect.
    return new Proxy(value, {
      get(modelTarget: any, modelProp: any) {
        const modelValue = modelTarget[modelProp]
        if (typeof modelValue !== 'function') return modelValue
        return wrapModelMethod(modelValue, modelTarget)
      },
    })
  },
}) as PrismaClient

/**
 * Call this ONCE at process shutdown. Services' own stop() handlers should
 * NOT call prisma.$disconnect() directly (it's a no-op on this shared client).
 */
export async function shutdownPrisma() {
  try { await basePrisma.$disconnect() } catch {}
}

