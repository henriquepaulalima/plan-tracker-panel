import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, ThemeKey } from 'claude-code'

import type { FileList, PanelView, Plan, PlanFile, Step, StepStatus } from '../types'
import { type Block, findAll, type Range, readDocument, searchDocument } from './document'
import { fileMatches, newestFirst, ownFirst, planMatches, readFileList, readWorktrees } from './files'
import {
  ANALYSIS_SYSTEM,
  analyzeMarkdown,
  carryProgress,
  isFinished,
  planMarkdown,
  readAnalysis,
  summarize,
  titleKey,
} from './parse'
import { drawPlan, unitKey } from './plan-view'

const PANE = 'plan-tracker-panel'
// The desktop Plan view's own buttons for the find field, which the terminal
// opens with its f key binding.
const FIND_OPEN = 'find-open'
const FIND_CLOSE = 'find-close'
// Matching lines listed under the desktop find field.
const MAX_FOUND_LINES = 50
// Cards drawn in the Plans and Import lists: each is a dozen elements, and the
// desktop app refuses a drawing that grows too large.
const MAX_CARDS = 50
const COMMAND = 'plan-tracker-panel'
const FOCUS_COMMAND = 'plan-tracker-focus'
const IMPORT_COMMAND = 'plan-tracker-import'
const PLANS_COMMAND = 'plan-tracker-plans'
const NEXT_VIEW_COMMAND = 'plan-tracker-next-view'
const PREVIOUS_VIEW_COMMAND = 'plan-tracker-previous-view'
const PRESS_COMMAND = 'plan-tracker-press'
const FIND_COMMAND = 'plan-tracker-find'
const ESCAPE_COMMAND = 'plan-tracker-escape'
const PLAN_STEP = 'mcp__plan-tracker-panel__plan_step'
const PLAN_SET = 'mcp__plan-tracker-panel__plan_set'
const STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'done', 'skipped']
const VIEWS: readonly PanelView[] = ['plan', 'progress', 'plans', 'files']
const SEARCH_KEY = { files: 'search-files', plans: 'search-plans', plan: 'search-plan' } as const
// Rows drawn in a list; past it the search narrows the rest down.
const MAX_ROWS = 200
// A plan is a document, not a data dump, and every imported plan is kept in the store.
const MAX_PLAN_BYTES = 512 * 1024
const ANALYSIS_MODEL = 'haiku'
// How often the tracked plan's file is checked for changes: one stat a tick.
const WATCH_MS = 1000
// Transparent lets the session's own background show through the panel. No
// closeOnEscape: Esc is bound to ESCAPE_COMMAND, and alt+k in the pane to the
// engine's own abovePrompt:leave, which hands the keyboard back with the pane
// left in place (with closeOnEscape that action would close it too).
const PANE_OPTIONS = {
  id: PANE,
  title: 'Plan',
  backgroundColor: 'transparent',
} as const

// Kept unchanged whatever the progress: a system prompt that varied per step
// would throw away the prompt cache on every update.
const REPORTING_NOTE = `The person follows approved plans in a side panel. While a plan is tracked, call ${PLAN_STEP} with status "in_progress" when you start a step and "done" or "skipped" when you finish it, as you go rather than in a batch at the end. Call it with no arguments to see the current step numbers. If the person agrees to a multi-step plan outside plan mode, call ${PLAN_SET} with its steps.`

const plan = atom({ plugin: 'plan-tracker-panel', key: 'plan' } as const, null, {
  shape: 'plan-1',
})

const view = atom({ plugin: 'plan-tracker-panel', key: 'view' } as const, 'progress', {
  shape: 'view-1',
})

// The prompt draft set aside while the panel holds the keyboard.
const draft = atom({ plugin: 'plan-tracker-panel', key: 'draft' } as const, null, {
  shape: 'draft-1',
})

// Every plan of this repository, the worktrees' included, as the store has them.
const library = atom({ plugin: 'plan-tracker-panel', key: 'library' } as const, [], {
  shape: 'library-1',
})

const files = atom({ plugin: 'plan-tracker-panel', key: 'files' } as const, { status: 'loading' }, {
  shape: 'files-1',
})

const search = atom(
  { plugin: 'plan-tracker-panel', key: 'search' } as const,
  { files: '', plans: '', plan: '', planMatch: 0 },
  { shape: 'search-2' },
)

const importing = atom({ plugin: 'plan-tracker-panel', key: 'importing' } as const, null, {
  shape: 'importing-1',
})

const finding = atom({ plugin: 'plan-tracker-panel', key: 'finding' } as const, false, { shape: 'finding-1' })

const scrollRow = atom({ plugin: 'plan-tracker-panel', key: 'scrollRow' } as const, 0, { shape: 'scroll-row-1' })

// The panel's own bookkeeping, started over by a reload: the row its window
// shows, a row to put it back on once the pane is drawn again, and the element
// the panel itself last asked the ring onto.
let lastOffset = 0
let pendingOffset: number | undefined
let requestedFocus: string | undefined

function focusOn($: EngineInterface, key: string, isRevealed = true): Promise<unknown> {
  requestedFocus = isRevealed ? key : undefined

  return $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// Reopening a pane starts its window at the top: this puts it back on the row
// it showed, once the tree is drawn (the ui.scroll hook makes the move).
async function restoreScroll($: EngineInterface, offset: number): Promise<void> {
  if (offset <= 0) return
  pendingOffset = offset
  for (let tries = 0; tries < 10 && pendingOffset !== undefined; tries += 1) {
    await $.clock.sleep(40).catch(() => undefined)
    await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
  }
  pendingOffset = undefined
}

let parsed: { markdown: string; blocks: Block[] } | undefined

function documentOf(text: string): Block[] {
  if (parsed?.markdown !== text) parsed = { markdown: text, blocks: readDocument(text) }

  return parsed.blocks
}

// Brings the plan's `index`th match of `query` into the middle of the window.
async function revealMatch($: EngineInterface, query: string, index: number): Promise<void> {
  const current = await read($, plan)
  if (current === null) return
  const hit = searchDocument(documentOf(planMarkdown(current)), query)[index]
  if (hit === undefined) return
  await $.ui.scroll({ in: PANE, to: { key: unitKey(hit.block, hit.unit) }, block: 'center' }).catch(() => undefined)
}

// Enter moves to the next match, Ctrl+Enter (or any key the field takes as a
// new line) to the one before; a changed text starts again from its first.
// The engine empties a field on Enter and refills it only from a value that
// differs from the one drawn before: the text is drawn with or without a
// zero-width mark in turn, so each Enter puts it back.
const ZERO_WIDTH = '\u200B'
let refills = 0

function fieldText(value: string): string {
  return value.replaceAll(ZERO_WIDTH, '')
}

async function stepMatch($: EngineInterface, typed: string, by: 1 | -1): Promise<void> {
  const current = await read($, plan)
  if (current === null) return
  const was = await read($, search)
  // An Enter on the emptied field goes on with the text being searched.
  const value = fieldText(typed).replace(/\n/g, '') || was.plan
  const count = searchDocument(documentOf(planMarkdown(current)), value).length
  refills += 1
  const isSame = value === was.plan && was.planMatch >= 0
  const index = count === 0 ? -1 : isSame ? (was.planMatch + by + count) % count : by === 1 ? 0 : count - 1
  await update($, search, old => ({ ...old, plan: value, planMatch: index }))
  if (index >= 0) await revealMatch($, value, index)
}

async function startFind($: EngineInterface): Promise<void> {
  await update($, scrollRow, () => lastOffset)
  await update($, finding, () => true)
  await focusOn($, SEARCH_KEY.plan)
}

// Back to the plan view's own keys, the matches no longer lit.
async function stopFind($: EngineInterface): Promise<void> {
  await update($, finding, () => false)
  await update($, search, old => ({ ...old, planMatch: -1 }))
}

// Anything typed since the draft was set aside is kept after it.
async function restoreDraft($: EngineInterface): Promise<void> {
  const saved = await read($, draft)
  if (saved === null) return
  // Taken first, so two paths putting it back at once cannot both fill it in.
  await update($, draft, () => null)

  const box = await $.prompt.read()
  const { isFilled } = await $.prompt.fill({ text: saved.text + box.text, cursor: saved.cursor })
  if (!isFilled) await update($, draft, () => saved)
}

// After abovePrompt:leave: the draft comes back once the pane is still without
// the keyboard a moment later (it can draw unfocused for an instant as it takes
// the keys, and a draft back in the box then would make the engine refuse them).
async function restoreAfterLeave($: EngineInterface): Promise<void> {
  await $.clock.sleep(200).catch(() => undefined)
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane?.isFocused === true) return
  if (await read($, finding)) await update($, finding, () => false)
  await restoreDraft($)
}

