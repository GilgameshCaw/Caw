import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useNavigate } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import GithubSlugger from 'github-slugger'
import { HiChevronRight, HiSearch, HiX } from 'react-icons/hi'

// Source of truth: repo root docs/WHITEPAPER.md
// Vite allows workspace-root file access via searchForWorkspaceRoot().
import whitepaperMd from '../../../../../../docs/WHITEPAPER.md?raw'

import LandingHeader from '~/components/landing/LandingHeader'
import LandingFooter from '~/components/landing/LandingFooter'

// Base for turning in-doc file references into GitHub source links. Change here
// if the canonical public repo / branch moves.
const REPO_BASE = 'https://github.com/GilgameshCaw/Caw/blob/master/'

// Inline-code file references that resolve to an existing repo path get linked to
// GitHub. Keys are the token AS WRITTEN in the markdown (bare contract names are
// aliased to their solidity/contracts path; the service path is aliased too).
// Refs NOT in this map render as plain styled code (no dead links).
const REPO_FILES: Record<string, string> = {
  'CawActions.sol': 'solidity/contracts/CawActions.sol',
  'CawActionsArchive.sol': 'solidity/contracts/CawActionsArchive.sol',
  'CawActionsERC1271.sol': 'solidity/contracts/CawActionsERC1271.sol',
  'CawCapOracle.sol': 'solidity/contracts/CawCapOracle.sol',
  'CawChallengeRelay.sol': 'solidity/contracts/CawChallengeRelay.sol',
  'CawProfile.sol': 'solidity/contracts/CawProfile.sol',
  'CawProfileMinter.sol': 'solidity/contracts/CawProfileMinter.sol',
  'SigVerification.sol': 'solidity/contracts/SigVerification.sol',
  'SmartEOA.sol': 'solidity/contracts/SmartEOA.sol',
  'ValidatorService/index.ts': 'client/src/services/ValidatorService/index.ts',
  'docs/ACTION_COST_CAP.md': 'docs/ACTION_COST_CAP.md',
  'docs/ARCHITECTURE.md': 'docs/ARCHITECTURE.md',
  'docs/DATA_FLOW.md': 'docs/DATA_FLOW.md',
  'docs/DIRECT_MESSAGING.md': 'docs/DIRECT_MESSAGING.md',
  'docs/ELASTICSEARCH_SETUP.md': 'docs/ELASTICSEARCH_SETUP.md',
  'docs/IMAGE_UPLOAD_SYSTEM.md': 'docs/IMAGE_UPLOAD_SYSTEM.md',
  'docs/MARKETPLACE.md': 'docs/MARKETPLACE.md',
  'docs/MIGRATIONS.md': 'docs/MIGRATIONS.md',
  'docs/MULTI_CHAIN_STORAGE.md': 'docs/MULTI_CHAIN_STORAGE.md',
  'docs/REPLICATION_AND_SLASHING.md': 'docs/REPLICATION_AND_SLASHING.md',
  'docs/SESSION_KEYS.md': 'docs/SESSION_KEYS.md',
  'docs/SOLANA_OPTION.md': 'docs/SOLANA_OPTION.md',
  'docs/VALIDATOR_MESH_NETWORK.md': 'docs/VALIDATOR_MESH_NETWORK.md',
  'docs/ZK_SIG_PATH.md': 'docs/ZK_SIG_PATH.md',
  'native/docs/BACKUP_AND_RECOVERY.md': 'native/docs/BACKUP_AND_RECOVERY.md',
  'native/docs/ERC4337_REASSESSMENT.md': 'native/docs/ERC4337_REASSESSMENT.md',
  'native/docs/ROADMAP.md': 'native/docs/ROADMAP.md',
  'native/docs/WALLET.md': 'native/docs/WALLET.md',
  'solidity/contracts/CawActions.sol': 'solidity/contracts/CawActions.sol',
  'solidity/contracts/CawActionsArchive.sol': 'solidity/contracts/CawActionsArchive.sol',
  'solidity/contracts/CawActionsERC1271.sol': 'solidity/contracts/CawActionsERC1271.sol',
  'solidity/contracts/CawBuyAndBurn.sol': 'solidity/contracts/CawBuyAndBurn.sol',
  'solidity/contracts/CawCapOracle.sol': 'solidity/contracts/CawCapOracle.sol',
  'solidity/contracts/CawChallengeRelay.sol': 'solidity/contracts/CawChallengeRelay.sol',
  'solidity/contracts/CawFontDataA.sol': 'solidity/contracts/CawFontDataA.sol',
  'solidity/contracts/CawFontDataB.sol': 'solidity/contracts/CawFontDataB.sol',
  'solidity/contracts/CawL1PriceReader.sol': 'solidity/contracts/CawL1PriceReader.sol',
  'solidity/contracts/CawNetworkManager.sol': 'solidity/contracts/CawNetworkManager.sol',
  'solidity/contracts/CawProfile.sol': 'solidity/contracts/CawProfile.sol',
  'solidity/contracts/CawProfileMarketplace.sol': 'solidity/contracts/CawProfileMarketplace.sol',
  'solidity/contracts/CawProfileMinter.sol': 'solidity/contracts/CawProfileMinter.sol',
  'solidity/contracts/CawProfileURI.sol': 'solidity/contracts/CawProfileURI.sol',
  'solidity/contracts/MintableCaw.sol': 'solidity/contracts/MintableCaw.sol',
  'solidity/contracts/OnlyOnce.sol': 'solidity/contracts/OnlyOnce.sol',
  'solidity/contracts/PathwayExpander.sol': 'solidity/contracts/PathwayExpander.sol',
  'solidity/contracts/SigVerification.sol': 'solidity/contracts/SigVerification.sol',
  'solidity/contracts/SmartEOA.sol': 'solidity/contracts/SmartEOA.sol',
  'solidity/contracts/sp1-vendor/SP1VerifierGroth16.sol': 'solidity/contracts/sp1-vendor/SP1VerifierGroth16.sol',
}

