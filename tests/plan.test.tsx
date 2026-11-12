import { expect, test } from 'claude-code/testing'

import { carryProgress, parsePlan, planMarkdown } from '../hooks/parse'

const PANE = {
  plugin: 'plan-tracker-panel',
  component: 'Pane',
  requestId: 'plan-tracker-panel',
  surface: 'terminal',
  props: {
    title: 'Plan',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PLAN = `# Add login

## Context
1. This list is background, not work.
2. Neither is this.

## Steps
1. Create the **User** model
   - add an email field
2. Add the \`/login\` route
3. Write tests

## Verification
Run the suite.
`

test('numbered items outside meta sections become the steps', () => {
  const plan = parsePlan(PLAN)

  expect(plan.title).toBe('Add login')
  expect(plan.steps.map(step => step.title)).toEqual([
    'Create the User model',
    'Add the /login route',
    'Write tests',
  ])
  expect(plan.steps[0]?.details).toEqual(['add an email field'])
  expect(plan.steps[2]?.details).toEqual([])
})

test('numbered headings win over the lists inside them', () => {
  const plan = parsePlan(`# P\n### Step 1: Backend\n1. a\n2. b\n### Step 2: Frontend\n1. c\n`)

  expect(plan.steps.map(step => step.title)).toEqual(['Backend', 'Frontend'])
  expect(plan.steps[0]?.details).toEqual(['a', 'b'])
})

test('checked boxes start done, and code fences are ignored', () => {
  const plan = parsePlan('- [x] one\n- [ ] two\n```\n- [ ] not a step\n```\n')

  expect(plan.steps.map(step => step.status)).toEqual(['done', 'pending'])
})

test('plain headings are the fallback, without meta sections', () => {
  const plan = parsePlan('# P\n## Context\nx\n## Backend\ny\n## Frontend\nz\n')

  expect(plan.steps.map(step => step.title)).toEqual(['Backend', 'Frontend'])
})

test('a plan with no structure has no steps', () => {
  expect(parsePlan('Just change the color.').steps).toEqual([])
})

test('a revised plan keeps the progress of unchanged steps', () => {
  const before = parsePlan('1. a\n2. b\n')
  before.steps[0]!.status = 'done'
  const after = carryProgress(before, parsePlan('1. a\n2. c\n3. b\n'))

  expect(after.steps.map(step => step.status)).toEqual(['done', 'pending', 'pending'])
})

test('an approved plan is drawn and steps advance', async ($, on) => {
  const stored = new Map<string, unknown>()
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({
    result: { plan: PLAN, isAgent: false },
  }))

  await $.tool.call({ tool: 'ExitPlanMode' })
  const step = 'mcp__plan-tracker-panel__plan_step'
  const updated = await $.tool.call({ tool: step, step: 1, status: 'done' })

  expect(updated.result).toContain('1/3 finished')
  // The plan in the library, and which plan this folder shows.
  expect([...stored.keys()].sort()).toEqual(['active:/repo', 'plans:/repo:native:add login'])

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /● Create/ }))?.text).toBe('● Create the User model')
  expect((await ui.find({ type: 'Text', text: /1 of 3/ }))?.text).toContain('1 of 3')
  await ui.unmount()
})