// The plugin runs exactly three git commands, all read-only, each written in
// full here: the repository's common git folder, its worktrees, and the .md
// files in one worktree.
type Ran = { exitCode: number; stdout: string }

const stdoutOf = (ran: Ran) => (ran.exitCode === 0 ? ran.stdout : undefined)

function gitCommonDir($: EngineInterface): Promise<string | undefined> {
  return $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']).then(stdoutOf).catch(() => undefined)
}

function gitWorktrees($: EngineInterface): Promise<string | undefined> {
  return $.process.run(['git', 'worktree', 'list', '--porcelain']).then(stdoutOf).catch(() => undefined)
}

// Tracked and untracked files alike, without what .gitignore leaves out.
function gitMarkdownFiles($: EngineInterface, cwd: string): Promise<string | undefined> {
  return $.process.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md', '*.MD'], { cwd }).then(stdoutOf).catch(() => undefined)
}

// Plans are shared by every worktree of a repository: the store is keyed by
// its common git folder, or by the folder itself outside a repository.
async function libraryScope($: EngineInterface): Promise<string> {
  const common = await gitCommonDir($)

  return common?.trim() || (await $.session.cwd())
}

// The engine refuses a store key over 256 characters, and a key names the
// repository's path and often a plan file's path too. A key that fits is kept
// as it is, so plans saved before stay found; a longer one has each of its
// parts over PART_LIMIT replaced by a shortened form ending in a hash.
const KEY_LIMIT = 256
const PART_LIMIT = 120

function hash(text: string): string {
  let a = 0xdeadbeef
  let b = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 2654435761)
    b = Math.imul(b ^ code, 1597334677)
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)

  return (b >>> 0).toString(16).padStart(8, '0') + (a >>> 0).toString(16).padStart(8, '0')
}

function shorten(part: string): string {
  if (part.length <= PART_LIMIT) return part

  return `${part.slice(0, PART_LIMIT - 17)}#${hash(part)}`
}

// Each `plans:` key's prefix: the plain one and, when it differs, the shortened one.
async function libraryPrefixes($: EngineInterface): Promise<string[]> {
  const scope = await libraryScope($)

  return [...new Set([`plans:${scope}:`, `plans:${shorten(scope)}:`])]
}

function fitKey(kind: string, ...parts: string[]): string {
  const plain = [kind, ...parts].join(':')

  return plain.length <= KEY_LIMIT ? plain : [kind, ...parts.map(shorten)].join(':')
}

async function planKey($: EngineInterface, id: string): Promise<string> {
  return fitKey('plans', await libraryScope($), id)
}

// Which plan the panel shows is the folder's own: two worktrees can follow two plans.
async function activeKey($: EngineInterface): Promise<string> {
  return fitKey('active', await $.session.cwd())
}

function isPlan(value: unknown): value is Plan {
  return typeof value === 'object' && value !== null && Array.isArray((value as Plan).steps)
}

function planId(one: Plan): string {
  if (one.id !== undefined) return one.id

  return one.source !== undefined ? `file:${one.source}` : `native:${titleKey(one.title)}`
}

async function loadLibrary($: EngineInterface): Promise<Plan[]> {
  const prefixes = await libraryPrefixes($)
  const keys = (await $.store.keys()).filter(key => prefixes.some(prefix => key.startsWith(prefix)))
  const saved = await Promise.all(keys.map(key => $.store.get(key)))

  return newestFirst(saved.filter(isPlan))
}

// Before the library, one plan was kept per folder under `plan:<cwd>`.
async function migrateLegacy($: EngineInterface): Promise<void> {
  const legacyKey = fitKey('plan', await $.session.cwd())
  const saved = await $.store.get(legacyKey)
  if (saved === undefined) return

  if (isPlan(saved)) {
    const moved = { ...saved, id: planId(saved), updatedAt: Date.now() }
    await $.store.set(await planKey($, moved.id), moved)
    await $.store.set(await activeKey($), moved.id)
  }
  await $.store.delete(legacyKey)
}

// Makes `next` the tracked plan and keeps it in the library.
async function commit($: EngineInterface, next: Plan): Promise<Plan> {
  const saved = { ...next, id: planId(next), updatedAt: Date.now() }
  await update($, plan, () => saved)
  await update($, library, all => [saved, ...all.filter(one => one.id !== saved.id)])
  await $.store.set(await planKey($, saved.id), saved)
  await $.store.set(await activeKey($), saved.id)

  return saved
}

async function forget($: EngineInterface): Promise<Plan | null> {
  const current = await read($, plan)
  await update($, plan, () => null)
  await $.store.delete(await activeKey($))
  if (current === null) return null

  const id = planId(current)
  await update($, library, all => all.filter(one => planId(one) !== id))
  await $.store.delete(await planKey($, id))

  return current
}

// The model is told when the person switches plans, so its step numbers follow.
async function announce($: EngineInterface, tracked: Plan): Promise<void> {
  const text = `The plan panel now tracks "${tracked.title}". Report progress on it with ${PLAN_STEP}.\n${summarize(tracked)}`
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
}

async function loadFiles($: EngineInterface): Promise<void> {
  await update($, files, (): FileList => ({ status: 'loading' }))

  const listed = await gitWorktrees($)
  if (listed === undefined) {
    await update($, files, (): FileList => ({ status: 'error', message: 'Not inside a git repository.' }))
    return
  }

  const worktrees = ownFirst(readWorktrees(listed), await $.session.cwd())
  const found = await Promise.all(
    worktrees.map(async tree => {
      const out = await gitMarkdownFiles($, tree.path)

      return out === undefined ? [] : readFileList(tree, out, worktrees.length > 1)
    }),
  )
  await update($, files, (): FileList => ({ status: 'ready', files: found.flat() }))
}

