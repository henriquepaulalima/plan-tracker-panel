import type { EngineInterface, RenderChildren } from 'claude-code'

import {
  type Block,
  type ListItem,
  type Marked,
  type Range,
  type Span,
  cellWidth,
  columnWidths,
  findAll,
  markSpans,
  pieces,
  wrapRanges,
} from './document'

type UI = ReturnType<EngineInterface['ui']['resolve']>

// Cells kept clear on each side of the plan text.
export const PLAN_PADDING = 2

export function unitKey(block: number, unit: number): string {
  return `doc:${block}:${unit}`
}

type Found = { ranges: Range[]; first: number }

// Where the matches fall: for each block, each of its search pieces' ranges
// and the index of its first match among all of the plan's.
function locate(blocks: readonly Block[], query: string): Found[][] {
  let count = 0

  return blocks.map(block =>
    pieces(block).map(piece => {
      const ranges = findAll(piece.text, query)
      const found = { ranges, first: count }
      count += ranges.length

      return found
    }),
  )
}

const CHECKS: Record<NonNullable<ListItem['checked']>, { mark: string; color: 'success' | 'suggestion' | 'subtle' }> = {
  done: { mark: '✓', color: 'success' },
  open: { mark: '○', color: 'subtle' },
  partial: { mark: '◐', color: 'suggestion' },
  skipped: { mark: '–', color: 'subtle' },
}

