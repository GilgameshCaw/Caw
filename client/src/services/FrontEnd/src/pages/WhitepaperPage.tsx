import React, { useEffect, useMemo, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { Link } from '~/utils/localizedRouter'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import GithubSlugger from 'github-slugger'
import { HiChevronRight } from 'react-icons/hi'

// Source of truth: repo root docs/WHITEPAPER.md
// Vite allows workspace-root file access via searchForWorkspaceRoot().
import whitepaperMd from '../../../../../../docs/WHITEPAPER.md?raw'

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
      const label = m[2].replace(/\s+#+\s*$/, '').trim()
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

  const [activeId, setActiveId] = useState<string>('')

  // Collapsible parents (dropdown-like). Default: expand the active section's parent.
  const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!activeId && initialId) setActiveId(initialId)
  }, [activeId, initialId])

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

    const Heading = (Tag: any, level: number) => {
      return ({ children, ...rest }: any) => {
        const label = toText(children).trim()
        const id = headingIdFor(label)
        const cls = level === 1
          ? 'mt-10 first:mt-0 text-2xl sm:text-3xl font-bold'
          : level === 2
            ? 'mt-8 text-xl sm:text-2xl font-semibold'
            : 'mt-6 text-lg font-semibold'
        return <Tag id={id} className={cls} {...rest}>{children}</Tag>
      }
    }

    return {
      h1: Heading('h1', 1),
      h2: Heading('h2', 2),
      h3: Heading('h3', 3),
      p: ({ children }: any) => <p className={isDark ? 'mt-3 text-white/70 leading-relaxed' : 'mt-3 text-black/70 leading-relaxed'}>{children}</p>,
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
      li: ({ children }: any) => <li className={isDark ? 'text-white/70' : 'text-black/70'}>{children}</li>,
      blockquote: ({ children }: any) => (
        <blockquote className={isDark ? 'mt-4 border-l-2 border-white/20 pl-4 text-white/70 italic' : 'mt-4 border-l-2 border-black/10 pl-4 text-black/70 italic'}>
          {children}
        </blockquote>
      ),
      code: ({ inline, children }: any) => {
        if (inline) {
          return <code className={isDark ? 'px-1 py-0.5 rounded bg-white/10 text-white/90' : 'px-1 py-0.5 rounded bg-black/10 text-black/90'}>{children}</code>
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
    <div className={isDark ? 'h-[100svh] bg-black text-white overflow-hidden flex flex-col' : 'h-[100svh] bg-white text-black overflow-hidden flex flex-col'}>
      {/* Minimal /docs-like shell: top header + left nav + content. */}
      <div className={isDark ? 'sticky top-0 z-50 border-b border-white/10 bg-black/60 backdrop-blur' : 'sticky top-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur'}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileNavOpen(v => !v)}
            className={isDark
              ? 'lg:hidden w-9 h-9 rounded-md border border-white/15 hover:border-white/30 hover:bg-white/5'
              : 'lg:hidden w-9 h-9 rounded-md border border-black/10 hover:border-black/20 hover:bg-black/5'
            }
            aria-label="Toggle navigation"
          >
            <div className="w-full h-full flex items-center justify-center">
              <div className={isDark ? 'text-white/80' : 'text-black/70'}>≡</div>
            </div>
          </button>

          {/* Breadcrumb-ish header like caw-landing /docs */}
          <div className={isDark ? 'text-white/70 text-sm' : 'text-black/70 text-sm'}>
            <span className={isDark ? 'hidden md:inline text-white/50' : 'hidden md:inline text-black/50'}>
              Building Your Application
            </span>
            <span className={isDark ? 'hidden md:inline text-white/40 px-2' : 'hidden md:inline text-black/30 px-2'}>
              /
            </span>
            <span className={isDark ? 'text-white' : 'text-black'}>
              Whitepaper
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/help/resources"
              className={isDark
                ? 'px-3 py-1.5 rounded-md border border-white/15 hover:border-white/30 hover:bg-white/5 text-sm'
                : 'px-3 py-1.5 rounded-md border border-black/10 hover:border-black/20 hover:bg-black/5 text-sm'
              }
            >
              Resources
            </Link>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 min-w-0">
        {/* Sidebar */}
        <aside className={`${mobileNavOpen ? 'block' : 'hidden'} lg:block min-w-0`}
          aria-label="Whitepaper navigation"
        >
          <div className={isDark
            ? 'rounded-xl border border-white/10 bg-black/60 p-3 lg:sticky lg:top-6 lg:max-h-[calc(100svh-7.5rem)] overflow-y-auto overscroll-contain thin-scrollbar'
            : 'rounded-xl border border-gray-200 bg-white/80 p-3 lg:sticky lg:top-6 lg:max-h-[calc(100svh-7.5rem)] overflow-y-auto overscroll-contain thin-scrollbar'
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
                          setActiveId(item.id)
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
                                    onClick={() => { setActiveId(child.id); setMobileNavOpen(false) }}
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
                    onClick={() => { setActiveId(item.id); setMobileNavOpen(false) }}
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
    </div>
  )
}

export default WhitepaperPage
