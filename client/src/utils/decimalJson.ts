import { Prisma } from '@prisma/client'

/**
 * JSON.stringify replacer for the admin DB tool's responses.
 *
 * - Prisma Decimal: Decimal#toJSON switches to exponent notation above 1e21
 *   ("3.5566013741e+26"), which is how the marketplace prices (NUMERIC(78,0)
 *   wei) came out of the detail view. JSON.stringify calls toJSON before the
 *   replacer sees the value, so the original is read off the holder
 *   (`this[key]`) and written with toFixed() (plain digits, no rounding).
 * - bigint: JSON cannot carry it, so it is sent as a decimal string.
 *
 * Use it as a `function` replacer; an arrow function has no `this`.
 */
export function adminJsonReplacer(this: any, key: string, value: unknown): unknown {
  const raw = this != null ? this[key] : undefined
  if (raw instanceof Prisma.Decimal) return raw.toFixed()
  return typeof value === 'bigint' ? value.toString() : value
}
