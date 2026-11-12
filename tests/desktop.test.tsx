import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'plan-tracker-panel',
  component: 'Pane',
  requestId: 'plan-tracker-panel',
  props: {
    title: 'Plan',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const lit = async (ui: { findAll: (q: { type: 'Button' }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Button' })).filter(b => b.props.dimColor === false).map(b => b.props.label)

test('a press on a view name switches the view, answered by its key', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: '# P\n1. a\n2. b\n', isAgent: false } }))
  await $.tool.call({ tool: 'ExitPlanMode' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'view-plan' })
    expect(await lit(ui)).toEqual(['Plan'])
    await ui.press({ key: 'view-progress' })
    expect(await lit(ui)).toEqual(['Progress'])
    await ui.unmount()
  }
})

test('the panel command imports a path given after "import"', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const text = '# Ship it\n- [x] one\n- [ ] two\n'
  on('fs.stat', (_, e) => ({
    value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false, realPath: e.path },
  }))
  on('fs.read', () => ({ value: text }))

  const said = await $.command.run({ command: 'plan-tracker-panel', args: 'import /repo/plan.md' } as never)

  expect((said as { text?: string }).text).toMatch(/^Tracking/)
})

test('the plan view uses the surface Markdown outside the terminal', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({
    result: { plan: '# P\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n1. one\n2. two\n\n```ts\nconst x = 1\n```\n', isAgent: false },
  }))
  await $.tool.call({ tool: 'ExitPlanMode' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'view-plan' })
    const markdown = await ui.find({ type: 'Markdown' })
    if (surface === 'desktop') expect(markdown?.props.text).toContain('const x = 1')
    else expect(markdown).toBeUndefined()
    await ui.press({ key: 'view-progress' })
    expect(await lit(ui)).toEqual(['Progress'])
    await ui.unmount()
  }
})

test('on desktop a Find button opens a field that lists the matching lines', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({}))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({
    result: { plan: '# P\n\n1. Add the limiter\n2. Write docs\n\nThe limiter fails open.\n', isAgent: false },
  }))
  await $.tool.call({ tool: 'ExitPlanMode' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view-plan' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()

  await ui.press({ key: 'find-open' })
  await ui.input({ key: 'search-plan', text: 'limiter', kind: 'change' })
  expect((await ui.find({ type: 'Text', text: /matches in/ }))?.text).toBe('2 matches in 2 lines')
  expect((await ui.findAll({ type: 'Text', text: 'limiter' })).some(t => t.props.bold === true)).toBe(true)
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()

  await ui.press({ key: 'find-close' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', label: 'Find in the plan' })).toBeDefined()
  await ui.unmount()
})

test('the plans list draws a card per plan, the tracked one lit', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const store = new Map<string, unknown>()
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({}))
  on('session.append', (_, e, next) => next(e))
  let next = '# Ship search\n- [x] a\n- [x] b\n'
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: next, isAgent: false } }))
  await $.tool.call({ tool: 'ExitPlanMode' })
  next = '# Add login\n- [x] model\n- [~] route\n- [ ] tests\n'
  await $.tool.call({ tool: 'ExitPlanMode' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'view-plans' })

    const cards = (await ui.findAll({ type: 'Box' })).filter(box => String(box.props.key ?? '').startsWith('card:'))
    expect(cards.length).toBe(2)
    expect(cards.every(box => box.props.borderStyle === 'round')).toBe(true)
    expect(cards.filter(box => box.props.borderColor === 'suggestion').length).toBe(1)
    expect(await ui.find({ type: 'Text', text: '✓ Finished' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /route/ })).toBeDefined()
    const buttons = await ui.findAll({ type: 'Button' })
    if (surface === 'terminal') {
      // One Button over the whole card.
      const login = buttons.find(button => String(button.key ?? '').startsWith('plan:') && button.text.includes('Add login'))
      expect(login?.text).toContain('route')
      expect(login?.text).toContain('from Claude')
    } else {
      // A Button per line: a press on the finished plan's status line tracks it.
      const row = buttons.find(button => String(button.key ?? '').startsWith('row:') && button.text.includes('Finished'))
      expect(row).toBeDefined()
      await ui.press({ key: String(row?.key) })
      await ui.press({ key: 'view-plans' })
      const lit = (await ui.findAll({ type: 'Box' })).find(box => box.props.borderColor === 'suggestion' && String(box.key ?? '').startsWith('card:'))
      expect(String(row?.key)).toEndWith(String(lit?.key).slice('card:'.length))
    }
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: /━/ })).toBeDefined()
    await ui.unmount()
  }
})
