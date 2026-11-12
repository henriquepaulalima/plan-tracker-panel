// The plan view's own Markdown reader: blocks the panel draws itself, so it can
// pad them, fit tables to its width, frame code and highlight search matches.

export type Span = {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  link?: string
}

export type Align = 'left' | 'right' | 'center'

export type ListItem = { depth: number; marker: string; checked?: 'done' | 'open' | 'partial' | 'skipped'; spans: Span[] }

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'quote'; paragraphs: Span[][] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'code'; language?: string; source: string }
  | { kind: 'table'; align: Align[]; header: string[]; rows: string[][] }
  | { kind: 'rule' }

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const CHECK = /^\[([ xX~/-])\]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const CHECKS: Record<string, ListItem['checked']> = {
  ' ': 'open',
  x: 'done',
  X: 'done',
  '~': 'partial',
  '/': 'partial',
  '-': 'skipped',
}

// Inline markup, in the order tried at each position.
const INLINE =
  /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(?!\s)([^*]+?)\*|(?<![\p{L}\p{N}])_(?!\s)([^_]+?)_(?![\p{L}\p{N}])|\[([^\]]+)\]\(([^)\s]+)\)/u

export function inline(text: string, style: Omit<Span, 'text'> = {}): Span[] {
  const spans: Span[] = []
  let rest = text

  while (rest !== '') {
    const match = INLINE.exec(rest)
    if (match === null) {
      spans.push({ ...style, text: rest })
      break
    }
    if (match.index > 0) spans.push({ ...style, text: rest.slice(0, match.index) })

    const [, , code, bold1, bold2, strike, italic1, italic2, label, href] = match
    if (code !== undefined) spans.push({ ...style, code: true, text: code })
    else if (bold1 !== undefined || bold2 !== undefined) spans.push(...inline(bold1 ?? bold2 ?? '', { ...style, bold: true }))
    else if (strike !== undefined) spans.push(...inline(strike, { ...style, strike: true }))
    else if (italic1 !== undefined || italic2 !== undefined) {
      spans.push(...inline(italic1 ?? italic2 ?? '', { ...style, italic: true }))
    } else if (label !== undefined) spans.push(...inline(label, { ...style, link: href }))

    rest = rest.slice(match.index + match[0].length)
  }

  return spans
}

export function plain(spans: readonly Span[]): string {
  return spans.map(span => span.text).join('')
}

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')

  return inner.split(/(?<!\\)\|/).map(cell => plain(inline(cell.trim().replace(/\\\|/g, '|'))))
}

function alignments(rule: string): Align[] {
  return rule
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => {
      const one = cell.trim()
      if (one.startsWith(':') && one.endsWith(':')) return 'center'
      if (one.endsWith(':')) return 'right'
      return 'left'
    })
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    LIST.test(line) ||
    QUOTE.test(line) ||
    (TABLE_ROW.test(line) && next !== undefined && TABLE_RULE.test(next))
  )
}