// --- Local whitepaper search ---------------------------------------------
// Everything below runs client-side over the already-sliced section markdown;
// there is no server round-trip. We project each section's markdown to a
// plaintext-ish string for matching, find every occurrence of the query, and
// emit a short snippet around each so the sidebar can quote the match in context.

// Light markdown → text projection: drop the noisy markers (headings, emphasis,
// code fences, list bullets, ==highlight==, link URLs) so matches and snippets
// read as prose rather than raw md. Newlines collapse to spaces.
const mdToPlain = (md: string): string =>
  md
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')               // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')  // links/images → label
    .replace(/^#{1,6}\s+/gm, '')                // heading markers
    .replace(/^\s*[-*+]\s+/gm, '')              // list bullets
    .replace(/^\s*>\s?/gm, '')                  // blockquote markers
    .replace(/^\s*---\s*$/gm, ' ')              // thematic breaks
    .replace(/==/g, '')                         // highlight markers
    .replace(/[*_]{1,3}/g, '')                  // bold/italic
    .replace(/\s+/g, ' ')
    .trim()

const SNIPPET_RADIUS = 48 // chars of context on each side of a match

type Occurrence = { index: number; snippet: string; matchStart: number; matchEnd: number }
type SectionResult = { id: string; label: string; occurrences: Occurrence[] }

// Find every (case-insensitive) occurrence of `q` in `text`, returning a snippet
// window around each with the in-snippet offsets of the matched substring so the
// renderer can bold just that span.
const findOccurrences = (text: string, q: string): Occurrence[] => {
  if (!q) return []
  const hay = text.toLowerCase()
  const needle = q.toLowerCase()
  const out: Occurrence[] = []
  let from = 0
  while (true) {
    const at = hay.indexOf(needle, from)
    if (at === -1) break
    let start = Math.max(0, at - SNIPPET_RADIUS)
    let end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS)
    // Snap to word boundaries so we don't slice mid-word.
    while (start > 0 && /\S/.test(text[start - 1])) start--
    while (end < text.length && /\S/.test(text[end])) end++
    const prefix = start > 0 ? '…' : ''
    const suffix = end < text.length ? '…' : ''
    const snippet = prefix + text.slice(start, end).trim() + suffix
    const matchStart = prefix.length + (at - start)
    out.push({ index: out.length, snippet, matchStart, matchEnd: matchStart + needle.length })
    from = at + needle.length
  }
  return out
}

