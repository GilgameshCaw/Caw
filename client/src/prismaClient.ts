import {PrismaClient} from '@prisma/client'

const basePrisma = new PrismaClient()

// Auto-reconnect on "Engine is not yet connected" errors.
// Prisma's query engine can get stuck after network interruptions
// (e.g. laptop sleep, WiFi drop) and never recovers on its own.
let reconnecting = false
const RECONNECT_ERRORS = ['Engine is not yet connected', 'Engine is not running']

export const prisma = new Proxy(basePrisma, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver)
    if (typeof value !== 'function' || prop.toString().startsWith('$')) {
      return value
    }
    // Wrap model accessors (prisma.user, prisma.action, etc.) to intercept errors
    return new Proxy(value, {
      get(modelTarget: any, modelProp: any) {
        const modelValue = modelTarget[modelProp]
        if (typeof modelValue !== 'function') return modelValue
        return async (...args: any[]) => {
          try {
            return await modelValue.apply(modelTarget, args)
          } catch (err: any) {
            if (RECONNECT_ERRORS.some(e => err?.message?.includes(e)) && !reconnecting) {
              reconnecting = true
              console.log('[Prisma] Engine disconnected — reconnecting...')
              try {
                await target.$disconnect()
              } catch {}
              try {
                await target.$connect()
                console.log('[Prisma] Reconnected successfully')
              } catch (connectErr: any) {
                console.error('[Prisma] Reconnection failed:', connectErr.message)
              } finally {
                reconnecting = false
              }
              // Retry the original call once
              return await modelValue.apply(modelTarget, args)
            }
            throw err
          }
        }
      }
    })
  }
}) as PrismaClient

