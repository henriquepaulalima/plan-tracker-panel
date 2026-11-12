import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { matches, ownFirst, readFileList, readWorktrees } from '../hooks/files'
import { analyzeMarkdown, readAnalysis, titleStatus } from '../hooks/parse'

const PANE = {
  plugin: 'plan-tracker-panel',
  component: 'Pane',
  requestId: 'plan-tracker-panel',
  surface: 'terminal',
  props: {
    title: 'Plan',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const ONGOING = `# Billing

## Steps
- [x] Add the invoice model
- [~] Charge cards
- [ ] Send receipts
`

const PLAIN = `# Search

1. Index the documents
2. Add the query endpoint
3. Draw the results page
`

type World = {
  stored: Map<string, unknown>
  appended: string[]
  modelCalls: number
}

// The engine beneath the plugin: a store, a repository with two worktrees, and files.
function world(
  on: On,
  options: {
    files?: Record<string, string>
    mtimes?: Record<string, number>
    model?: string
    stored?: Record<string, unknown>
  } = {},
): World {
  const state: World = { stored: new Map(Object.entries(options.stored ?? {})), appended: [], modelCalls: 0 }
  const disk = options.files ?? {}

  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', (_, e) => e)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('store.get', (_, e) => ({ value: state.stored.get(e.key) }))
  on('store.set', (_, e) => {
    state.stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    state.stored.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...state.stored.keys()] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.append', (_, e, next) => {
    const block = e.message.content[0]
    if (block !== undefined && 'text' in block) state.appended.push(String(block.text))

    return next(e)
  })
  on('process.run', (_, e) => {
    const args = e.argv.slice(1).join(' ')
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (args.startsWith('rev-parse')) return ok('/repo/.git\n')
    if (args.startsWith('worktree list')) {
      return ok('worktree /repo\nHEAD 1\nbranch refs/heads/main\n\nworktree /wt/feature\nHEAD 2\nbranch refs/heads/feature\n')
    }
    if (args.startsWith('ls-files')) {
      const root = e.init?.cwd === '/wt/feature' ? '/wt/feature/' : '/repo/'
      const listed = Object.keys(disk)
        .filter(path => path.startsWith(root))
        .map(path => path.slice(root.length))

      return ok(listed.join('\0') + '\0')
    }

    return ok('')
  })
  on('fs.stat', (_, e) => {
    const path = e.path
    const text = disk[path]
    if (text === undefined) throw new Error('ENOENT')

    return { value: { kind: 'file', size: text.length, mtimeMs: options.mtimes?.[path] ?? 0, isLink: false, realPath: path } }
  })
  on('fs.read', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('model.complete', () => {
    state.modelCalls += 1
    const text = options.model ?? ''

    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })

  return state
}

test('statuses written in a plan are read from it', () => {
  const plan = analyzeMarkdown(
    [
      '# P',
      '## 1. Backend ✅',
      'x',
      '## 2. Frontend (in progress)',
      'y',
      '## 3. ~~Mobile~~',
      'z',
      '## 4. Docs',
      '**Status:** done',
      '## 5. Rollout',
      '- [x] canary',
      '- [ ] everyone',
      '## 6. Cleanup',
    ].join('\n'),
  )

  expect(plan.isStatusKnown).toBe(true)
  expect(plan.plan.steps.map(step => [step.title, step.status])).toEqual([
    ['Backend', 'done'],
    ['Frontend', 'in_progress'],
    ['Mobile', 'skipped'],
    ['Docs', 'done'],
    ['Rollout', 'in_progress'],
    ['Cleanup', 'pending'],
  ])
  expect(plan.plan.steps[3]?.details).toEqual([])
})

test('checkbox kinds and tags are statuses, ordinary words are not', () => {
  const plan = analyzeMarkdown('- [x] a\n- [~] b\n- [-] c\n- [ ] d\n').plan

  expect(plan.steps.map(step => step.status)).toEqual(['done', 'in_progress', 'skipped', 'pending'])
  expect(titleStatus('[WIP] Add login')).toEqual({ title: 'Add login', status: 'in_progress' })
  expect(titleStatus('Add login — done')).toEqual({ title: 'Add login', status: 'done' })
  expect(titleStatus('Mark the order as done')).toEqual({ title: 'Mark the order as done' })
  expect(titleStatus('Add the route (POST /login)')).toEqual({ title: 'Add the route (POST /login)' })
})

test('a plain list says nothing of where it stands', () => {
  expect(analyzeMarkdown(PLAIN).isStatusKnown).toBe(false)
})

test('the model answer is read as JSON, and nonsense is refused', () => {
  const read = readAnalysis(
    'Here: {"title": "S", "steps": [{"title": "a", "status": "done"}, {"title": "b", "status": "wat"}, {"x": 1}]}',
    'md',
  )

  expect(read?.steps.map(step => [step.n, step.title, step.status])).toEqual([
    [1, 'a', 'done'],
    [2, 'b', 'pending'],
  ])
  expect(readAnalysis('no json', 'md')).toBeUndefined()
  expect(readAnalysis('{"steps": []}', 'md')).toBeUndefined()
})

test('worktrees and their .md files are listed, the session one first', () => {
  const trees = readWorktrees('worktree /a\nbranch refs/heads/main\n\nworktree /b\ndetached\n\nworktree /bare\nbare\n')

  expect(trees).toEqual([
    { path: '/a', name: 'main' },
    { path: '/b', name: 'b' },
  ])
  expect(ownFirst(trees, '/b/src').map(tree => tree.path)).toEqual(['/b', '/a'])
  expect(readFileList(trees[0]!, 'z.md\0a/PLAN.MD\0x.txt\0z.md\0', true)).toEqual([
    { path: '/a/a/PLAN.MD', label: 'a/PLAN.MD', worktree: 'main' },
    { path: '/a/z.md', label: 'z.md', worktree: 'main' },
  ])
  expect(matches('plan bill', 'docs/billing-plan.md')).toBe(true)
  expect(matches('plan search', 'docs/billing-plan.md')).toBe(false)
})

test('importing a file with statuses tracks it as it stands, with no model call', async ($, on) => {
  const engine = world(on, { files: { '/repo/docs/billing.md': ONGOING } })

  const ran = await $.command.run({ command: 'plan-tracker-import', args: 'docs/billing.md' })

  expect(ran.text).toBe('Tracking "Billing": 1/3 steps finished.')
  expect(engine.modelCalls).toBe(0)
  expect(engine.stored.get('active:/repo')).toBe('file:/repo/docs/billing.md')
  expect(engine.appended[0]).toContain('now tracks "Billing"')

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: '● Add the invoice model' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◐ Charge cards' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '○ Send receipts' })).toBeDefined()
  await ui.unmount()
})

test('a plan whose text gives no statuses is analyzed by the model', async ($, on) => {
  const model = JSON.stringify({
    title: 'Search',
    steps: [
      { title: 'Index the documents', status: 'done' },
      { title: 'Add the query endpoint', status: 'in_progress' },
      { title: 'Draw the results page', status: 'pending' },
    ],
  })
  const engine = world(on, { files: { '/repo/search.md': PLAIN }, model })

  const ran = await $.command.run({ command: 'plan-tracker-import', args: '/repo/search.md' })

  expect(engine.modelCalls).toBe(1)
  expect(ran.text).toBe('Tracking "Search": 1/3 steps finished, statuses read by the model.')
})

test('a missing file or one without steps is refused', async ($, on) => {
  world(on, { files: { '/repo/note.md': 'Just a note.' }, model: 'nope' })

  expect((await $.command.run({ command: 'plan-tracker-import', args: 'gone.md' })).text).toBe('gone.md was not found.')
  expect((await $.command.run({ command: 'plan-tracker-import', args: 'note.md' })).text).toBe(
    'No steps were found in note.md.',
  )
})

test('importing a file again keeps the progress made since', async ($, on) => {
  const engine = world(on, { files: { '/repo/billing.md': ONGOING } })
  await $.command.run({ command: 'plan-tracker-import', args: 'billing.md' })
  await $.tool.call({ tool: 'mcp__plan-tracker-panel__plan_step', step: 3, status: 'done' })

  const again = await $.command.run({ command: 'plan-tracker-import', args: 'billing.md' })

  expect(again.text).toBe('Tracking "Billing": 2/3 steps finished.')
  expect([...engine.stored.keys()].filter(key => key.startsWith('plans:'))).toHaveLength(1)
})

test('the import view lists every worktree\'s .md files, filters them and imports one', async ($, on) => {
  world(on, {
    files: {
      '/repo/README.md': '# Readme',
      '/repo/docs/billing.md': ONGOING,
      '/wt/feature/docs/search.md': PLAIN,
    },
    model: '',
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'view-files' })

  expect(await ui.find({ type: 'Button', key: 'file:/repo/README.md' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'file:/wt/feature/docs/search.md' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /of 3 \.md files/ }))?.text).toContain('3 of 3')

  await ui.input({ key: 'search-files', text: 'docs bill', kind: 'change' })
  expect(await ui.find({ type: 'Button', key: 'file:/repo/README.md' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'file:/repo/docs/billing.md' })).toBeDefined()

  // Enter in the search field imports the first match.
  await ui.input({ key: 'search-files', text: 'docs bill' })
  expect(await ui.find({ type: 'Text', text: '◐ Charge cards' })).toBeDefined()
  await ui.unmount()
})

test('the plans view searches the saved plans and switches to one', async ($, on) => {
  const saved = (id: string, title: string, updatedAt: number) => ({
    id,
    title,
    updatedAt,
    steps: [{ n: 1, title: `${title} work`, details: [], status: 'pending' }],
  })
  const engine = world(on, {
    stored: {
      'plans:/repo/.git:native:alpha': saved('native:alpha', 'Alpha', 1),
      'plans:/repo/.git:native:beta': saved('native:beta', 'Beta', 2),
      'plans:/other/.git:native:gamma': saved('native:gamma', 'Gamma', 3),
      'active:/repo': 'native:alpha',
    },
  })
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Alpha/ })).toBeDefined()

  await ui.press({ key: 'view-plans' })
  expect(await ui.find({ type: 'Button', key: 'plan:native:alpha' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'plan:native:beta' })).toBeDefined()
  // Another repository's plans are not this one's.
  expect(await ui.find({ type: 'Button', key: 'plan:native:gamma' })).toBeUndefined()

  await ui.input({ key: 'search-plans', text: 'bet', kind: 'change' })
  expect(await ui.find({ type: 'Button', key: 'plan:native:alpha' })).toBeUndefined()

  await ui.press({ key: 'plan:native:beta' })
  expect(engine.stored.get('active:/repo')).toBe('native:beta')
  expect(await ui.find({ type: 'Text', text: '○ Beta work' })).toBeDefined()
  expect(engine.appended.at(-1)).toContain('now tracks "Beta"')
  await ui.unmount()
})