export function readDocument(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/)
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1]?.[0] === '~' ? '~' : '`'}{${fence[1]?.length ?? 3},}\\s*$`)
      const body: string[] = []
      i += 1
      while (i < lines.length && !close.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i += 1
      blocks.push({ kind: 'code', language: fence[2] || undefined, source: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, spans: inline(heading[2] ?? '') })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }

    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const header = cells(line)
      const align = alignments(lines[i + 1] ?? '')
      const rows: string[][] = []
      i += 2
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) rows.push(cells(lines[i++] ?? ''))
      const width = Math.max(header.length, ...rows.map(row => row.length))
      const pad = (row: string[]) => Array.from({ length: width }, (_, c) => row[c] ?? '')
      blocks.push({
        kind: 'table',
        align: Array.from({ length: width }, (_, c) => align[c] ?? 'left'),
        header: pad(header),
        rows: rows.map(pad),
      })
      continue
    }

    if (QUOTE.test(line)) {
      const paragraphs: string[][] = [[]]
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        const text = QUOTE.exec(lines[i] ?? '')?.[1] ?? ''
        if (text.trim() === '') paragraphs.push([])
        else paragraphs[paragraphs.length - 1]?.push(text.trim())
        i += 1
      }
      blocks.push({
        kind: 'quote',
        paragraphs: paragraphs.filter(one => one.length > 0).map(one => inline(one.join(' '))),
      })
      continue
    }

    if (LIST.test(line)) {
      const items: (ListItem & { text: string })[] = []
      const indents: number[] = []
      const isOrdered = (marker: string | undefined) => /^\d/.test(marker ?? '')
      const firstOrdered = isOrdered(LIST.exec(line)?.[2])
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const item = LIST.exec(current)
        if (item) {
          const indent = item[1]?.length ?? 0
          // A list of the other kind at the outer level starts a list of its own.
          if (items.length > 0 && indent <= (indents[0] ?? 0) && isOrdered(item[2]) !== firstOrdered) break
          while (indents.length > 0 && (indents[indents.length - 1] ?? 0) > indent) indents.pop()
          if (indents.length === 0 || (indents[indents.length - 1] ?? 0) < indent) indents.push(indent)
          const check = CHECK.exec(item[3] ?? '')
          const marker = /^\d/.test(item[2] ?? '') ? (item[2] ?? '') : '•'
          items.push({
            depth: indents.length - 1,
            marker,
            ...(check ? { checked: CHECKS[check[1] ?? ' '] } : {}),
            text: check ? (check[2] ?? '') : (item[3] ?? ''),
            spans: [],
          })
          i += 1
          continue
        }
        // A blank line ends the list unless another item follows it.
        if (current.trim() === '') {
          if (LIST.test(lines[i + 1] ?? '')) {
            i += 1
            continue
          }
          break
        }
        // An indented line goes on with the item above it.
        if (/^\s+\S/.test(current) && items.length > 0) {
          const last = items[items.length - 1]
          if (last) last.text += ` ${current.trim()}`
          i += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', items: items.map(({ text, ...item }) => ({ ...item, spans: inline(text) })) })
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !isBlockStart(lines[i] ?? '', lines[i + 1])) {
      paragraph.push((lines[i] ?? '').trim())
      i += 1
    }
    if (paragraph.length === 0) {
      // A line no rule above took: drawn as it stands rather than looping on it.
      paragraph.push(line.trim())
      i += 1
    }
    blocks.push({ kind: 'paragraph', spans: inline(paragraph.join(' ')) })
  }

  return blocks
}

// The texts search runs over, in reading order, each in a unit the panel can
// scroll to: one per heading, paragraph, quote, list item, table row, code line.
export type Piece = { unit: number; text: string }

export function pieces(block: Block): Piece[] {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
      return [{ unit: 0, text: plain(block.spans) }]
    case 'quote':
      return block.paragraphs.map((spans, unit) => ({ unit, text: plain(spans) }))
    case 'list':
      return block.items.map((item, unit) => ({ unit, text: plain(item.spans) }))
    case 'code':
      return block.source.split('\n').map((text, unit) => ({ unit, text }))
    case 'table':
      return [block.header, ...block.rows].flatMap((row, unit) => row.map(text => ({ unit, text })))
    case 'rule':
      return []
  }
}

export type Range = { start: number; end: number }

// Every place `query` is found in `text`, ignoring case, without overlaps.
export function findAll(text: string, query: string): Range[] {
  const needle = query.toLowerCase()
  if (needle === '') return []
  const haystack = text.toLowerCase()
  const found: Range[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return found
    found.push({ start: at, end: at + needle.length })
    from = at + needle.length
  }
}

export type Hit = { block: number; unit: number }

// Where each match is, in reading order: what "next match" walks through.
export function searchDocument(blocks: readonly Block[], query: string): Hit[] {
  return blocks.flatMap((block, index) =>
    pieces(block).flatMap(piece => findAll(piece.text, query).map(() => ({ block: index, unit: piece.unit }))),
  )
}

// A span list cut at the matches, each part told whether it is one and which.
export type Marked<T> = T & { match?: number }

export function markSpans(spans: readonly Span[], ranges: readonly Range[], first: number): Marked<Span>[] {
  if (ranges.length === 0) return [...spans]
  const out: Marked<Span>[] = []
  let offset = 0
  for (const span of spans) {
    const end = offset + span.text.length
    let at = offset
    for (const [index, range] of ranges.entries()) {
      if (range.end <= at || range.start >= end) continue
      if (range.start > at) out.push({ ...span, text: span.text.slice(at - offset, range.start - offset) })
      const stop = Math.min(range.end, end)
      out.push({ ...span, text: span.text.slice(Math.max(range.start, at) - offset, stop - offset), match: first + index })
      at = stop
    }
    if (at < end) out.push({ ...span, text: span.text.slice(at - offset) })
    offset = end
  }

  return out
}

// Terminal cells a string takes: wide for emoji and East Asian characters.
const WIDE =
  /[ᄀ-ᅟ⌚⌛⏩-⏬⏰⏳◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F000}-\u{1FAFF}]/u
const ZERO = /[̀-ͯ​-‏︀-︎]/u
// Asks for the emoji form of the character before it, two cells wide.
const EMOJI_FORM = '️'

export function cellWidth(text: string): number {
  let width = 0
  let last = 0
  for (const char of text) {
    const own = char === EMOJI_FORM ? (last === 1 ? 1 : 0) : ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1
    width += own
    if (char !== EMOJI_FORM) last = own
  }

  return width
}

// Word-wraps `text` to `width` cells: each line as the range of `text` it holds.
export function wrapRanges(text: string, width: number): Range[] {
  if (text === '') return [{ start: 0, end: 0 }]
  const lines: Range[] = []
  const room = Math.max(1, width)
  let start = 0
  while (start < text.length) {
    while (text[start] === ' ') start += 1
    if (start >= text.length) break
    let end = start
    let used = 0
    let lastBreak = -1
    while (end < text.length) {
      const char = String.fromCodePoint(text.codePointAt(end) ?? 32)
      const w = cellWidth(char)
      if (used + w > room) break
      if (char === ' ') lastBreak = end
      used += w
      end += char.length
    }
    if (end < text.length && lastBreak > start && text[end] !== ' ') end = lastBreak
    lines.push({ start, end: end === start ? start + 1 : end })
    start = end === start ? start + 1 : end
  }

  return lines.length === 0 ? [{ start: 0, end: 0 }] : lines
}

// Column widths for a table drawn in `columns` cells, borders and padding
// included: each column its natural width while they fit, else an even share
// given first to the columns narrower than it.
export function columnWidths(table: { header: string[]; rows: string[][] }, columns: number): number[] {
  const count = table.header.length
  const natural = table.header.map((_, c) =>
    Math.max(1, ...[table.header, ...table.rows].map(row => cellWidth(row[c] ?? ''))),
  )
  const room = columns - (count + 1) - count * 2
  if (natural.reduce((sum, one) => sum + one, 0) <= room) return natural

  const widths: number[] = Array.from({ length: count }, () => 0)
  let open = natural.map((_, c) => c)
  let left = Math.max(room, count * 3)
  for (;;) {
    const share = Math.floor(left / open.length)
    const fits = open.filter(c => (natural[c] ?? 0) <= share)
    if (fits.length === 0) {
      open.forEach((c, index) => {
        widths[c] = share + (index < left - share * open.length ? 1 : 0)
      })
      return widths
    }
    for (const c of fits) {
      widths[c] = natural[c] ?? 0
      left -= natural[c] ?? 0
    }
    open = open.filter(c => !fits.includes(c))
    if (open.length === 0) return widths
  }
}
