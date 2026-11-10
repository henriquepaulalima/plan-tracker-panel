import { expect, test } from 'claude-code/testing'

import { carryProgress, parsePlan } from '../hooks/parse'

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
  expect(stored.size).toBe(1)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /✓ 1\. Create/ }))?.text).toBe(
    '✓ 1. Create the User model',
  )
  expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toContain('1/3')
  await ui.unmount()
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