const tabKey = (wanted: PanelView) => `view-${wanted}`

async function showView($: EngineInterface, wanted: PanelView): Promise<void> {
  await update($, view, () => wanted)
  // Returning to the top is a nicety: the switch has already happened if it fails.
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)

  if (wanted === 'files' || wanted === 'plans') {
    // Each visit starts a new search, as the field itself is drawn empty again.
    await update($, search, old => ({ ...old, [wanted]: '' }))
  }
  if (wanted !== 'plan') await update($, finding, () => false)
  // The ring stays on the view names, never in a search field: from a field
  // no key binding fires, so the panel could neither switch views nor close.
  void focusOn($, tabKey(wanted))
  if (wanted === 'files') await loadFiles($)
  if (wanted === 'plans') {
    const all = await loadLibrary($)
    await update($, library, () => all)
  }
}

// The engine only gives a panel the keyboard over an empty prompt, so a draft
// is set aside first and comes back when the panel closes.
async function focusPane($: EngineInterface): Promise<void> {
  const wasOpen = (await $.ui.panes()).some(one => one.id === PANE)
  const keep = lastOffset
  const box = await $.prompt.read()
  if (box.text !== '' && (await $.prompt.fill({ text: '' })).isFilled) {
    await update($, draft, () => box)
  }

  // The emptied box can reach the screen after the request for the keys, which
  // the engine then refuses over the text it still sees: asked again a moment on.
  let pane: { isFocused: boolean } | undefined
  for (let tries = 0; tries < 4; tries += 1) {
    if (tries > 0) await $.clock.sleep(60).catch(() => undefined)
    await $.ui.open({ ...PANE_OPTIONS, focus: true })
    pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane?.isFocused === true || box.text === '') break
  }

  // Refused anyway: don't leave the person's text hidden behind an unfocused panel.
  if (pane?.isFocused !== true) await restoreDraft($)
  else if (wasOpen) await restoreScroll($, keep)
}

// Opens the panel on a view, holding the keyboard: what the key bindings run.
async function openOn($: EngineInterface, wanted: PanelView): Promise<void> {
  const open = (await $.ui.panes()).find(one => one.id === PANE)
  if (open?.isFocused !== true) {
    await update($, view, () => wanted)
    if (wanted === 'files') await update($, files, (): FileList => ({ status: 'loading' }))
    await focusPane($)
  }
  await showView($, wanted)
}

type Imported = { plan: Plan; isAnalyzed: boolean } | { error: string }

// The model reads plans whose text alone says where they stand ("phase 1 shipped").
async function askModel($: EngineInterface, markdown: string): Promise<Plan | undefined> {
  const request = { model: ANALYSIS_MODEL, system: ANALYSIS_SYSTEM, prompt: markdown, maxTokens: 8000, timeoutMs: 60_000 }
  const answer = await $.model.complete(request).catch(() => undefined)

  return answer?.isAnswered === true ? readAnalysis(answer.text, markdown) : undefined
}

async function readPlanFile($: EngineInterface, path: string): Promise<Imported> {
  const absolute = path.startsWith('/') ? path : `${await $.session.cwd()}/${path.replace(/^\.\//, '')}`
  const stat = await $.fs.stat(absolute, { resolve: true }).catch(() => undefined)
  if (stat === undefined || stat.realPath === undefined) return { error: `${path} was not found.` }
  if (stat.kind !== 'file') return { error: `${path} is not a file.` }
  if (stat.size > MAX_PLAN_BYTES) return { error: `${path} is over 512 KB, too large to be a plan.` }

  const source = stat.realPath
  const sourceStamp = stampOf(stat)
  const markdown = await $.fs.read(source).catch(() => undefined)
  if (typeof markdown !== 'string') return { error: `${path} could not be read.` }

  const parsed = analyzeMarkdown(markdown)
  let analyzed = parsed.plan
  let isAnalyzed = false

  if (!parsed.isStatusKnown) {
    const fromModel = await askModel($, markdown)
    if (fromModel !== undefined) {
      isAnalyzed = true
      // The parser's steps are kept where it found them, the model's statuses laid
      // over them: by position when both found as many, else by title.
      analyzed =
        parsed.plan.steps.length === 0
          ? { ...fromModel, title: parsed.plan.title === 'Plan' ? fromModel.title : parsed.plan.title }
          : fromModel.steps.length === parsed.plan.steps.length
            ? {
                ...parsed.plan,
                steps: parsed.plan.steps.map((step, index) => ({ ...step, status: fromModel.steps[index]?.status ?? step.status })),
              }
            : carryProgress(fromModel, parsed.plan)
    }
  }

  if (analyzed.steps.length === 0) return { error: `No steps were found in ${path}.` }

  return { plan: { ...analyzed, source, sourceStamp, id: `file:${source}` }, isAnalyzed }
}

function stampOf(stat: { mtimeMs: number; size: number }): string {
  return `${stat.mtimeMs}:${stat.size}`
}

function stepTitles(one: Plan): string {
  return one.steps.map(step => titleKey(step.title)).join('\n')
}

// Reads the tracked plan's file again once it changed on disk, so a session
// that keeps editing the file is followed without a new import. Progress
// reported since is kept for every step the file still lists as pending.
async function followSource($: EngineInterface): Promise<void> {
  const current = await read($, plan)
  if (current?.source === undefined) return

  // A file gone or mid-rename keeps the plan as it stands until it is back.
  const stat = await $.fs.stat(current.source).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file' || stampOf(stat) === current.sourceStamp) return

  const imported = await readPlanFile($, current.source)
  // The panel may have switched plans, or a step moved, while the file was read.
  const now = await read($, plan)
  if (now === null || planId(now) !== planId(current)) return

  if ('error' in imported) {
    // Half written, say: wait for the next change rather than reading it every tick.
    await commit($, { ...now, sourceStamp: stampOf(stat) })
    return
  }

  const tracked = await commit($, carryProgress(now, imported.plan))
  if (stepTitles(tracked) !== stepTitles(now)) {
    const text = `The plan file ${shortPath(current.source, await $.session.cwd())} changed and the plan panel's steps changed with it. Report progress with these numbers.\n${summarize(tracked)}`
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  }
}

// Imports a file into the library and tracks it. Progress saved from an earlier
// import is kept for every step the file still lists as pending.
async function importPlan($: EngineInterface, path: string): Promise<string> {
  await update($, importing, () => path)
  try {
    const imported = await readPlanFile($, path)
    if ('error' in imported) return imported.error

    const earlier = (await read($, library)).find(one => one.id === imported.plan.id) ?? null
    const tracked = await commit($, carryProgress(earlier, imported.plan))
    await announce($, tracked)
    await update($, view, () => 'progress')

    const finished = tracked.steps.filter(isFinished).length
    const how = imported.isAnalyzed ? ', statuses read by the model' : ''

    return `Tracking "${tracked.title}": ${finished}/${tracked.steps.length} steps finished${how}.`
  } finally {
    await update($, importing, () => null)
  }
}