test('the switcher moves between progress and the full plan', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({
    result: { plan: PLAN, isAgent: false },
  }))

  await $.tool.call({ tool: 'ExitPlanMode' })
  const ui = await $.ui.mount(PANE)

  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /○ Create/ }))?.text).toContain('Create')

  await ui.press({ key: 'view-plan' })
  expect(await ui.find({ type: 'Text', text: 'Add login' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Run the suite/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /○ Create/ })).toBeUndefined()

  await ui.press({ key: 'view-progress' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('a draft is set aside for the panel and returns when it closes', async ($, on) => {
  let box = { text: 'half typed', cursor: 4 }
  on('prompt.read', () => ({ value: box }))
  on('prompt.fill', (_, e) => {
    box = { text: e.text, cursor: e.cursor ?? e.text.length }

    return { isFilled: true }
  })
  let panes: { id: string; isFocused: boolean }[] = []
  on('ui.open', () => {
    panes = [{ id: 'plan-tracker-panel', isFocused: true }]

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: panes }))
  on('ui.close', () => ({ value: undefined }))

  await $.command.run({ command: 'plan-tracker-focus', args: '' })
  expect(box.text).toBe('')

  await $.command.run({ command: 'plan-tracker-panel', args: '' })
  expect(box).toEqual({ text: 'half typed', cursor: 4 })
})

test('the focus command on a focused panel gives the keyboard back and keeps it open', async ($, on) => {
  let box = { text: 'half typed', cursor: 4 }
  let panes: { id: string; isFocused: boolean }[] = []
  const opens: { focus?: boolean }[] = []
  let closes = 0
  on('prompt.read', () => ({ value: box }))
  on('prompt.fill', (_, e) => {
    box = { text: e.text, cursor: e.cursor ?? e.text.length }

    return { isFilled: true }
  })
  on('ui.open', (_, e) => {
    opens.push(e)
    panes = [{ id: 'plan-tracker-panel', isFocused: e.focus === true }]

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: panes }))
  on('ui.close', () => {
    closes += 1
    panes = []

    return { value: undefined }
  })

  await $.command.run({ command: 'plan-tracker-focus', args: '' })
  expect(box.text).toBe('')

  await $.command.run({ command: 'plan-tracker-focus', args: '' })
  expect(closes).toBe(1)
  expect(opens[1]?.focus).toBeUndefined()
  expect(panes).toEqual([{ id: 'plan-tracker-panel', isFocused: false }])
  expect(box).toEqual({ text: 'half typed', cursor: 4 })

  await $.command.run({ command: 'plan-tracker-focus', args: '' })
  expect(opens[2]?.focus).toBe(true)
  expect(box.text).toBe('')
})

test('a draft comes straight back if the panel is refused the keyboard', async ($, on) => {
  let box = { text: 'half typed', cursor: 10 }
  on('prompt.read', () => ({ value: box }))
  on('prompt.fill', (_, e) => {
    box = { text: e.text, cursor: e.cursor ?? e.text.length }

    return { isFilled: true }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'plan-tracker-panel', isFocused: false }] }))

  await $.command.run({ command: 'plan-tracker-focus', args: '' })

  expect(box.text).toBe('half typed')
})

test('the key binding commands are declared to run while a turn is working', async ($, on) => {
  const commands: { name: string; immediate?: true }[] = []
  on('command.register', (_, e) => {
    commands.push(e)

    return { value: undefined }
  })
  on('tool.register', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.get', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))

  on('session.start', (_, e) => e)

  await $.session.start({ cwd: '/repo', source: 'startup', surface: 'terminal' } as never)

  for (const name of [
    'plan-tracker-focus',
    'plan-tracker-import',
    'plan-tracker-plans',
    'plan-tracker-next-view',
    'plan-tracker-previous-view',
  ]) {
    expect(commands.find(one => one.name === name)?.immediate).toBe(true)
  }
  expect(commands.find(one => one.name === 'plan-tracker-panel')?.immediate).toBeUndefined()
})

test('the focus command opens the panel holding the keyboard, and Esc closes it', async ($, on) => {
  let closes = 0
  on('ui.close', () => {
    closes += 1

    return { value: undefined }
  })
  const opens: unknown[] = []
  let panes: { id: string; isFocused: boolean }[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_, e) => {
    opens.push(e)
    panes = [{ id: 'plan-tracker-panel', isFocused: true }]

    return { value: { isPlaced: true } }
  })

  await $.command.run({ command: 'plan-tracker-focus', args: '' })

  expect(opens).toHaveLength(1)
  expect(opens[0]).toMatchObject({ id: 'plan-tracker-panel', focus: true })
  // Esc is the panel's own command, so alt+k can hand the keys back unclosed.
  expect((opens[0] as { closeOnEscape?: true }).closeOnEscape).toBeUndefined()

  await $.command.run({ command: 'plan-tracker-escape', args: '' })
  expect(closes).toBe(1)
})

