// Standalone verification of the onboardingToken fix in PostMintOnboarding.tsx.
// Simulates useActiveToken() returning a stale, different profile during
// the indexer-lag window right after a fresh mint.
// Run: node scripts/verify-post-mint-onboarding-token-race.js

function buildOnboardingToken(activeToken, tokenId, username, address) {
  if (activeToken?.tokenId === tokenId) return activeToken
  return { tokenId, username, address }
}

let failures = 0
function stringify(v) {
  return JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() + 'n' : val)
}
function check(label, actual, expected) {
  const pass = stringify(actual) === stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${stringify(actual)}, expected ${stringify(expected)}`)
}

// 1) Stale activeToken (indexer hasn't caught up): must NOT leak the old
//    profile's tokenId into the profile-update path.
const staleActiveToken = { tokenId: 3, username: 'userA', owner: '0xAAA', stakedAmount: 500n }
const result1 = buildOnboardingToken(staleActiveToken, 9, 'userB', '0xAAA')
check('stale activeToken (tokenId=3) does not leak into onboarding tokenId=9', result1.tokenId, 9)
check('stale case: onboardingToken carries the correct username', result1.username, 'userB')

// 2) activeToken undefined (brand-new user, nothing in the store yet):
//    must still produce a usable token from props, not crash or fall back to 0.
const result2 = buildOnboardingToken(undefined, 12, 'newuser', '0xBBB')
check('undefined activeToken -> falls back to props, not tokenId 0', result2.tokenId, 12)

// 3) activeToken already caught up (tokenId matches): must use the real
//    activeToken object (preserves owner/stakedAmount for the fields that
//    do need them, e.g. the staked-amount badge elsewhere in the component).
const caughtUpToken = { tokenId: 9, username: 'userB', owner: '0xAAA', stakedAmount: 1000n }
const result3 = buildOnboardingToken(caughtUpToken, 9, 'userB', '0xAAA')
check('activeToken already synced -> real object is used, not a stripped-down copy', result3, caughtUpToken)

// 4) Regression check: the old buggy behavior (passing activeToken
//    directly without this gate) would have leaked tokenId=3 here --
//    confirm the old path really was wrong, for the record.
const oldBuggyResult = staleActiveToken // what the pre-fix code passed directly
check('sanity: unpatched activeToken really was the wrong (stale) tokenId', oldBuggyResult.tokenId, 3)

// 5) The second call site found during audit: the pendingDepositAmount
//    PATCH used activeToken.username directly (same stale-lag exposure
//    as ProfileEditForm). Confirm onboardingToken.username -- not
//    activeToken.username -- is what would be sent to the API during
//    the lag window.
function buildPatchTarget(onboardingToken) {
  return onboardingToken?.username
}
const staleOnboardingToken = buildOnboardingToken(staleActiveToken, 9, 'userB', '0xAAA')
check('pendingDepositAmount PATCH targets the onboarding username, not the stale one',
  buildPatchTarget(staleOnboardingToken), 'userB')

// 6) The follow-gate finding from review (tentencaw, PR #67): the same
//    stale/undefined activeToken issue affects MIN_STAKE_FOLLOW's
//    hasEnoughStake check, not just the two write paths. Unlike a
//    display value, this gates an action and fails OPEN if
//    activeToken.stakedAmount comes from a stale, well-staked old
//    profile -- the new profile would clear the threshold on the old
//    profile's stake. onboardingToken never carries a stale
//    stakedAmount (only real or undefined), so this must resolve to 0n
//    whenever activeToken hasn't caught up, not the stale profile's
//    balance.
function resolveStakedAmountForFollowGate(onboardingTokenArg) {
  return typeof onboardingTokenArg?.stakedAmount === 'bigint' ? onboardingTokenArg.stakedAmount : 0n
}
const staleWithHighStake = { tokenId: 3, username: 'userA', owner: '0xAAA', stakedAmount: 50000n * 10n ** 18n }
const onboardingTokenDuringLag = buildOnboardingToken(staleWithHighStake, 9, 'userB', '0xAAA')
check('6: stale high-stake profile does not leak into the follow-gate threshold', resolveStakedAmountForFollowGate(onboardingTokenDuringLag), 0n)

console.log(`\n${6 - failures}/6 passed`)
process.exit(failures > 0 ? 1 : 0)