export function drawPlan(ui: UI, blocks: readonly Block[], query: string, current: number, columns: number): RenderChildren {
  const { Box, Code, Text } = ui
  const found = locate(blocks, query)
  const width = Math.max(10, columns - PLAN_PADDING * 2)

  const matchStyle = (match: number | undefined) =>
    match === undefined
      ? {}
      : match === current
        ? { backgroundColor: 'suggestion', color: 'inverseText', bold: true }
        : { backgroundColor: 'warning', color: 'inverseText' }

  const span = (one: Marked<Span>) => (
    <Text
      {...(one.bold ? { bold: true } : {})}
      {...(one.italic ? { italic: true } : {})}
      {...(one.strike ? { strikethrough: true } : {})}
      {...(one.link !== undefined ? { underline: true, color: 'suggestion' } : {})}
      {...(one.code ? { color: 'permission' } : {})}
      {...matchStyle(one.match)}
    >
      {one.text}
    </Text>
  )

  const spans = (list: readonly Span[], where: Found | undefined) =>
    markSpans(list, where?.ranges ?? [], where?.first ?? 0).map(span)

  // A plain string cut at the matches that fall in [from, to).
  const marked = (text: string, from: number, to: number, where: Found | undefined): Marked<Span>[] => {
    const inside = (where?.ranges ?? [])
      .map((range, index) => ({ start: Math.max(range.start, from) - from, end: Math.min(range.end, to) - from, index }))
      .filter(range => range.end > range.start)
    const parts = markSpans([{ text: text.slice(from, to) }], inside, 0)

    return parts.map(part =>
      part.match === undefined ? part : { ...part, match: (where?.first ?? 0) + (inside[part.match]?.index ?? 0) },
    )
  }

  const table = (block: Extract<Block, { kind: 'table' }>, index: number) => {
    const widths = columnWidths(block, width)
    const rows = [block.header, ...block.rows]
    const wrapped = rows.map(row => row.map((cell, c) => wrapRanges(cell, widths[c] ?? 1)))
    const isTall = wrapped.slice(1).some(row => row.some(lines => lines.length > 1))
    const rule = (left: string, middle: string, right: string) => (
      <Text color="subtle" wrap="truncate-end">
        {left + widths.map(w => '─'.repeat(w + 2)).join(middle) + right}
      </Text>
    )

    const drawRow = (row: string[], r: number) => {
      const height = Math.max(1, ...(wrapped[r] ?? []).map(lines => lines.length))
      const lines = Array.from({ length: height }, (_, l) => {
        const parts: RenderChildren[] = [<Text color="subtle">│</Text>]
        row.forEach((cell, c) => {
          const range = wrapped[r]?.[c]?.[l]
          const where = found[index]?.[r * row.length + c]
          const text = range === undefined ? [] : marked(cell, range.start, range.end, where)
          const used = cellWidth(text.map(part => part.text).join(''))
          const room = Math.max(0, (widths[c] ?? 0) - used)
          const align = block.align[c] ?? 'left'
          const before = align === 'right' ? room : align === 'center' ? Math.floor(room / 2) : 0
          parts.push(
            <Text {...(r === 0 ? { bold: true } : {})}>
              {' '.repeat(before + 1)}
              {text.map(span)}
              {' '.repeat(room - before + 1)}
            </Text>,
            <Text color="subtle">│</Text>,
          )
        })

        return <Text wrap="truncate-end">{parts}</Text>
      })

      return (
        <Box key={unitKey(index, r)} flexDirection="column">
          {lines}
        </Box>
      )
    }

    const body: RenderChildren[] = [rule('┌', '┬', '┐'), drawRow(block.header, 0), rule('├', '┼', '┤')]
    block.rows.forEach((row, r) => {
      if (r > 0 && isTall) body.push(rule('├', '┼', '┤'))
      body.push(drawRow(row, r + 1))
    })
    body.push(rule('└', '┴', '┘'))

    return <Box flexDirection="column">{body}</Box>
  }

  const code = (block: Extract<Block, { kind: 'code' }>, index: number) => {
    const where = found[index] ?? []
    const hasMatch = where.some(piece => piece.ranges.length > 0)
    const lines = block.source.split('\n')

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        {block.language !== undefined ? <Text dimColor>{block.language}</Text> : null}
        {hasMatch ? (
          lines.map((line, l) => (
            <Box key={unitKey(index, l)}>
              <Text>{marked(line, 0, line.length, where[l]).map(span)}</Text>
            </Box>
          ))
        ) : (
          <Code source={block.source} {...(block.language !== undefined ? { language: block.language } : {})} />
        )}
      </Box>
    )
  }

  const list = (block: Extract<Block, { kind: 'list' }>, index: number) => (
    <Box flexDirection="column">
      {block.items.map((item, i) => {
        const check = item.checked !== undefined ? CHECKS[item.checked] : undefined
        const marker = check?.mark ?? item.marker
        const isFinished = item.checked === 'done' || item.checked === 'skipped'

        return (
          <Box key={unitKey(index, i)} flexDirection="row" paddingLeft={item.depth * 2}>
            <Box width={cellWidth(marker) + 1} flexShrink={0}>
              <Text {...(check !== undefined ? { color: check.color } : { color: 'subtle' })}>{marker}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text {...(isFinished ? { dimColor: true } : {})}>{spans(item.spans, found[index]?.[i])}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )

  const draw = (block: Block, index: number): RenderChildren => {
    switch (block.kind) {
      case 'heading': {
        const style =
          block.level === 1
            ? { bold: true, color: 'claude' }
            : block.level === 2
              ? { bold: true, color: 'suggestion' }
              : { bold: true }

        return (
          <Box key={unitKey(index, 0)} {...(index > 0 && block.level <= 2 ? { marginTop: 1 } : {})}>
            <Text {...style}>{spans(block.spans, found[index]?.[0])}</Text>
          </Box>
        )
      }
      case 'paragraph':
        return (
          <Box key={unitKey(index, 0)}>
            <Text>{spans(block.spans, found[index]?.[0])}</Text>
          </Box>
        )
      case 'quote':
        return (
          <Box flexDirection="column" borderStyle="quote" borderColor="subtle" paddingLeft={1} gap={1}>
            {block.paragraphs.map((paragraph, p) => (
              <Box key={unitKey(index, p)}>
                <Text italic>{spans(paragraph, found[index]?.[p])}</Text>
              </Box>
            ))}
          </Box>
        )
      case 'list':
        return list(block, index)
      case 'code':
        return code(block, index)
      case 'table':
        return table(block, index)
      case 'rule':
        return <Text color="subtle">{'─'.repeat(width)}</Text>
    }
  }

  return (
    <Box flexDirection="column" paddingX={PLAN_PADDING} gap={1}>
      {blocks.map(draw)}
    </Box>
  )
}