test('the header shows the title and the keys for the current focus', async $ => {
  const unfocused = await $.ui.mount(PANE)
  expect(await unfocused.find({ type: 'Text', text: 'Plan Tracker' })).toBeDefined()
  expect(await unfocused.find({ type: 'Text', text: 'alt+k to focus' })).toBeDefined()
  expect(await unfocused.find({ type: 'Text', text: /Esc to quit/ })).toBeUndefined()
  await unfocused.unmount()

  const focused = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true } })
  const header = await focused.find({ type: 'Text', text: /Esc to quit/ })
  expect(header?.text).toContain('Plan Tracker')
  expect(header?.text).toHaveLength(PANE.props.bodyColumns)
  expect(await focused.find({ type: 'Text', text: /alt\+k/ })).toBeUndefined()
  await focused.unmount()
})

test('the 1 and 2 buttons exist even with no plan, so the keys stay in the panel', async $ => {
  const ui = await $.ui.mount(PANE)

  expect((await ui.find({ type: 'Text', text: /No plan tracked/ }))?.text).toContain('No plan')
  expect(await ui.find({ type: 'Button', key: 'view-progress' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'view-plan' })).toBeDefined()
  await ui.unmount()
})

test('a plan with no text of its own still has a plan view', () => {
  expect(
    planMarkdown({
      title: 'T',
      steps: [{ n: 1, title: 'a', details: [], status: 'pending' }],
    }),
  ).toBe('# T\n\n1. a')
})

test('a rejected plan is not tracked, and bad updates are refused', async ($, on) => {
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ isError: true, result: 'rejected' }))

  await $.tool.call({ tool: 'ExitPlanMode' })
  const updated = await $.tool.call({
    tool: 'mcp__plan-tracker-panel__plan_step',
    step: 1,
    status: 'done',
  })

  expect(updated.deny).toBe('No plan is being tracked.')
})

test('the progress view draws on both surfaces, with a real bar on desktop', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({
    result: { plan: PLAN, isAgent: false },
  }))

  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: 'mcp__plan-tracker-panel__plan_step', step: 1, status: 'done' })
  await $.tool.call({ tool: 'mcp__plan-tracker-panel__plan_step', step: 2, status: 'in_progress' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: '● Create the User model' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◐ Add the /login route' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ Write tests' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 of 3' })).toBeDefined()
    if (surface === 'desktop') {
      expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('1 of 3 steps finished')
    } else {
      expect((await ui.find({ type: "Text", text: /━/ }))?.text).toBe("━".repeat(16) + "─".repeat(32))
    }
    await ui.unmount()
  }
})

test('the panel\'s own key binding commands leave no row in the chat', async ($, on) => {
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })
  const row = (text: string) =>
    ({
      plugin: 'plan-tracker-panel',
      component: 'UserMessage',
      requestId: 'row',
      surface: 'terminal',
      props: { text, origin: { kind: 'composer' }, isExpanded: false },
    }) as const

  const quiet = await $.ui.mount(row('/plan-tracker-next-view'))
  expect(await quiet.find({ type: 'Text' })).toBeUndefined()
  await quiet.unmount()

  const shown = await $.ui.mount(row('/plan-tracker-panel'))
  expect((await shown.find({ type: 'Text' }))?.text).toBe('/plan-tracker-panel')
  await shown.unmount()
})

test('only the panel command is offered in the typeahead', async ($, on) => {
  on('command.describe', (_, e) => {
    const { command: _name, immediate: _now, provider: _from, ...shown } = e

    return shown
  })
  const describe = (command: string) =>
    $.command.describe({
      command,
      description: 'd',
      isHidden: false,
      immediate: true,
      provider: { plugin: 'plan-tracker-panel', tier: 'user' },
    } as never)

  expect((await describe('plan-tracker-panel')).isHidden).toBe(false)
  for (const name of ['plan-tracker-focus', 'plan-tracker-import', 'plan-tracker-find', 'plan-tracker-escape']) {
    expect((await describe(name)).isHidden).toBe(true)
  }
  expect((await describe('compact')).isHidden).toBe(false)
})

test('outside the terminal only the panel command is registered', async ($, on) => {
  const commands: string[] = []
  on('command.register', (_, e) => {
    commands.push(e.name)

    return { value: undefined }
  })
  on('tool.register', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('store.get', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('session.start', (_, e) => e)

  await $.session.start({ cwd: '/repo', source: 'startup', surface: null } as never)

  expect(commands).toEqual(['plan-tracker-panel'])
})