// One import at a time: a second press while the model reads a plan is dropped.
async function pickFile($: EngineInterface, path: string): Promise<void> {
  if ((await read($, importing)) !== null) return
  $.ui.toast(await importPlan($, path))
}

// What Enter on the element `key` does: the same as pressing that Button.
async function press($: EngineInterface, key: string): Promise<void> {
  const tab = VIEWS.find(one => tabKey(one) === key)
  if (tab !== undefined) await showView($, tab)
  else if (key === FIND_OPEN) await startFind($)
  else if (key === FIND_CLOSE) {
    await stopFind($)
    await update($, search, old => ({ ...old, plan: '' }))
  } else if (key.startsWith('row:')) await press($, key.slice(key.indexOf(':', 'row:'.length) + 1))
  else if (key.startsWith('file:')) await pickFile($, key.slice('file:'.length))
  else if (key.startsWith('plan:')) await choose($, key.slice('plan:'.length))
}

async function choose($: EngineInterface, id: string): Promise<void> {
  const chosen = (await read($, library)).find(one => one.id === id)
  if (chosen === undefined) return

  const tracked = await commit($, chosen)
  await announce($, tracked)
  await showView($, 'progress')
}

const MARKS: Record<StepStatus, string> = {
  pending: '○',
  in_progress: '◐',
  done: '●',
  skipped: '–',
}

// Only the mark is colored: the titles stay plain text, muted once finished.
const COLORS: Partial<Record<StepStatus, ThemeKey>> = {
  in_progress: 'suggestion',
  done: 'success',
}

const TITLE = 'Plan Tracker'
const FOCUSED_HINT = 'Esc to quit'
const UNFOCUSED_HINT = 'alt+k to focus'

// A single string so the highlight runs unbroken across the whole row.
function headerRow(hint: string, columns: number): string {
  const gap = Math.max(1, columns - TITLE.length - hint.length - 2)

  return ` ${TITLE}${' '.repeat(gap)}${hint} `
}

function filledCells(finished: number, total: number, width: number): number {
  return total === 0 ? 0 : Math.round((finished / total) * width)
}

// A thin line: the filled part in the accent, the rest a faint rule.
function progressBar(finished: number, total: number, width: number): [string, string] {
  const filled = filledCells(finished, total, width)

  return ['━'.repeat(filled), '─'.repeat(width - filled)]
}

// The desktop draws a real 4px rounded bar. An SVG is an image there, so its
// colors are fixed: an accent that reads on light and dark, over a gray track.
const BAR_ACCENT = '#378ADD'
const BAR_TRACK = '#888780'

function progressSvg(finished: number, total: number): string {
  const share = total === 0 ? 0 : Math.round((finished / total) * 1000) / 10

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="4" viewBox="0 0 100 4" preserveAspectRatio="none">` +
    `<rect width="100" height="4" rx="2" fill="${BAR_TRACK}" fill-opacity="0.3"/>` +
    (share > 0 ? `<rect width="${share}" height="4" rx="2" fill="${BAR_ACCENT}"/>` : '') +
    `</svg>`
  )
}

// "just now", "5m ago", "2h ago", "yesterday", "3d ago", then the date.
function ago(at: number | undefined, now: number): string {
  if (at === undefined) return ''
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`

  return new Date(at).toISOString().slice(0, 10)
}

function splitPath(label: string): { name: string; folder: string } {
  const cut = label.lastIndexOf('/')

  return cut < 0 ? { name: label, folder: './' } : { name: label.slice(cut + 1), folder: label.slice(0, cut + 1) }
}

type FoundLine = { line: number; text: string; ranges: Range[] }

// The plan's source lines holding the query, for the desktop find.
function foundLines(markdown: string, query: string): FoundLine[] {
  if (query.trim() === '') return []

  return markdown.split('\n').flatMap((raw, line) => {
    const text = raw.trim()
    const ranges = findAll(text, query)

    return ranges.length === 0 ? [] : [{ line, text, ranges }]
  })
}

function cutAtRanges(text: string, ranges: readonly Range[]): { text: string; isMatch: boolean }[] {
  const parts: { text: string; isMatch: boolean }[] = []
  let at = 0
  for (const range of ranges) {
    if (range.start > at) parts.push({ text: text.slice(at, range.start), isMatch: false })
    parts.push({ text: text.slice(range.start, range.end), isMatch: true })
    at = range.end
  }
  if (at < text.length) parts.push({ text: text.slice(at), isMatch: false })

  return parts
}

