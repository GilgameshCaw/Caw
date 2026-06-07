import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useNavigate } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import GithubSlugger from 'github-slugger'
import { HiChevronRight } from 'react-icons/hi'

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

const WhitepaperPage: React.FC = () => {
  const { isDark } = useTheme()

  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  type TocChild = { id: string; label: string; depth: 2 }
  type TocParent = { id: string; label: string; depth: 1; children: TocChild[] }
  type TocItem = TocParent | { id: string; label: string; depth: 2 }

  const { toc, sectionMdById, headingIdFor, initialId, parentById } = useMemo(() => {
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
    const sectionMdById: Record<string, string> = {}
    for (let idx = 0; idx < headings.length; idx++) {
      const h = headings[idx]
      // Skip doc title slice.
      if (h.depth === 1 && idx === 0) continue

      const start = h.line
      let end = lines.length
      for (let j = idx + 1; j < headings.length; j++) {
        const next = headings[j]
        if (h.depth === 1) {
          if (next.depth === 1) { end = next.line; break }
        } else {
          // h2 ends at next h1 OR next h2.
          if (next.depth === 1 || next.depth === 2) { end = next.line; break }
        }
      }
      sectionMdById[h.id] = lines.slice(start, end).join('\n').trim() + '\n'
    }

    // Heading ids during render must match the ids we computed above.
    const renderSlugger = new GithubSlugger()
    const headingIdFor = (label: string) => renderSlugger.slug(label)

    // Default section: Foreword if present; otherwise first TOC item.
    const foreword = headings.find(h => h.label.toLowerCase() === 'foreword')
    const initialId = foreword?.id ?? toc[0]?.id ?? ''

    return { toc, sectionMdById, headingIdFor, initialId, parentById }
  }, [])

  // The URL is the source of truth for the active section, so each section is
  // deep-linkable and back/forward works. /help/whitepaper/<section-slug>.
  const { sectionId } = useParams<{ sectionId?: string }>()
  const navigate = useNavigate()

  // The active section resolves from the URL param when it's a known section,
  // otherwise the default (Foreword / first). No separate state to drift.
  const activeId = (sectionId && sectionMdById[sectionId]) ? sectionId : initialId

  // Navigating to a section = pushing its slug to the URL (activeId follows).
  const selectSection = (id: string) => navigate(`/help/whitepaper/${id}`)

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
        return <Tag id={id} className={cls} {...rest}>{content}</Tag>
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

  const activeMd = activeId ? (sectionMdById[activeId] ?? '') : ''

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
          </div>
        </aside>

        {/* Content */}
        <main className={`min-w-0 ${isDark ? 'rounded-xl border border-white/10 bg-black/40 p-6' : 'rounded-xl border border-gray-200 bg-white/60 p-6'}`}>
          {activeMd ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents as any}>
              {activeMd}
            </ReactMarkdown>
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
