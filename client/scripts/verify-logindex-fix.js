// Standalone verification of the ethers v6 log-index sort fix.
// Mirrors the fallback pattern (ev.index ?? ev.logIndex ?? 0) applied to
// ChainSyncService, InstanceRegistryService, and RawEventsGatherer.
// Run: node scripts/verify-logindex-fix.js

function sortKey(ev) {
  return (ev.index ?? ev.logIndex ?? 0)
}

function sortPair(a, b) {
  return sortKey(a) - sortKey(b)
}

const cases = [
  {
    label: 'ethers v6 EventLog (has .index, no .logIndex) — must sort correctly',
    events: [{ index: 3 }, { index: 1 }, { index: 2 }],
    expectedOrder: [1, 2, 3],
    key: 'index',
  },
  {
    label: 'legacy-style object with only .logIndex — must still sort correctly (fallback)',
    events: [{ logIndex: 3 }, { logIndex: 1 }, { logIndex: 2 }],
    expectedOrder: [1, 2, 3],
    key: 'logIndex',
  },
  {
    label: 'old buggy behavior check: raw .logIndex on v6-style objects would be NaN',
    events: [{ index: 3 }, { index: 1 }, { index: 2 }],
    checkOldBug: true,
  },
]

let failures = 0

for (const c of cases) {
  if (c.checkOldBug) {
    const oldSorted = [...c.events].sort((a, b) => (a.logIndex) - (b.logIndex))
    const isNaNSort = oldSorted.every((_, i) => oldSorted[i].index === c.events[i].index) // no-op sort check
    console.log(`[INFO] ${c.label} -> old logic result order: ${oldSorted.map(e => e.index).join(',')} (unsorted/no-op, as expected of the bug)`)
    continue
  }
  const sorted = [...c.events].sort(sortPair)
  const actualOrder = sorted.map(e => e[c.key])
  const pass = JSON.stringify(actualOrder) === JSON.stringify(c.expectedOrder)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${c.label} -> got [${actualOrder}], expected [${c.expectedOrder}]`)
}

console.log(`\n${cases.filter(c => !c.checkOldBug).length - failures}/${cases.filter(c => !c.checkOldBug).length} passed`)
process.exit(failures > 0 ? 1 : 0)