function shortPath(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

// The commands ~/.claude/keybindings.json runs: the terminal alone reads it.
async function registerKeyCommands($: EngineInterface): Promise<void> {
  await $.command.register({
    name: FOCUS_COMMAND,
    description: 'Open the plan panel and give it the keyboard: 1 to 4 switch views, Esc closes it',
    // Without this the key waits for the turn to end, and every press piles up.
    immediate: true,
  })
  await $.command.register({
    name: IMPORT_COMMAND,
    description: 'Import a plan from a .md file: give its path, or pick one of the repository\'s .md files in the panel',
    argumentHint: '[path to a .md file]',
    immediate: true,
  })
  await $.command.register({
    name: PLANS_COMMAND,
    description: 'Search the plans imported or approved in this repository and switch the panel to one',
    immediate: true,
  })
  // Bound to Right and Left in the Pane context: unbound, Left falls through
  // to the prompt's own shortcut and takes the screen away from the panel.
  await $.command.register({
    name: NEXT_VIEW_COMMAND,
    description: 'Move the plan panel\'s highlight to the next view name',
    immediate: true,
  })
  // Bound to Enter in the Pane context. The engine sends Enter to the prompt
  // until the person has moved the ring by hand once, even onto an element
  // the panel lit itself (its autoFocus, a digit, Left or Right).
  await $.command.register({
    name: PRESS_COMMAND,
    description: 'Press what the plan panel\'s highlight is on',
    immediate: true,
  })
  await $.command.register({
    name: PREVIOUS_VIEW_COMMAND,
    description: 'Move the plan panel\'s highlight to the previous view name',
    immediate: true,
  })
  // Bound to f in the Pane context: alt+k then f opens the find bar.
  await $.command.register({
    name: ESCAPE_COMMAND,
    description: 'Back out of the plan panel one level: the find bar, a search field, then the panel itself',
    immediate: true,
  })
  await $.command.register({
    name: FIND_COMMAND,
    description: 'Find text in the plan: Enter goes to the next match, Ctrl+Enter to the previous, Esc closes the bar',
    immediate: true,
  })
}

export const register: Register = on => {
  // Where the ring stands, as the event names only where it goes.
  let ringAt: string | undefined
  // One read of the plan file at a time: a model analysis can outlast a tick.
  let isFollowing = false
  const tabs = VIEWS.map(tabKey)

  // The panel's key bindings run slash commands, and the engine shows each
  // one as a prompt row with a spinner while it runs: on every arrow press the
  // chat beside the panel jumped. Those rows are drawn as nothing.
  const QUIET = new Set([
    COMMAND,
    FOCUS_COMMAND,
    IMPORT_COMMAND,
    PLANS_COMMAND,
    NEXT_VIEW_COMMAND,
    PREVIOUS_VIEW_COMMAND,
    PRESS_COMMAND,
    FIND_COMMAND,
    ESCAPE_COMMAND,
  ])
  // Only /plan-tracker-panel is offered in the typeahead and /help; the rest
  // are run by the panel's key bindings and still run when typed in full.
  on('command.describe', async ($, e, next) => {
    const shown = await next(e)
    if (e.command === COMMAND || !QUIET.has(e.command)) return shown

    return { ...shown, isHidden: true }
  })

  let quietRuns = 0
  // The run's spinner can be drawn again just after the run ends.
  let quietUntil = 0
  const isQuiet = (text: string) => {
    const match = /^\/([a-z-]+)\s*$/.exec(text.trim())
    return match !== null && QUIET.has(match[1] ?? '') && match[1] !== COMMAND
  }

  // Registered before the commands' own hooks, so it wraps them.
  on('command.run', async ($, e, next) => {
    if (!QUIET.has(e.command) || e.command === COMMAND) return next(e)
    quietRuns += 1
    try {
      return await next(e)
    } finally {
      quietRuns -= 1
      // What is left of the run (its row's removal) is drawn just after it.
      quietUntil = Math.max(quietUntil, (await $.clock.now().catch(() => 0)) + 300)
    }
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!isQuiet(e.props.text)) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (quietRuns === 0 && (await $.clock.now().catch(() => Infinity)) > quietUntil) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description:
        'Show or hide the plan panel ("progress", "plan", "import" or "plans" opens that view, "import <path>" imports a .md file, "clear" forgets the tracked plan)',
      argumentHint: '[progress|plan|plans|import [path]|clear]',
    })
    // The rest exist for ~/.claude/keybindings.json, which only the terminal
    // reads. The desktop app lists every registered command in its slash menu,
    // whatever command.describe answers, so outside the terminal none is
    // registered: the panel's buttons do their work there.
    if (e.surface === 'terminal') await registerKeyCommands($)
    await $.tool.register({
      name: 'plan_step',
      description:
        'Report progress on the tracked plan shown in the side panel. Pass step and status to update one step. With no arguments, returns every step with its number and status.',
      inputSchema: {
        type: 'object',
        properties: {
          step: { type: 'integer', minimum: 1, description: 'The step number' },
          status: { type: 'string', enum: STATUSES },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'plan_set',
      description:
        'Track a multi-step plan agreed outside plan mode, making it the one the panel shows. Steps whose titles are unchanged keep their progress.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['title', 'steps'],
      },
    })

    await migrateLegacy($)
    const all = await loadLibrary($)
    await update($, library, () => all)

    if ((await read($, plan)) === null) {
      const activeId = await $.store.get(await activeKey($))
      const saved = all.find(one => one.id === activeId)
      if (saved !== undefined && !saved.steps.every(isFinished)) await update($, plan, () => saved)
    }

    $.clock.every(WATCH_MS, () => {
      if (isFollowing) return
      isFollowing = true
      void followSource($)
        .catch(() => undefined)
        .finally(() => {
          isFollowing = false
        })
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(PLAN_STEP)) return composed

    return {
      sections: [
        ...composed.sections,
        { id: 'plan-tracker-panel:reporting', text: REPORTING_NOTE, scope: 'session' as const },
      ],
    }
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || e.agentId !== undefined) return ran

    const { plan: text, isAgent, awaitingLeaderApproval } = ran.result
    if (!text || isAgent || awaitingLeaderApproval) return ran

    const parsed = analyzeMarkdown(text).plan
    if (parsed.steps.length === 0) {
      return {
        ...ran,
        context: [
          ...(ran.context ?? []),
          `The plan panel found no steps in this plan. Call ${PLAN_SET} with its steps so the person can follow it.`,
        ],
      }
    }

    const tracked = await commit($, carryProgress(await read($, plan), parsed))
    $.ui.toast(`Tracking ${tracked.steps.length} plan steps. /${COMMAND} shows them.`)

    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `The plan panel is tracking these steps. Report progress with ${PLAN_STEP}.\n${summarize(tracked)}`,
      ],
    }
  })

  on('tool.call', { tool: PLAN_STEP }, async ($, e) => {
    const current = await read($, plan)
    if (current === null) return { deny: 'No plan is being tracked.' }
    if (e.step === undefined && e.status === undefined) return { result: summarize(current) }

    const status = STATUSES.find(one => one === e.status)
    if (status === undefined) return { deny: `status must be one of: ${STATUSES.join(', ')}.` }
    if (!current.steps.some(step => step.n === e.step)) {
      return { deny: `No step ${String(e.step)}. Steps run from 1 to ${current.steps.length}.` }
    }

    const updated = await commit($, {
      ...current,
      steps: current.steps.map(step => (step.n === e.step ? { ...step, status } : step)),
    })

    return { result: summarize(updated) }
  })

  on('tool.call', { tool: PLAN_SET }, async ($, e) => {
    const titles = Array.isArray(e.steps) ? e.steps.filter(one => typeof one === 'string') : []
    if (titles.length === 0) return { deny: 'steps must list at least one step.' }

    const steps: Step[] = titles.map((title, index) => ({
      n: index + 1,
      title,
      details: [],
      status: 'pending',
    }))
    const title = typeof e.title === 'string' ? e.title : 'Plan'
    const tracked = await commit($, carryProgress(await read($, plan), { title, steps }))

    return { result: summarize(tracked) }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const argument = e.args.trim()

    if (argument === 'clear') {
      const forgotten = await forget($)

      return { text: forgotten === null ? 'No plan was tracked.' : `Forgot "${forgotten.title}".` }
    }

    // "import <path>" does what /plan-tracker-import <path> does, for the
    // desktop app, where that command is not registered.
    const path = /^import\s+(.+)$/s.exec(argument)?.[1]?.trim()
    if (path !== undefined && path !== '') {
      const said = await importPlan($, path)
      if (said.startsWith('Tracking')) await $.ui.open(PANE_OPTIONS)

      return { text: said }
    }

    const wanted = argument === 'import' ? 'files' : VIEWS.find(one => one === argument)
    if (wanted !== undefined) {
      await $.ui.open(PANE_OPTIONS)
      await showView($, wanted)

      return { text: `Showing the ${argument} view.` }
    }

    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })

      return { text: 'Plan panel closed.' }
    }

    await $.ui.open(PANE_OPTIONS)

    return { text: 'Plan panel opened.' }
  })

  // Meant for a key binding. Opening an open panel only moves the keyboard to it.
  on('command.run', { command: FOCUS_COMMAND }, async $ => {
    // Already focused: hand the keyboard back to the prompt and leave the panel up.
    // A mod can't release focus directly, but reopening without `focus` does it,
    // and the close brings back any draft.
    const open = (await $.ui.panes()).find(one => one.id === PANE)
    if (open?.isFocused === true) {
      const keep = lastOffset
      await $.ui.close({ id: PANE })
      await $.ui.open(PANE_OPTIONS)
      await restoreScroll($, keep)

      return {}
    }

    await focusPane($)

    return {}
  })

  on('command.run', { command: IMPORT_COMMAND }, async ($, e) => {
    const path = e.args.trim()
    if (path === '') {
      await openOn($, 'files')

      return {}
    }

    const said = await importPlan($, path)
    if (said.startsWith('Tracking')) await $.ui.open(PANE_OPTIONS)

    return { text: said }
  })

  on('command.run', { command: PLANS_COMMAND }, async $ => {
    await openOn($, 'plans')

    return {}
  })

  for (const [command, by] of [
    [NEXT_VIEW_COMMAND, 1],
    [PREVIOUS_VIEW_COMMAND, -1],
  ] as const) {
    on('command.run', { command }, async $ => {
      // Only a shown panel has view names to move along; Enter opens the one lit.
      if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return {}
      const from = ringAt !== undefined && tabs.includes(ringAt) ? ringAt : tabKey(await read($, view))
      const to = tabs[(tabs.indexOf(from) + by + tabs.length) % tabs.length]!
      await focusOn($, to)

      return {}
    })
  }

  on('command.run', { command: FIND_COMMAND }, async $ => {
    const open = (await $.ui.panes()).find(pane => pane.id === PANE)
    if (open?.isFocused !== true) await focusPane($)
    if ((await read($, plan)) === null) {
      $.ui.toast('No plan is tracked yet: nothing to find in.')
      return {}
    }
    if ((await read($, view)) !== 'plan') await showView($, 'plan')
    await startFind($)

    return {}
  })

  on('command.run', { command: PRESS_COMMAND }, async $ => {
    const open = (await $.ui.panes()).find(pane => pane.id === PANE)
    if (open?.isFocused === true && ringAt !== undefined) await press($, ringAt)

    return {}
  })

  // Esc, bound in the Pane and PaneField contexts: it backs out one level.
  // The find bar closes, the plan staying where it is; a search field gives
  // the ring back to the view names; from the view names the panel closes.
  on('command.run', { command: ESCAPE_COMMAND }, async $ => {
    const open = (await $.ui.panes()).find(pane => pane.id === PANE)
    if (open?.isFocused !== true) return {}

    if (await read($, finding)) {
      await stopFind($)
      ringAt = tabKey('plan')
      await focusOn($, tabKey('plan'), false)
      return {}
    }
    if (ringAt === SEARCH_KEY.files || ringAt === SEARCH_KEY.plans) {
      const back = tabKey(await read($, view))
      ringAt = back
      await focusOn($, back)
      return {}
    }
    await $.ui.close({ id: PANE })

    return {}
  })

  // The panel shows the draft it set aside under the prompt, so it is not lost
  // from sight while the panel has the keyboard.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const saved = await read($, draft)
    if (saved === null) return next(e)
    const text = saved.text.replace(/\s+/g, ' ').trim()
    const shown = text.length > 40 ? `${text.slice(0, 39)}…` : text

    return next({ ...e, props: { ...e.props, tail: `draft kept: "${shown}", back when you leave the panel` } })
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await restoreDraft($)

    return closed
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    let landing = e
    if (e.origin.kind === 'person' && e.element !== undefined && tabs.includes(e.element)) {
      const shown = await read($, view)
      const active = tabKey(shown)
      if (ringAt !== undefined && tabs.includes(ringAt)) {
        // Left and Right switch views, so the arrows that step from one name to
        // the next are Up and Down: Down goes on to the search, Up stays put. A
        // click on another name presses it, and the switch moves the ring.
        const isForward = tabs.indexOf(e.element) > tabs.indexOf(ringAt)
        const field = shown === 'files' || shown === 'plans' ? SEARCH_KEY[shown] : undefined
        if (!isForward || field === undefined) return {}
        landing = { ...e, element: field }
      } else if (e.element !== active) {
        // Up from the search field, or a wrap from the last row: the shown view's name.
        landing = { ...e, element: active }
      }
    }

    const cameFrom = ringAt
    const moved = await next(landing)
    ringAt = landing.element
    // Keeps the row the arrows land on in sight in a long list. The ring the
    // panel's autoFocus puts on a view name as it takes the keyboard is left
    // where the window is: following it would jump a long plan to its top.
    const isAsked = landing.origin.kind === 'person' || landing.element === requestedFocus
    if (landing.element === requestedFocus) requestedFocus = undefined
    // Moving the ring out of the find bar by hand puts it away.
    if (landing.element !== SEARCH_KEY.plan && landing.origin.kind === 'person' && (await read($, finding))) {
      await stopFind($)
    }
    // The find bar floats where the window is: revealing it, or the view names
    // on leaving it (Esc), would only move the plan off what was found.
    const isFromFind = cameFrom === SEARCH_KEY.plan
    if (landing.element !== undefined && landing.element !== SEARCH_KEY.plan && isAsked && !isFromFind) {
      await $.ui.scroll({ in: PANE, to: { key: landing.element } }).catch(() => undefined)
    }

    return moved
  })

  // Tracks the row the window shows, and puts it back after a reopen.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    let moving = e
    if (pendingOffset !== undefined && e.origin.kind === 'plugin' && e.contentRows > 0) {
      moving = { ...e, offset: Math.min(pendingOffset, Math.max(0, e.contentRows - e.bodyRows)) }
      pendingOffset = undefined
    }
    const moved = await next(moving)
    if (moved.deny === undefined) {
      lastOffset = moving.offset
      // The find bar is drawn at the window's top row: it moves with the window.
      if (await read($, finding)) await update($, scrollRow, () => moving.offset)
    }

    return moved
  })

  // abovePrompt:leave hands the keyboard back with no event of its own: the
  // pane's next drawing says it, and the draft set aside comes back then.
  let hasHeldKeys = false

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.props.isFocused) hasHeldKeys = true
    else if (hasHeldKeys) {
      hasHeldKeys = false
      void restoreAfterLeave($).catch(() => undefined)
    }
    const ui = $.ui.resolve(e)
    const { Box, Button, Input, Text } = ui
    // The terminal is the one surface without Svg: it draws the bar as text.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const current = await read($, plan)
    const shown = await read($, view)
    // One row in both states, so the panel's content doesn't jump when focus moves.
    const strip = e.props.isFocused ? (
      <Text color="suggestion" weight="bold">
        {headerRow(FOCUSED_HINT, e.props.bodyColumns)}
      </Text>
    ) : (
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text weight="bold">{TITLE}</Text>
        <Text dimColor>{UNFOCUSED_HINT}</Text>
      </Box>
    )
    // Drawn in every view, plan or none: a hotkey with no button to press would
    // fall through to the prompt and take the keyboard away from the panel.
    const tab = (key: PanelView, label: string, hotkey: string) => (
      <Button
        key={tabKey(key)}
        label={label}
        hotkey={hotkey}
        plain
        dimColor={shown !== key}
        {...(shown === key ? { autoFocus: true as const } : {})}
        onPress={() => showView($, key)}
      />
    )
    const tabs = (
      <Box flexDirection="row" gap={2} marginY={1} paddingX={1}>
        {tab('plan', 'Plan', '1')}
        {tab('progress', 'Progress', '2')}
        {tab('plans', 'Plans', '3')}
        {tab('files', 'Import', '4')}
      </Box>
    )
    const frame = (...body: RenderChildren[]) => (
      <Box flexDirection="column">
        {strip}
        {tabs}
        {body}
      </Box>
    )
    const more = (count: number, max = MAX_ROWS) =>
      count > max ? <Text dimColor>{count - max} more: type to narrow the list.</Text> : null
    // A card: a rounded border, lit in the accent for the tracked plan and
    // under the pointer. Its first row is the Button that picks it.
    const card = (key: string, isLit: boolean, ...rows: RenderChildren[]) => (
      <Box
        key={`card:${key}`}
        flexDirection="column"
        borderStyle="round"
        borderColor={isLit ? 'suggestion' : 'subtle'}
        hover={{ borderColor: 'suggestion' }}
        paddingX={1}
      >
        {rows}
      </Box>
    )
    // A card's text, pressable everywhere. The terminal draws one Button over
    // all of its lines; the desktop draws a Button's label on one line, so
    // there each line is a Button of its own, keyed `row:<n>:<card's key>`,
    // that press() answers as the card's first line.
    const cardLines = (key: string, onPress: () => unknown, lines: RenderChildren[]) =>
      e.surface === 'terminal'
        ? [
            <Button key={key} plain onPress={onPress}>
              {lines.flatMap((line, i) => (i === 0 ? [line] : ['\n', line]))}
            </Button>,
          ]
        : lines.map((line, i) => (
            <Button key={i === 0 ? key : `row:${i}:${key}`} plain onPress={onPress}>
              {line}
            </Button>
          ))
    // Inside a card: the pane's padding, the border and the card's own padding.
    const cardColumns = Math.max(12, e.props.bodyColumns - 6)
    const cardBar = (finished: number, total: number) => {
      const count = `${finished} of ${total}`
      if (Svg !== undefined) {
        return (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexGrow={1}>
              <Svg source={progressSvg(finished, total)} alt={`${count} steps finished`} height={4} />
            </Box>
            <Text dimColor>{count}</Text>
          </Box>
        )
      }
      const [filled, rest] = progressBar(finished, total, Math.max(4, cardColumns - count.length - 1))

      return (
        <Text>
          <Text color="suggestion">{filled}</Text>
          <Text color="subtle">{rest}</Text> <Text dimColor>{count}</Text>
        </Text>
      )
    }

    if (shown === 'files') {
      const listed = await read($, files)
      const query = (await read($, search)).files
      const busy = await read($, importing)
      const found = listed.status === 'ready' ? listed.files.filter(file => fileMatches(query, file)) : []
      const pick = (file: PlanFile) => () => pickFile($, file.path)

      return frame(
        <Input
          key={SEARCH_KEY.files}
          label="Search"
          placeholder="filter .md files"
          value={query}
          submitLabel="import"
          onInput={value => update($, search, old => ({ ...old, files: value }))}
          onSubmit={async value => {
            // The field empties itself on Enter: the list follows it.
            await update($, search, old => ({ ...old, files: '' }))
            const first = listed.status === 'ready' ? listed.files.find(file => fileMatches(value, file)) : undefined
            if (first !== undefined) await pick(first)()
          }}
        />,
        <Text dimColor>
          {busy !== null
            ? `Analyzing ${busy}…`
            : listed.status === 'loading'
              ? 'Looking for .md files…'
              : listed.status === 'error'
                ? listed.message
                : `${found.length} of ${listed.files.length} .md files · ↑ to the views · ↓ to the list · Enter imports`}
        </Text>,
        <Box flexDirection="column" marginTop={1} gap={1}>
          {found.slice(0, MAX_CARDS).map(file => {
            const { name, folder } = splitPath(file.label)

            return card(
              file.path,
              false,
              ...cardLines(`file:${file.path}`, pick(file), [
                <Text bold>{name}</Text>,
                <Text dimColor>
                  {busy === file.path ? 'Analyzing…' : folder}
                  {file.worktree !== undefined ? `  [${file.worktree}]` : ''}
                </Text>,
              ]),
            )
          })}
        </Box>,
        more(found.length, MAX_CARDS),
      )
    }

    if (shown === 'plans') {
      const all = await read($, library)
      const query = (await read($, search)).plans
      const found = all.filter(one => planMatches(query, one))
      const cwd = await $.session.cwd().catch(() => '')
      const activeId = current === null ? undefined : planId(current)
      const now = await $.clock.now().catch(() => Date.now())

      return frame(
        <Input
          key={SEARCH_KEY.plans}
          label="Search"
          placeholder="filter saved plans"
          value={query}
          submitLabel="track"
          onInput={value => update($, search, old => ({ ...old, plans: value }))}
          onSubmit={async value => {
            await update($, search, old => ({ ...old, plans: '' }))
            const first = all.find(one => planMatches(value, one))
            if (first !== undefined) await choose($, planId(first))
          }}
        />,
        <Text dimColor>
          {all.length === 0
            ? 'No saved plans yet. Press 4 to import one.'
            : `${found.length} of ${all.length} plans · ↑ to the views · ↓ to the list · Enter tracks it`}
        </Text>,
        <Box flexDirection="column" marginTop={1} gap={1}>
          {found.slice(0, MAX_CARDS).map(one => {
            const id = planId(one)
            const isActive = id === activeId
            const finished = one.steps.filter(isFinished).length
            const where = one.source !== undefined ? shortPath(one.source, cwd) : 'from Claude'
            const when = ago(one.updatedAt, now)
            const working = one.steps.find(step => step.status === 'in_progress')
            const upNext = one.steps.find(step => step.status === 'pending')
            const state =
              one.steps.length === 0 ? (
                <Text dimColor>No steps</Text>
              ) : finished === one.steps.length ? (
                <Text color="success">✓ Finished</Text>
              ) : working !== undefined ? (
                <Text wrap="truncate-end">
                  <Text color="suggestion">◐</Text> {working.title}
                </Text>
              ) : (
                <Text wrap="truncate-end">
                  <Text color="subtle">○</Text> Next: {upNext?.title ?? ''}
                </Text>
              )

            return card(
              id,
              isActive,
              // A Button holds only text: the terminal's text bar is one of the
              // card's lines, the desktop's drawn bar goes under them.
              ...cardLines(`plan:${id}`, () => choose($, id), [
                <Text>
                  {isActive ? <Text color="suggestion">● </Text> : ''}
                  <Text bold>{one.title}</Text>
                </Text>,
                ...(Svg === undefined ? [cardBar(finished, one.steps.length)] : []),
                state,
                <Text dimColor>
                  {where}
                  {when === '' ? '' : ` · ${when}`}
                </Text>,
              ]),
              Svg !== undefined ? cardBar(finished, one.steps.length) : null,
            )
          })}
        </Box>,
        more(found.length, MAX_CARDS),
      )
    }

    if (current === null) {
      return frame(
        <Text dimColor>No plan tracked yet.</Text>,
        <Text dimColor>Approve a plan in plan mode, press 4 to import a .md file, or 3 to pick a saved plan.</Text>,
      )
    }

    if (shown === 'plan' && e.surface !== 'terminal' && 'Markdown' in ui) {
      // The desktop app refuses the drawing the panel's own renderer makes of a
      // rich plan, and then keeps an older drawing whose buttons no longer
      // answer. Outside the terminal the surface's own Markdown draws the plan;
      // the find bar, bound to a terminal key, stays with the terminal renderer.
      // Its Markdown cannot light matches inside the text, so a find lists the
      // matching lines above the plan instead, the match in bold.
      const { Markdown } = ui
      const text = planMarkdown(current)
      const isFinding = await read($, finding)
      const query = (await read($, search)).plan
      const hits = isFinding ? foundLines(text, query) : []
      const count = hits.reduce((sum, hit) => sum + hit.ranges.length, 0)

      const finder = isFinding ? (
        <Box flexDirection="column" paddingX={1} gap={1}>
          <Box flexDirection="row" gap={2}>
            <Input
              key={SEARCH_KEY.plan}
              label="Find"
              placeholder="text in the plan"
              value={query}
              onInput={value => update($, search, old => ({ ...old, plan: value, planMatch: -1 }))}
              onSubmit={value => update($, search, old => ({ ...old, plan: value, planMatch: -1 }))}
            />
            <Button key={FIND_CLOSE} label="Close" plain onPress={() => press($, FIND_CLOSE)} />
          </Box>
          {query === '' ? null : (
            <Text dimColor>
              {count === 0 ? 'No matches' : `${count} ${count === 1 ? 'match' : 'matches'} in ${hits.length} ${hits.length === 1 ? 'line' : 'lines'}`}
            </Text>
          )}
          {hits.length === 0 ? null : (
            <Box flexDirection="column">
              {hits.slice(0, MAX_FOUND_LINES).map(hit => (
                <Text key={`found:${hit.line}`}>
                  <Text dimColor>{`${hit.line + 1}  `}</Text>
                  {cutAtRanges(hit.text, hit.ranges).map((part, i) =>
                    part.isMatch ? (
                      <Text key={`m${i}`} bold color="suggestion">
                        {part.text}
                      </Text>
                    ) : (
                      part.text
                    ),
                  )}
                </Text>
              ))}
              {hits.length > MAX_FOUND_LINES ? <Text dimColor>{hits.length - MAX_FOUND_LINES} more lines: type more to narrow.</Text> : null}
            </Box>
          )}
        </Box>
      ) : (
        <Box paddingX={1}>
          <Button key={FIND_OPEN} label="Find in the plan" plain dimColor onPress={() => press($, FIND_OPEN)} />
        </Box>
      )

      return frame(
        finder,
        <Box paddingX={1} marginTop={1}>
          <Markdown key="plan-markdown" text={text} />
        </Box>,
      )
    }

    if (shown === 'plan') {
      const blocks = documentOf(planMarkdown(current))
      const isFinding = await read($, finding)
      const { plan: query, planMatch } = await read($, search)
      const total = searchDocument(blocks, query).length
      const lit = isFinding ? query : ''
      const barWidth = Math.min(48, Math.max(24, e.props.bodyColumns - 4))
      const status =
        query === '' ? 'Enter next · ctrl+enter previous · Esc' : total === 0 ? 'No matches' : planMatch < 0 ? `${total} matches · Enter to go` : `${planMatch + 1} of ${total}`
      const bar = isFinding ? (
        <Box
          position="absolute"
          top={await read($, scrollRow)}
          right={1}
          width={barWidth}
          flexDirection="column"
          borderStyle="round"
          borderColor="suggestion"
          backgroundColor="inverseText"
          paddingX={1}
        >
          <Input
            key={SEARCH_KEY.plan}
            label="Find"
            placeholder="text in the plan"
            value={refills % 2 === 0 ? query : query + ZERO_WIDTH}
            submitLabel="next"
            onInput={async value => {
              // A new line is Ctrl+Enter (or Shift+Enter) in the field: the match before.
              if (value.includes('\n')) return stepMatch($, value, -1)
              const text = fieldText(value)
              // The emptying that follows an Enter is the engine's, not a new search.
              if (text === '' && (await read($, search)).planMatch >= 0) return
              await update($, search, old => ({ ...old, plan: text, planMatch: -1 }))
            }}
            onSubmit={value => stepMatch($, value, 1)}
          />
          <Text dimColor>{status}</Text>
        </Box>
      ) : null

      return (
        <Box flexDirection="column">
          {strip}
          {tabs}
          {isFinding ? null : (
            <Box paddingX={1}>
              <Text dimColor>f to find in the plan</Text>
            </Box>
          )}
          <Box marginTop={1}>{drawPlan(ui, blocks, lit, planMatch, e.props.bodyColumns)}</Box>
          {bar}
        </Box>
      )
    }

    const finished = current.steps.filter(isFinished).length
    const total = current.steps.length
    const barWidth = Math.max(4, e.props.bodyColumns - 2)
    const [filled, rest] = progressBar(finished, total, barWidth)
    const bar =
      Svg !== undefined ? (
        <Svg source={progressSvg(finished, total)} alt={`${finished} of ${total} steps finished`} height={4} />
      ) : (
        <Text>
          <Text color="suggestion">{filled}</Text>
          <Text color="subtle">{rest}</Text>
        </Text>
      )

    return frame(
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="bold">{current.title}</Text>
          <Text dimColor>
            {finished} of {total}
          </Text>
        </Box>
        {bar}
        <Box flexDirection="column" marginTop={1}>
          {current.steps.map(step => (
            <Box key={`step:${step.n}`} flexDirection="column">
              <Text>
                <Text color={COLORS[step.status] ?? 'subtle'}>{MARKS[step.status]}</Text>{' '}
                <Text
                  dimColor={isFinished(step)}
                  strikethrough={step.status === 'done'}
                  weight={step.status === 'in_progress' ? 'bold' : undefined}
                >
                  {step.title}
                </Text>
              </Text>
              {step.status === 'in_progress' &&
                step.details.map(detail => (
                  <Box paddingLeft={2}>
                    <Text dimColor>{detail}</Text>
                  </Box>
                ))}
            </Box>
          ))}
        </Box>
      </Box>,
    )
  }).catch(($, e, next) => {
    // A failed drawing leaves the desktop on its last good one, whose buttons
    // no longer answer: say why in the pane instead of going quiet.
    const { Box, Text } = $.ui.resolve(e)
    const why = next.error.kind === 'timeout' ? `timed out after ${next.error.budget}ms` : (next.error.message ?? 'failed')

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="error">The plan panel could not draw ({next.error.kind}).</Text>
        <Text dimColor>{why}</Text>
      </Box>
    )
  })

  // Every press in the panel is answered here by its key, not by the Button's
  // onPress: the desktop app can send a press with the handle of a drawing the
  // engine has already let go, which no closure answers any more. Registered
  // last, so nothing above depends on it.
  on('ui.press', { plugin: PANE }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    await press($, e.element)

    return { element: e.element }
  })
}
