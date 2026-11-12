import { expect, test } from 'claude-code/testing'

import { cellWidth, columnWidths, inline, markSpans, readDocument, searchDocument, wrapRanges } from '../hooks/document'

const DOC = `# Rate limits

Intro with **bold**, *italic*, \`code\` and a [link](https://example.com).

> A quote
> on two lines.

| Tier | Requests / minute | Notes |
|------|------------------:|-------|
| Free | 60 | Shared IP limit applies too, and this note is long enough to wrap |
| Business | 3 000 | Default |

\`\`\`ts
const limit = 60
const burst = 20
\`\`\`

- [x] Done thing
- [ ] Open thing
  - nested under it
1. First
2. Second

---
`

const PANE = {
  plugin: 'plan-tracker-panel',
  component: 'Pane',
  requestId: 'plan-tracker-panel',
  surface: 'terminal',
  props: {
    title: 'Plan',
    isFocused: true,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the document reader finds each kind of block', () => {
  const blocks = readDocument(DOC)

  expect(blocks.map(block => block.kind)).toEqual([
    'heading',
    'paragraph',
    'quote',
    'table',
    'code',
    'list',
    'list',
    'rule',
  ])
  const table = blocks[3]
  expect(table?.kind === 'table' && table.align).toEqual(['left', 'right', 'left'])
  const code = blocks[4]
  expect(code?.kind === 'code' && code.language).toBe('ts')
  const list = blocks[5]
  expect(list?.kind === 'list' && list.items.map(item => [item.depth, item.checked])).toEqual([
    [0, 'done'],
    [0, 'open'],
    [1, undefined],
  ])
})

test('inline markup becomes styled spans', () => {
  expect(inline('a **b** `c` ~~d~~ [e](https://x.y)')).toEqual([
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' ' },
    { text: 'c', code: true },
    { text: ' ' },
    { text: 'd', strike: true },
    { text: ' ' },
    { text: 'e', link: 'https://x.y' },
  ])
})

test('a table too wide for the panel is shrunk to fit, and its cells wrap', () => {
  const table = { header: ['Tier', 'Notes'], rows: [['Free', 'x'.repeat(80)]] }
  const widths = columnWidths(table, 40)

  expect(widths[0]).toBe(4)
  // Borders (3) and padding (4) take the rest.
  expect(widths.reduce((a, b) => a + b, 0)).toBe(40 - 3 - 4)
  expect(wrapRanges('one two three', 7)).toEqual([
    { start: 0, end: 7 },
    { start: 8, end: 13 },
  ])
  expect(cellWidth('⚠️ ok')).toBe(5)
})

test('search finds every match in reading order and marks them', () => {
  const blocks = readDocument(DOC)
  const hits = searchDocument(blocks, 'limit')

  // The heading, the table note and the first code line.
  expect(hits.map(hit => hit.block)).toEqual([0, 3, 4])
  expect(markSpans([{ text: 'abcabc' }], [{ start: 3, end: 6 }], 7)).toEqual([
    { text: 'abc' },
    { text: 'abc', match: 7 },
  ])
})

test('the plan view pads the text, fits tables and frames code', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: DOC, isAgent: false } }))
  await $.tool.call({ tool: 'ExitPlanMode' })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'view-plan' })

  const borders = await ui.findAll({ type: 'Text', text: /^[┌├└]/ })
  expect(borders.length).toBeGreaterThan(2)
  for (const line of await ui.findAll({ type: 'Text', text: /^[│┌├└]/ })) {
    expect(cellWidth(line.text)).toBeLessThan(PANE.props.bodyColumns - 3)
  }
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(box => box.props.borderStyle === 'round')).toBe(true)
  expect(boxes.some(box => box.props.paddingX === 2)).toBe(true)
  expect((await ui.find({ type: 'Code' }))?.props.language).toBe('ts')
  await ui.unmount()
})

test('the find bar floats over the plan, steps through matches and back', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('ui.panes', () => ({ value: [{ id: 'plan-tracker-panel', isFocused: true }] }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: DOC, isAgent: false } }))
  await $.tool.call({ tool: 'ExitPlanMode' })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'view-plan' })
  expect(await ui.find({ type: 'Text', text: 'f to find in the plan' })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'search-plan' })).toBeUndefined()

  await $.command.run({ command: 'plan-tracker-find', args: '' })
  const bar = (await ui.findAll({ type: 'Box' })).find(box => box.props.position === 'absolute')
  expect(bar?.props.top).toBe(0)

  // Typing lights the matches; Enter goes to the first, then the next.
  await ui.input({ key: 'search-plan', text: 'limit', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: '3 matches · Enter to go' })).toBeDefined()
  await ui.input({ key: 'search-plan', text: 'limit' })
  expect(await ui.find({ type: 'Text', text: '1 of 3' })).toBeDefined()
  // The engine empties the field on Enter: the next Enter goes on with the text.
  await ui.input({ key: 'search-plan', text: '' })
  expect(await ui.find({ type: 'Text', text: '2 of 3' })).toBeDefined()
  expect((await ui.find({ type: 'Input', key: 'search-plan' }))?.props.value).toMatch(/^limit\u200B?$/)
  // Ctrl+Enter reaches the field as a new line: the match before.
  await ui.input({ key: 'search-plan', text: 'limit\n', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: '1 of 3' })).toBeDefined()
  await ui.input({ key: 'search-plan', text: 'limit\n', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: '3 of 3' })).toBeDefined()

  // A code block with the current match is drawn as text, so the match is lit.
  await ui.input({ key: 'search-plan', text: 'const limit' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  const lit = await ui.findAll({ type: 'Text', text: 'const limit' })
  expect(lit.some(one => one.props.backgroundColor === 'suggestion')).toBe(true)

  await ui.input({ key: 'search-plan', text: 'nothing like it', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'No matches' })).toBeDefined()
  await ui.unmount()
})
