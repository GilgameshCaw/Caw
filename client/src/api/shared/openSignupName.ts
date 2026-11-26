// A sponsored signup that has no invite code (an X-qualified token, or the
// ungated free signup) has no pot to size the name against: the invite-code gate
// checks burn(name) + gas against the code's pot (and then the deposit against
// what is left), these two do not.
// The sponsor wallet pays the whole username burn, and CawProfileMinter.costOfName
// grows steeply as the name gets shorter (8+ characters: 1M CAW, 7: 10M, 6: 20M,
// 5: 200M, 4: 6B, 3: 60B, 2: 240B, 1: 1T). So these two gates take only names
// that cost the base burn, unless the operator lowers the floor.

/** Characters. 8 is the shortest name that costs the base burn (1M CAW). */
export const DEFAULT_OPEN_SIGNUP_MIN_USERNAME_LENGTH = 8

/** The longest username the bootstrap schema accepts; a floor above it could never be met. */
export const MAX_OPEN_SIGNUP_MIN_USERNAME_LENGTH = 32

/**
 * Shortest username an X-token or ungated signup may ask for.
 * SPONSOR_OPEN_MIN_USERNAME_LENGTH overrides it; anything that is not a whole
 * number from 1 to 32 written in digits falls back to the default.
 */
export function openSignupMinUsernameLength(): number {
  const raw = process.env.SPONSOR_OPEN_MIN_USERNAME_LENGTH
  if (raw === undefined || raw.trim() === '') return DEFAULT_OPEN_SIGNUP_MIN_USERNAME_LENGTH
  const text = raw.trim()
  if (!/^\d{1,2}$/.test(text)) return DEFAULT_OPEN_SIGNUP_MIN_USERNAME_LENGTH
  const n = Number(text)
  if (n < 1 || n > MAX_OPEN_SIGNUP_MIN_USERNAME_LENGTH) return DEFAULT_OPEN_SIGNUP_MIN_USERNAME_LENGTH
  return n
}

export interface OpenSignupNameRefusal {
  error: 'OPEN_SIGNUP_USERNAME_TOO_SHORT'
  detail: string
}

/**
 * The refusal for a bootstrap request whose name is too short for the gates
 * without an invite code, or null. A request with an invite code is never
 * refused here: the code's pot sizes the name (validateSponsorCode).
 */
export function openSignupNameRefusal(hasCode: boolean, username: string): OpenSignupNameRefusal | null {
  if (hasCode) return null
  const minLen = openSignupMinUsernameLength()
  if (username.length >= minLen) return null
  return {
    error: 'OPEN_SIGNUP_USERNAME_TOO_SHORT',
    detail: `A free signup needs a name of at least ${minLen} characters. Choose a longer name, or use an invite code.`,
  }
}
