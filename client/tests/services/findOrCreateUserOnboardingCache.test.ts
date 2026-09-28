/**
 * Regression test for NEW-44: findOrCreateUser's onboarding-cache-bypass
 * check used `!opts.onboardingStep`, which is `true` for onboardingStep=0
 * (JS falsy-zero trap — same class of bug as the cawonce===0 trap fixed in
 * PR #81). Fresh mints call findOrCreateUser with onboardingStep=0 (see
 * NftTransferWatcher), so the bypass was silently defeated on the very
 * first onboarding step: a stale cached promise from an earlier call could
 * be returned instead of doing a fresh lookup.
 *
 * doFindOrCreateUser only touches L1/writes when the user row doesn't
 * exist yet; for an existing row it's just a `prisma.user.findUnique`. That
 * makes the cache's effect directly observable: spy on findUnique and
 * count calls for a single tokenId across several findOrCreateUser calls.
 * - Two calls WITHOUT onboardingStep should hit the cache: 1 DB call total.
 * - A call WITH onboardingStep (including 0) must always bypass the cache:
 *   each such call adds a fresh DB call.
 *
 * SKIPS unless DATABASE_URL points at a caw_test_* database. Example
 * (from client/):
 *
 *   DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/caw_test_onboardingcache \
 *   npx mocha --import=tsx --exit tests/services/findOrCreateUserOnboardingCache.test.ts
 *
 * The schema has to exist in that database (the project's usual schema setup).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'

const HAS_TEST_DB = /\/caw_test_[A-Za-z0-9_]*(\?|$)/.test(process.env.DATABASE_URL ?? '')

const TOKEN_ID = 990300

;(HAS_TEST_DB ? describe : describe.skip)('findOrCreateUser bypasses the cache for every onboardingStep call, including 0', function () {
  this.timeout(30000)

  // Bound in `before` via dynamic import (see header).
  let prisma: typeof import('../../src/prismaClient').prisma
  let findOrCreateUser: typeof import('../../src/services/UserService').findOrCreateUser

  let originalFindUnique: any
  let findUniqueCallCount = 0

  before(async () => {
    ;({ prisma } = await import('../../src/prismaClient'))
    ;({ findOrCreateUser } = await import('../../src/services/UserService'))

    await prisma.user.create({
      data: {
        id: TOKEN_ID,
        tokenId: TOKEN_ID,
        username: 'onboarding_cache_test',
        address: '0x3333333333333333333333333333333333cccc',
      },
    })

    // Wrap findUnique to count only calls for our test tokenId, so this
    // test is unaffected by any other findUnique traffic in the process.
    originalFindUnique = prisma.user.findUnique.bind(prisma.user)
    ;(prisma.user as any).findUnique = (args: any) => {
      if (args?.where?.tokenId === TOKEN_ID) findUniqueCallCount++
      return originalFindUnique(args)
    }
  })

  after(async () => {
    ;(prisma.user as any).findUnique = originalFindUnique
    await prisma.user.deleteMany({ where: { tokenId: TOKEN_ID } })
    await prisma.$disconnect()
  })

  it('caches a plain lookup, but always re-checks the DB when onboardingStep is passed, including 0', async () => {
    await findOrCreateUser(TOKEN_ID, {})
    expect(findUniqueCallCount, 'first plain call must hit the DB').to.equal(1)

    await findOrCreateUser(TOKEN_ID, {})
    expect(findUniqueCallCount, 'second plain call should be served from cache').to.equal(1)

    await findOrCreateUser(TOKEN_ID, { onboardingStep: 0 })
    expect(findUniqueCallCount, 'onboardingStep=0 must bypass the cache (the NEW-44 regression)').to.equal(2)

    await findOrCreateUser(TOKEN_ID, { onboardingStep: 1 })
    expect(findUniqueCallCount, 'onboardingStep=1 must also bypass the cache').to.equal(3)

    await findOrCreateUser(TOKEN_ID, {})
    expect(findUniqueCallCount, 'a later plain call should be servable from cache again').to.equal(3)
  })
})