const WhitepaperPage: React.FC = () => {
  const { isDark } = useTheme()

  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  type TocChild = { id: string; label: string; depth: 2 }
  type TocParent = { id: string; label: string; depth: 1; children: TocChild[] }
  type TocItem = TocParent | { id: string; label: string; depth: 2 }

  const { toc, sectionMdById, searchSliceById, headingIdFor, resetRenderSlugger, initialId, parentById } = useMemo(() => {
    const lines = whitepaperMd.split('\n')
    const slugger = new GithubSlugger()

    // Extract h1/h2 headings with their line index.
    const headings: Array<{ id: string; depth: 1 | 2; label: string; line: number }> = []
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,2})\s+(.+?)\s*$/)
      if (!m) continue
      const depth = m[1].length as 1 | 2
      // Strip ==highlight== markers so the TOC label + slug match the rendered
      // (marker-free) heading text and anchors stay stable.
      const label = m[2].replace(/\s+#+\s*$/, '').replace(/==/g, '').trim()
      const id = slugger.slug(label)
      headings.push({ id, depth, label, line: i })
    }

    // Build nested TOC:
    // - Ignore the very first h1 (document title).
    // - Treat h2s before the first “real” section as top-level items.
    // - Group h2 children under their nearest preceding h1.
    const toc: TocItem[] = []
    const parentById: Record<string, string> = {}
    let currentParent: TocParent | null = null
    let firstH1Seen = false

    for (const h of headings) {
      if (h.depth === 1) {
        if (!firstH1Seen) {
          // Document title — skip.
          firstH1Seen = true
          currentParent = null
          continue
        }
        const parent: TocParent = { id: h.id, label: h.label, depth: 1, children: [] }
        toc.push(parent)
        currentParent = parent
        continue
      }

      // depth === 2
      if (currentParent) {
        currentParent.children.push({ id: h.id, label: h.label, depth: 2 })
        parentById[h.id] = currentParent.id
      } else {
        toc.push({ id: h.id, label: h.label, depth: 2 })
      }
    }

    // Slice markdown per heading so clicking a TOC item swaps the right pane
    // instead of rendering the whole document at once.
    //
    // sectionMdById  — what we RENDER. An h1 slice spans the whole section
    //                  (heading + all child h2s); an h2 slice is just the child.
    // searchSliceById — what we SEARCH. Same as the render slice EXCEPT an h1
    //                  with children only covers its PREAMBLE (h1 heading up to
    //                  its first child h2). Children own their own text, so this
    //                  stops parent results from duplicating child results;
    //                  the parent only surfaces matches that appear before any
    //                  subsection begins.
    const sectionMdById: Record<string, string> = {}
    const searchSliceById: Record<string, string> = {}
    for (let idx = 0; idx < headings.length; idx++) {
      const h = headings[idx]
      // Skip doc title slice.
      if (h.depth === 1 && idx === 0) continue

      const start = h.line
      let end = lines.length
      let firstChildLine = -1 // first h2 under this h1, if any
      for (let j = idx + 1; j < headings.length; j++) {
        const next = headings[j]
        if (h.depth === 1) {
          if (next.depth === 2 && firstChildLine === -1) firstChildLine = next.line
          if (next.depth === 1) { end = next.line; break }
        } else {
          // h2 ends at next h1 OR next h2.
          if (next.depth === 1 || next.depth === 2) { end = next.line; break }
        }
      }
      sectionMdById[h.id] = lines.slice(start, end).join('\n').trim() + '\n'
      // Search slice: parents with children search only their preamble.
      const searchEnd = h.depth === 1 && firstChildLine !== -1 ? firstChildLine : end
      searchSliceById[h.id] = lines.slice(start, searchEnd).join('\n').trim() + '\n'
    }

    // Heading ids during render must match the ids we computed above. The
    // slugger is stateful (it disambiguates repeats with -1/-2 suffixes), so we
    // RESET it at the start of every page render — otherwise navigating between
    // sections accumulates suffixes and the rendered heading id drifts away from
    // the slug we computed here (breaking #anchor scroll). `resetRenderSlugger`
    // is called once per ReactMarkdown render below.
    const renderSlugger = new GithubSlugger()
    const resetRenderSlugger = (): null => { renderSlugger.reset(); return null }
    const headingIdFor = (label: string) => renderSlugger.slug(label)

    // Default section: Foreword if present; otherwise first TOC item.
    const foreword = headings.find(h => h.label.toLowerCase() === 'foreword')
    const initialId = foreword?.id ?? toc[0]?.id ?? ''

    return { toc, sectionMdById, searchSliceById, headingIdFor, resetRenderSlugger, initialId, parentById }
  }, [])

  // The URL is the source of truth for the active section, so each section is
  // deep-linkable and back/forward works. /help/whitepaper/<section-slug>.
  const { sectionId } = useParams<{ sectionId?: string }>()
  const navigate = useNavigate()

  // The active section resolves from the URL param when it's a known section,
  // otherwise the default (Foreword / first). No separate state to drift.
  const activeId = (sectionId && sectionMdById[sectionId]) ? sectionId : initialId

  // The PAGE we actually render is the active section's parent when the active
  // section is a child (h2 under an h1). That way clicking 5.4 shows the whole
  // of section 5 (5, 5.1, 5.2, …) and we just scroll to the 5.4 heading. A
  // top-level section (or a child whose own h1 page we want) renders itself.
  const renderId = (activeId && parentById[activeId]) ? parentById[activeId] : activeId

  // When the active section is a child, this is the heading id to scroll to
  // inside the rendered parent page; null means "render at the top" (parent /
  // standalone section).
  const scrollToHeadingId = (activeId && parentById[activeId]) ? activeId : null

  // Navigating to a section = pushing its slug to the URL (activeId follows).
  const selectSection = (id: string) => navigate(`/help/whitepaper/${id}`)

  // --- Search state ------------------------------------------------------
  const [rawQuery, setRawQuery] = useState('')
  const [query, setQuery] = useState('') // debounced
  // The match we want the right pane to scroll to + highlight after navigation.
  // We anchor to the result's section heading and the Nth occurrence WITHIN that
  // section (counting only marks between this heading and the next one), so it
  // works whether the section renders standalone or inside its parent page.
  // `nonce` forces the scroll effect to re-run when clicking the same occurrence
  // twice (or another occurrence in the already-active section).
  const [scrollTarget, setScrollTarget] = useState<{ term: string; sectionId: string; occ: number; nonce: number } | null>(null)

  // Debounce typing so we don't recompute the whole index on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim()), 120)
    return () => clearTimeout(t)
  }, [rawQuery])

  // Clearing the search drops any pending match-scroll so subsequent plain
  // section navigation isn't blocked by a stale target.
  useEffect(() => {
    if (rawQuery.trim().length < 2) setScrollTarget(null)
  }, [rawQuery])

  // Plaintext projection of every section's SEARCH slice (parents = preamble
  // only, so child matches aren't double-counted under the parent), computed
  // once. Keyed by section id.
  const sectionPlainById = useMemo(() => {
    const out: Record<string, string> = {}
    for (const id of Object.keys(searchSliceById)) out[id] = mdToPlain(searchSliceById[id])
    return out
  }, [searchSliceById])

  // Label lookup (for showing the section title in results), in TOC order so
  // results read top-to-bottom like the document.
  const labelAndOrderById = useMemo(() => {
    const order: Array<{ id: string; label: string }> = []
    for (const item of toc) {
      order.push({ id: item.id, label: item.label })
      if ('children' in item) for (const c of item.children) order.push({ id: c.id, label: c.label })
    }
    return order
  }, [toc])

  // Per-section occurrences for the current query, in document order.
  const results: SectionResult[] = useMemo(() => {
    if (query.length < 2) return []
    const out: SectionResult[] = []
    for (const { id, label } of labelAndOrderById) {
      const plain = sectionPlainById[id]
      if (plain == null) continue
      // Search the label too, so a query that only hits the title still surfaces
      // the section (with no body snippet rows).
      const occurrences = findOccurrences(plain, query)
      const labelHit = label.toLowerCase().includes(query.toLowerCase())
      if (occurrences.length === 0 && !labelHit) continue
      out.push({ id, label, occurrences })
    }
    return out
  }, [query, labelAndOrderById, sectionPlainById])

  const totalMatches = useMemo(
    () => results.reduce((n, r) => n + r.occurrences.length, 0),
    [results]
  )

  const searching = query.length >= 2

  // Jump to a section + queue the right pane to scroll/highlight a given match.
  const gotoMatch = (id: string, occ: number) => {
    setScrollTarget({ term: query, sectionId: id, occ, nonce: Date.now() })
    if (id !== activeId) selectSection(id)
    setMobileNavOpen(false)
  }

  // Collapsible parents (dropdown-like). Default: expand the active section's parent.
  const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({})

  // If the URL has no (or an unknown) section, canonicalize to the default so the
  // address bar always reflects what's shown.
  useEffect(() => {
    if (initialId && (!sectionId || !sectionMdById[sectionId])) {
      navigate(`/help/whitepaper/${initialId}`, { replace: true })
    }
  }, [sectionId, initialId, sectionMdById, navigate])

  useEffect(() => {
    if (!activeId) return
    const parent = parentById[activeId] ?? (toc.find(i => 'children' in i && i.id === activeId) ? activeId : null)
    if (!parent) return
    setExpandedParents(prev => (prev[parent] ? prev : { ...prev, [parent]: true }))
  }, [activeId, parentById, toc])

  // --- Right-pane highlight + scroll -------------------------------------
  const mainRef = useRef<HTMLDivElement | null>(null)
  // Guards so incidental effect re-runs (theme toggle, typing) don't re-scroll:
  // the section auto-scroll fires once per distinct active section, and the
  // match-scroll fires once per distinct click (tracked by nonce).
  const lastScrolledSectionRef = useRef<string | null>(null)
  const lastScrolledMatchRef = useRef<number | null>(null)

  // The next heading element of equal-or-higher rank after `heading`, used to
  // bound one sub-section's content within a page that holds several. We treat
  // any h1/h2/h3 as a boundary, which is fine because results only target h1/h2.
  const nextHeadingAfter = (heading: HTMLElement): HTMLElement | null => {
    const root = mainRef.current
    if (!root) return null
    const all = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3'))
    const idx = all.indexOf(heading)
    return idx >= 0 && idx + 1 < all.length ? all[idx + 1] : null
  }

  // Strip any <mark data-wp-hl> wrappers we previously injected, restoring the
  // original text nodes. Called before re-highlighting and on cleanup.
  const clearHighlights = (root: HTMLElement) => {
    const marks = root.querySelectorAll('mark[data-wp-hl]')
    marks.forEach(m => {
      const parent = m.parentNode
      if (!parent) return
      parent.replaceChild(document.createTextNode(m.textContent ?? ''), m)
      parent.normalize() // merge adjacent text nodes back together
    })
  }

  // After the rendered page settles, do two things over the DOM the markdown
  // renderer produced (no md re-parse):
  //   1. If there's a search term, wrap every occurrence in <mark>.
  //   2. Scroll the right place into view — the targeted search match, else the
  //      active sub-section heading (when we're showing a child inside its
  //      parent page), else the top.
  useEffect(() => {
    const root = mainRef.current
    if (!root) return
    clearHighlights(root)

    const term = scrollTarget?.term ?? (searching ? query : '')

    // --- 1. Highlight every occurrence of the term, collecting the marks. -----
    const marks: HTMLElement[] = []
    if (term && term.length >= 2) {
      const needle = term.toLowerCase()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const textNodes: Text[] = []
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        // Skip text already inside code/pre where splitting would corrupt layout.
        if (node.parentElement?.closest('pre, code')) continue
        if (node.nodeValue && node.nodeValue.toLowerCase().includes(needle)) textNodes.push(node)
      }
      for (const node of textNodes) {
        const text = node.nodeValue ?? ''
        const lower = text.toLowerCase()
        const frag = document.createDocumentFragment()
        let from = 0
        let at = lower.indexOf(needle, from)
        if (at === -1) continue
        while (at !== -1) {
          if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)))
          const mark = document.createElement('mark')
          mark.setAttribute('data-wp-hl', '')
          mark.textContent = text.slice(at, at + needle.length)
          mark.className = isDark
            ? 'bg-yellow-400/30 text-yellow-200 rounded-sm'
            : 'bg-yellow-300/70 text-black rounded-sm'
          frag.appendChild(mark)
          marks.push(mark)
          from = at + needle.length
          at = lower.indexOf(needle, from)
        }
        if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)))
        node.parentNode?.replaceChild(frag, node)
      }
    }

    // --- 2. Decide where to scroll. ------------------------------------------
    // The effect re-runs on incidental changes too (theme toggle, typing in the
    // search box), so we gate each scroll behind a ref that remembers what it
    // last acted on — never yank the reader's scroll position on a re-render
    // that didn't actually change the navigation/match target.

    // (a) A search match was just clicked (scrollTarget carries a fresh nonce).
    if (scrollTarget && scrollTarget.nonce !== lastScrolledMatchRef.current && marks.length) {
      lastScrolledMatchRef.current = scrollTarget.nonce
      // The result counts occurrences within its OWN section, but `marks` spans
      // the whole rendered page (which may include sibling sub-sections).
      // Restrict to marks between this heading and the next, then index in.
      const heading = root.querySelector<HTMLElement>(`#${CSS.escape(scrollTarget.sectionId)}`)
      let scoped = marks
      if (heading) {
        const stop = nextHeadingAfter(heading)
        scoped = marks.filter(m => {
          const after = heading.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING
          const beforeStop = !stop || (stop.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_PRECEDING)
          return after && beforeStop
        })
      }
      const pick = scoped.length ? scoped : marks
      const target = pick[Math.min(scrollTarget.occ, pick.length - 1)]
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const ring = isDark ? 'ring-2 ring-yellow-300/70' : 'ring-2 ring-yellow-500/70'
        target.classList.add(...ring.split(' '))
        const t = setTimeout(() => target.classList.remove(...ring.split(' ')), 1600)
        return () => { clearTimeout(t); clearHighlights(root) }
      }
    }
    // (b) Navigation to a new page/sub-section (no match click). Fire once per
    //     distinct active section: scroll to the sub-section heading, or to the
    //     top for a parent / standalone section.
    else if (!scrollTarget && activeId !== lastScrolledSectionRef.current) {
      lastScrolledSectionRef.current = activeId
      const heading = scrollToHeadingId
        ? root.querySelector<HTMLElement>(`#${CSS.escape(scrollToHeadingId)}`)
        : null
      if (heading) heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
      else root.scrollIntoView({ behavior: 'auto', block: 'start' })
    }

    // `root` is captured at effect start; safe to use in cleanup (the node we marked).
    return () => clearHighlights(root)
    // Re-run when the rendered page changes, when the active sub-section changes,
    // when the term changes, or when a new occurrence is targeted (nonce).
  }, [renderId, activeId, scrollToHeadingId, query, searching, scrollTarget, isDark])

  const mdComponents = useMemo(() => {
    const toText = (children: any): string => {
      if (children == null) return ''
      if (typeof children === 'string') return children
      if (Array.isArray(children)) return children.map(toText).join('')
      if (typeof children === 'object' && 'props' in children) return toText((children as any).props?.children)
      return ''
    }

    // Render heading text, turning ==highlighted== spans gold so the most
    // important word(s) of a title pop (authored per-heading in WHITEPAPER.md).
    // The slug id is computed from the marker-free text so anchors stay stable.
    const renderHighlighted = (text: string) => {
      const parts = text.split(/==(.+?)==/g) // odd indices are the highlighted bits
      return parts.map((part, i) =>
        i % 2 === 1
          ? <span key={i} className="text-yellow-400">{part}</span>
          : part
      )
    }

    const Heading = (Tag: any, level: number) => {
      return ({ children, ...rest }: any) => {
        const raw = toText(children).trim()
        const label = raw.replace(/==/g, '') // marker-free for slug/anchor
        const id = headingIdFor(label)
        const cls = level === 1
          ? 'mt-10 first:mt-0 text-2xl sm:text-3xl font-bold'
          : level === 2
            ? 'mt-8 text-xl sm:text-2xl font-semibold'
            : 'mt-6 text-lg font-semibold'
        // If the heading carried a ==marker==, render our highlighted version;
        // otherwise pass children through untouched (preserves any inline md).
        const content = raw.includes('==') ? renderHighlighted(raw) : children
        // scroll-margin-top so anchor scrolls (search jumps, sub-section nav)
        // leave the heading clear of the ~4.75rem fixed LandingHeader.
        return <Tag id={id} className={cls} style={{ scrollMarginTop: '5.5rem' }} {...rest}>{content}</Tag>
      }
    }

    return {
      h1: Heading('h1', 1),
      h2: Heading('h2', 2),
      h3: Heading('h3', 3),
      p: ({ children }: any) => <p className={isDark ? 'mt-3 text-white/70 leading-relaxed' : 'mt-3 text-black/70 leading-relaxed'}>{children}</p>,
      // Bold pops brighter than the muted body text — white in dark mode,
      // full-strength near-black in light mode.
      strong: ({ children }: any) => <strong className={isDark ? 'font-semibold text-white' : 'font-semibold text-black'}>{children}</strong>,
      // The source markdown uses thematic breaks (---) as section dividers.
      // In our UI they look like random horizontal rules, so we suppress them.
      hr: () => null,
      a: ({ href, children }: any) => (
        <a href={href} className="underline underline-offset-4 hover:opacity-90" target={href?.startsWith('http') ? '_blank' : undefined} rel={href?.startsWith('http') ? 'noreferrer' : undefined}>
          {children}
        </a>
      ),
      ul: ({ children }: any) => <ul className="mt-3 list-disc pl-6 space-y-1">{children}</ul>,
      ol: ({ children }: any) => <ol className="mt-3 list-decimal pl-6 space-y-1">{children}</ol>,
      li: ({ children }: any) => {
        // Definition-style item: "`Term` — description". When a list item starts
        // with an inline-code term immediately followed by an em-dash, render that
        // leading term highlighted (bold gold) so the defined thing stands out.
        const kids = Array.isArray(children) ? children : [children]
        const first = kids[0]
        const second = kids[1]
        const isCodeEl = first && typeof first === 'object' && (first as any).type === 'code'
        const secondText = typeof second === 'string' ? second : ''
        if (isCodeEl && /^\s*[—–-]\s/.test(secondText)) {
          const termText = toText((first as any).props?.children).trim()
          const goldCls = isDark ? 'font-semibold text-yellow-400' : 'font-semibold text-yellow-700'
          const repoPath = REPO_FILES[termText]
          // If the defined term is a linkable repo file, keep it clickable AND
          // highlighted; otherwise just highlight it.
          const styled = repoPath ? (
            <a key="term" href={REPO_BASE + repoPath} target="_blank" rel="noreferrer"
              className={`${goldCls} underline decoration-dotted underline-offset-2 hover:opacity-90`}>
              {termText}
            </a>
          ) : (
            <strong key="term" className={goldCls}>{termText}</strong>
          )
          return <li className={isDark ? 'text-white/70' : 'text-black/70'}>{[styled, ...kids.slice(1)]}</li>
        }
        return <li className={isDark ? 'text-white/70' : 'text-black/70'}>{children}</li>
      },
      blockquote: ({ children }: any) => (
        <blockquote className={isDark ? 'mt-4 border-l-2 border-white/20 pl-4 text-white/70 italic' : 'mt-4 border-l-2 border-black/10 pl-4 text-black/70 italic'}>
          {children}
        </blockquote>
      ),
      code: ({ inline, children }: any) => {
        if (inline) {
          // All inline code renders bold + bright (white on dark / black on light)
          // so identifiers, fields, and call signatures all pop from the body text.
          const codeCls = isDark
            ? 'px-1 py-0.5 rounded bg-white/10 font-semibold text-white'
            : 'px-1 py-0.5 rounded bg-black/10 font-semibold text-black'
          // Known repo file references additionally link to GitHub source. Unknown
          // refs (or internal files not in the map) stay plain so we never emit a
          // dead link.
          const token = toText(children).trim()
          const repoPath = REPO_FILES[token]
          if (repoPath) {
            return (
              <a href={REPO_BASE + repoPath} target="_blank" rel="noreferrer"
                className={`${codeCls} underline decoration-dotted underline-offset-2 hover:opacity-90`}>
                {children}
              </a>
            )
          }
          return <code className={codeCls}>{children}</code>
        }
        return <code>{children}</code>
      },
      pre: ({ children }: any) => (
        <pre className={isDark ? 'mt-4 p-4 rounded-lg bg-black/60 border border-white/10 overflow-auto text-sm' : 'mt-4 p-4 rounded-lg bg-white/80 border border-black/10 overflow-auto text-sm'}>
          {children}
        </pre>
      ),
      table: ({ children }: any) => (
        <div className="mt-5 overflow-auto">
          <table className={isDark ? 'min-w-full text-sm border border-white/10' : 'min-w-full text-sm border border-black/10'}>
            {children}
          </table>
        </div>
      ),
      thead: ({ children }: any) => <thead className={isDark ? 'bg-white/5' : 'bg-black/5'}>{children}</thead>,
      th: ({ children }: any) => <th className={isDark ? 'text-left px-3 py-2 border-b border-white/10 font-semibold text-white/80' : 'text-left px-3 py-2 border-b border-black/10 font-semibold text-black/80'}>{children}</th>,
      td: ({ children }: any) => <td className={isDark ? 'px-3 py-2 border-b border-white/5 text-white/70' : 'px-3 py-2 border-b border-black/5 text-black/70'}>{children}</td>,
    }
  }, [isDark, headingIdFor])

  const activeMd = renderId ? (sectionMdById[renderId] ?? '') : ''

  // Render a snippet string with the matched substring (given its offsets)
  // emphasized — gold + bold, matching the doc's highlight idiom.
  const renderSnippet = (occ: Occurrence) => {
    const { snippet, matchStart, matchEnd } = occ
    const before = snippet.slice(0, matchStart)
    const hit = snippet.slice(matchStart, matchEnd)
    const after = snippet.slice(matchEnd)
    const hitCls = isDark ? 'font-semibold text-yellow-300' : 'font-semibold text-yellow-700'
    return (
      <>
        {before}
        <span className={hitCls}>{hit}</span>
        {after}
      </>
    )
  }

  return (
    <div className={isDark ? 'relative h-[100svh] bg-black text-white overflow-hidden flex flex-col' : 'relative h-[100svh] bg-white text-black overflow-hidden flex flex-col'}>
      {/* Blurred backing strip behind the header. WhitepaperPage scrolls
          its content in an inner overflow area while the header stays put,
          so without this the scrolling text shows through the (transparent)
          LandingHeader. z-10 sits above the content, below the header (z-20). */}
      <div
        className={`absolute top-0 left-0 right-0 h-[4.75rem] z-10 pointer-events-none border-b backdrop-blur ${
          isDark ? 'bg-black/70 border-white/10' : 'bg-white/80 border-gray-200'
        }`}
      />
      {/* Shared landing header — same logo + resource links + language
          picker as welcome / manifesto. Replaces the old /docs-style bar. */}
      <LandingHeader />

      <div className="flex-1 overflow-y-auto">
        {/* pt-20 clears the absolutely-positioned LandingHeader. */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-20 pb-6 min-w-0">
        {/* Mobile TOC toggle — LandingHeader has no hamburger, so the
            sidebar collapse control lives here on small screens. */}
        <button
          type="button"
          onClick={() => setMobileNavOpen(v => !v)}
          className={isDark
            ? 'lg:hidden mb-4 px-3 py-2 rounded-md border border-white/15 hover:border-white/30 hover:bg-white/5 text-sm flex items-center gap-2'
            : 'lg:hidden mb-4 px-3 py-2 rounded-md border border-black/10 hover:border-black/20 hover:bg-black/5 text-sm flex items-center gap-2'
          }
          aria-label="Toggle navigation"
        >
          <span aria-hidden>≡</span>
          <span>Contents</span>
        </button>
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 min-w-0">
        {/* Sidebar */}
        <aside className={`${mobileNavOpen ? 'block' : 'hidden'} lg:block min-w-0`}
          aria-label="Whitepaper navigation"
        >
          <div className={isDark
            ? 'rounded-xl border border-white/10 bg-black/60 p-3 lg:sticky lg:top-20 lg:max-h-[calc(100svh-9rem)] overflow-y-auto overscroll-contain thin-scrollbar'
            : 'rounded-xl border border-gray-200 bg-white/80 p-3 lg:sticky lg:top-20 lg:max-h-[calc(100svh-9rem)] overflow-y-auto overscroll-contain thin-scrollbar'
          }>
            <div className={isDark ? 'text-xs uppercase tracking-wider text-white/50 px-2 py-2' : 'text-xs uppercase tracking-wider text-black/50 px-2 py-2'}>
              Whitepaper
            </div>

            {/* Local search over the whitepaper. Filters the sidebar to matching
                sections and quotes each occurrence; clicking jumps to it. */}
            <div className="px-1 pb-2">
              <div className={`relative flex items-center rounded-lg border ${
                isDark ? 'border-white/10 bg-white/5 focus-within:border-white/25' : 'border-black/10 bg-black/5 focus-within:border-black/25'
              }`}>
                <HiSearch className={`absolute left-2.5 w-4 h-4 ${isDark ? 'text-white/40' : 'text-black/40'}`} aria-hidden />
                <input
                  type="search"
                  value={rawQuery}
                  onChange={e => setRawQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') setRawQuery('')
                    // Enter jumps to the first match, if any.
                    if (e.key === 'Enter' && results.length && results[0].occurrences.length) {
                      gotoMatch(results[0].id, 0)
                    } else if (e.key === 'Enter' && results.length) {
                      selectSection(results[0].id); setMobileNavOpen(false)
                    }
                  }}
                  placeholder="Search the whitepaper…"
                  aria-label="Search the whitepaper"
                  className={`w-full bg-transparent outline-none text-sm pl-8 pr-7 py-2 ${
                    isDark ? 'text-white placeholder:text-white/40' : 'text-black placeholder:text-black/40'
                  }`}
                />
                {rawQuery && (
                  <button
                    type="button"
                    onClick={() => setRawQuery('')}
                    aria-label="Clear search"
                    className={`absolute right-1.5 p-1 rounded ${isDark ? 'text-white/50 hover:text-white hover:bg-white/10' : 'text-black/50 hover:text-black hover:bg-black/10'}`}
                  >
                    <HiX className="w-4 h-4" />
                  </button>
                )}
              </div>
              {searching && (
                <div className={`px-1.5 pt-2 text-xs ${isDark ? 'text-white/45' : 'text-black/45'}`}>
                  {totalMatches === 0
                    ? `No matches for “${query}”`
                    : `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${results.length} section${results.length === 1 ? '' : 's'}`}
                </div>
              )}
            </div>

            {/* Results mode: a flat, document-ordered list of matching sections,
                each with its occurrences quoted. Clicking jumps + highlights. */}
            {searching ? (
              <div className="flex flex-col gap-3 pt-1">
                {results.map(r => (
                  <div key={r.id}>
                    <button
                      type="button"
                      onClick={() => { selectSection(r.id); setMobileNavOpen(false) }}
                      className={`w-full text-left px-2 py-1.5 rounded-lg text-sm font-medium ${
                        isDark
                          ? `hover:bg-white/10 ${activeId === r.id ? 'bg-white/10 text-white' : 'text-white/85'}`
                          : `hover:bg-black/10 ${activeId === r.id ? 'bg-black/10 text-black' : 'text-black/85'}`
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate">{r.label}</span>
                        {r.occurrences.length > 0 && (
                          <span className={`shrink-0 text-[11px] tabular-nums px-1.5 py-0.5 rounded-full ${
                            isDark ? 'bg-white/10 text-white/60' : 'bg-black/10 text-black/55'
                          }`}>
                            {r.occurrences.length}
                          </span>
                        )}
                      </span>
                    </button>
                    {/* Every occurrence as its own quoted row. */}
                    <div className="mt-1 flex flex-col gap-1 pl-2">
                      {r.occurrences.map(occ => (
                        <button
                          key={occ.index}
                          type="button"
                          onClick={() => gotoMatch(r.id, occ.index)}
                          className={`group text-left text-xs leading-snug rounded-md px-2 py-1.5 border-l-2 ${
                            isDark
                              ? 'border-white/10 text-white/55 hover:border-yellow-300/60 hover:bg-white/5 hover:text-white/80'
                              : 'border-black/10 text-black/55 hover:border-yellow-500/60 hover:bg-black/5 hover:text-black/80'
                          }`}
                        >
                          {renderSnippet(occ)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
            <nav className="flex flex-col gap-1">
              {toc.map(item => {
                // Parent section
                if ('children' in item) {
                  const isActiveParent = activeId === item.id
                  const isExpanded = expandedParents[item.id] ?? false
                  const hasChildren = item.children.length > 0
                  return (
                    <div key={item.id} className="space-y-1">
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedParents(prev => ({ ...prev, [item.id]: !(prev[item.id] ?? false) }))
                          selectSection(item.id)
                          setMobileNavOpen(false)
                        }}
                        className={
                          (isDark
                            ? `w-full text-left px-2 py-2 rounded-lg text-sm hover:bg-white/10 ${isActiveParent ? 'bg-white/10 text-white' : 'text-white/80'}`
                            : `w-full text-left px-2 py-2 rounded-lg text-sm hover:bg-black/10 ${isActiveParent ? 'bg-black/10 text-black' : 'text-black/80'}`
                          )
                        }
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate">{item.label}</span>
                          {hasChildren && (
                            <span className={isDark ? 'text-white/50' : 'text-black/40'}>
                              <HiChevronRight
                                className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-90' : 'rotate-0'}`}
                              />
                            </span>
                          )}
                        </span>
                      </button>

                      {hasChildren && (
                        <div
                          className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out pl-3 ${
                            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                          }`}
                        >
                          <div className="min-h-0 overflow-hidden">
                            <div className="space-y-1 py-0.5">
                              {item.children.map(child => {
                                const isActiveChild = activeId === child.id
                                return (
                                  <button
                                    key={child.id}
                                    type="button"
                                    onClick={() => { selectSection(child.id); setMobileNavOpen(false) }}
                                    className={
                                      (isDark
                                        ? `w-full text-left px-2 py-2 rounded-lg text-sm hover:bg-white/10 ${isActiveChild ? 'bg-white/10 text-white' : 'text-white/70'}`
                                        : `w-full text-left px-2 py-2 rounded-lg text-sm hover:bg-black/10 ${isActiveChild ? 'bg-black/10 text-black' : 'text-black/70'}`
                                      )
                                    }
                                  >
                                    {child.label}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                }

                // Top-level h2 (foreword / toc etc)
                const isActive = activeId === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => { selectSection(item.id); setMobileNavOpen(false) }}
                    className={
                      (isDark
                        ? `w-full text-left px-2 py-2 rounded-lg text-sm hover:bg-white/10 ${isActive ? 'bg-white/10 text-white' : 'text-white/80'}`
                        : `w-full text-left px-2 py-2 rounded-lg text-sm hover:bg-black/10 ${isActive ? 'bg-black/10 text-black' : 'text-black/80'}`
                      )
                    }
                  >
                    {item.label}
                  </button>
                )
              })}
            </nav>
            )}
          </div>
        </aside>

        {/* Content */}
        <main ref={mainRef} className={`min-w-0 ${isDark ? 'rounded-xl border border-white/10 bg-black/40 p-6' : 'rounded-xl border border-gray-200 bg-white/60 p-6'}`}>
          {activeMd ? (
            <>
              {/* Reset the heading slugger so this page's anchor ids start clean
                  (see resetRenderSlugger). Runs synchronously before the
                  markdown children below are rendered. */}
              {resetRenderSlugger()}
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents as any}>
                {activeMd}
              </ReactMarkdown>
            </>
          ) : (
            <div className={isDark ? 'text-white/60' : 'text-black/60'}>
              No section selected.
            </div>
          )}
        </main>
        </div>
        </div>
        <LandingFooter />
      </div>
    </div>
  )
}

export default WhitepaperPage