test('a plan saved before the library moves into it', async ($, on) => {
  const engine = world(on, {
    stored: { 'plan:/repo': { title: 'Old', steps: [{ n: 1, title: 'a', details: [], status: 'pending' }] } },
  })
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  expect(engine.stored.has('plan:/repo')).toBe(false)
  expect(engine.stored.get('active:/repo')).toBe('native:old')
  expect(engine.stored.has('plans:/repo/.git:native:old')).toBe(true)
})

test('clear forgets the tracked plan and drops it from the library', async ($, on) => {
  const engine = world(on, { files: { '/repo/billing.md': ONGOING } })
  await $.command.run({ command: 'plan-tracker-import', args: 'billing.md' })

  const ran = await $.command.run({ command: 'plan-tracker-panel', args: 'clear' })

  expect(ran.text).toBe('Forgot "Billing".')
  expect([...engine.stored.keys()]).toEqual([])
})

test('a tracked file that changes on disk is read again, its progress kept', async ($, on) => {
  const clock = mock.clock(on)
  const disk: Record<string, string> = { '/repo/billing.md': ONGOING }
  const mtimes: Record<string, number> = { '/repo/billing.md': 1 }
  const engine = world(on, { files: disk, mtimes })
  await $.session.start({ cwd: '/repo', source: 'startup' })
  await $.command.run({ command: 'plan-tracker-import', args: 'billing.md' })
  await $.tool.call({ tool: 'mcp__plan-tracker-panel__plan_step', step: 3, status: 'in_progress' })

  // Unchanged: nothing is read again.
  await clock.advance(1000)
  expect(engine.appended).toHaveLength(1)

  // As long as it was: the time alone tells the change.
  disk['/repo/billing.md'] = ONGOING.replace('- [~] Charge cards', '- [x] Charge cards')
  mtimes['/repo/billing.md'] = 2
  await clock.advance(1000)
  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: '● Charge cards' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◐ Send receipts' })).toBeDefined()
  await ui.unmount()
  // Only statuses moved: the model's step numbers still hold.
  expect(engine.appended).toHaveLength(1)

  disk['/repo/billing.md'] = disk['/repo/billing.md'] + '- [ ] Email the invoices\n'
  mtimes['/repo/billing.md'] = 3
  await clock.advance(1000)
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: '○ Email the invoices' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 of 4' })).toBeDefined()
  await ui.unmount()
  expect(engine.appended[1]).toContain('4. [pending] Email the invoices')
  expect(engine.modelCalls).toBe(0)
})
