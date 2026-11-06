// Read <meta> tags and <title> out of a fetched page without a regex over the
// whole document. Patterns like /<meta[^>]+property=.../ retry from every
// "<meta" and run to the next ">" each time, so a page of unclosed tags costs
// quadratic time, and a regex blocks the event loop while it runs. The work here
// is linear in the page size: a tag that never closes costs at most one window.

// Real meta tags are far shorter. A longer one is skipped, along with the whole
// window, so hostile input can't be rescanned.
const MAX_TAG_LENGTH = 8192

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'

// Parses the attributes of a tag from `start`, just after its name. `end` is
// where the caller resumes. `attrs` is null if the tag didn't close in the window.
function readTagAttributes(html: string, start: number): { attrs: Map<string, string> | null; end: number } {
  const limit = Math.min(start + MAX_TAG_LENGTH, html.length)
  const attrs = new Map<string, string>()
  let i = start
  while (i < limit) {
    const c = html[i]
    if (c === '>') return { attrs, end: i + 1 }
    if (isSpace(c) || c === '/') { i++; continue }

    const nameStart = i
    while (i < limit && !isSpace(html[i]) && html[i] !== '=' && html[i] !== '>' && html[i] !== '/') i++
    const name = html.slice(nameStart, i).toLowerCase()
    while (i < limit && isSpace(html[i])) i++
    if (html[i] !== '=') continue
    i++
    while (i < limit && isSpace(html[i])) i++
    if (i >= limit) break

    let value: string
    const quote = html[i]
    if (quote === '"' || quote === "'") {
      // Quoted, so a ">" inside the value doesn't end the tag.
      const close = html.slice(i + 1, limit).indexOf(quote)
      if (close === -1) break
      value = html.slice(i + 1, i + 1 + close)
      i += close + 2
    } else {
      const valueStart = i
      while (i < limit && !isSpace(html[i]) && html[i] !== '>') i++
      value = html.slice(valueStart, i)
    }
    if (!attrs.has(name)) attrs.set(name, value)
  }
  return { attrs: null, end: limit }
}

export type MetaTags = {
  /** Value of `content` on the first non-empty tag with this `property` or `name`. */
  property(key: string): string | undefined
  name(key: string): string | undefined
}

export function readMetaTags(html: string): MetaTags {
  const byProperty = new Map<string, string>()
  const byName = new Map<string, string>()
  const open = /<meta(?=[\s/])/gi
  while (open.exec(html)) {
    const { attrs, end } = readTagAttributes(html, open.lastIndex)
    open.lastIndex = end
    const content = attrs?.get('content')
    if (!content) continue
    const property = attrs?.get('property')?.toLowerCase()
    const name = attrs?.get('name')?.toLowerCase()
    if (property && !byProperty.has(property)) byProperty.set(property, content)
    if (name && !byName.has(name)) byName.set(name, content)
  }
  return {
    property: key => byProperty.get(key),
    name: key => byName.get(key),
  }
}

// The text of the first <title> that holds only text.
export function readTitle(html: string): string | undefined {
  const open = /<title(?=[\s>])/gi
  while (open.exec(html)) {
    const textStart = html.indexOf('>', open.lastIndex) + 1
    if (textStart === 0) return undefined
    const textEnd = html.indexOf('<', textStart)
    if (textEnd === -1) return undefined
    if (textEnd > textStart && html.slice(textEnd, textEnd + 8).toLowerCase() === '</title>') {
      return html.slice(textStart, textEnd)
    }
    open.lastIndex = textStart
  }
  return undefined
}
