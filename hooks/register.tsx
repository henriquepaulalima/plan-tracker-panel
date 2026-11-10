import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, Step, StepStatus } from '../types'
import { carryProgress, isFinished, parsePlan, summarize } from './parse'

const PANE = 'plan-tracker-panel'
const COMMAND = 'plan-tracker-panel'
const PLAN_STEP = 'mcp__plan-tracker-panel__plan_step'
const PLAN_SET = 'mcp__plan-tracker-panel__plan_set'
const STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'done', 'skipped']

// Kept unchanged whatever the progress: a system prompt that varied per step
// would throw away the prompt cache on every update.
const REPORTING_NOTE = `The person follows approved plans in a side panel. While a plan is tracked, call ${PLAN_STEP} with status "in_progress" when you start a step and "done" or "skipped" when you finish it, as you go rather than in a batch at the end. Call it with no arguments to see the current step numbers. If the person agrees to a multi-step plan outside plan mode, call ${PLAN_SET} with its steps.`

const plan = atom({ plugin: 'plan-tracker-panel', key: 'plan' } as const, null, {
  shape: 'plan-1',
})

async function storeKey($: EngineInterface): Promise<string> {
  return `plan:${await $.session.cwd()}`
}

async function commit($: EngineInterface, next: Plan | null): Promise<void> {
  await update($, plan, () => next)
  const key = await storeKey($)
  if (next === null) await $.store.delete(key)
  else await $.store.set(key, next)
}

function isPlan(value: unknown): value is Plan {
  return typeof value === 'object' && value !== null && Array.isArray((value as Plan).steps)
}

const MARKS: Record<StepStatus, string> = {
  pending: '○',
  in_progress: '▶',
  done: '✓',
  skipped: '–',
}

const COLORS: Partial<Record<StepStatus, string>> = {
  in_progress: 'warning',
  done: 'success',
}

function progressBar(finished: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((finished / total) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the plan progress panel ("clear" forgets the plan)',
    })
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
        'Track a multi-step plan agreed outside plan mode, replacing the current one. Steps whose titles are unchanged keep their progress.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['title', 'steps'],
      },
    })

    if ((await read($, plan)) === null) {
      const saved = await $.store.get(await storeKey($))
      if (isPlan(saved) && !saved.steps.every(isFinished)) await update($, plan, () => saved)
    }

    return next(e)
  })

  on('tool.check', { tool: PLAN_STEP }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: PLAN_SET }, () => ({ decision: 'allow' }))

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

    const parsed = parsePlan(text)
    if (parsed.steps.length === 0) {
      return {
        ...ran,
        context: [
          ...(ran.context ?? []),
          `The plan panel found no steps in this plan. Call ${PLAN_SET} with its steps so the person can follow it.`,
        ],
      }
    }

    const tracked = carryProgress(await read($, plan), parsed)
    await commit($, tracked)
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

    const updated = {
      ...current,
      steps: current.steps.map(step => (step.n === e.step ? { ...step, status } : step)),
    }
    await commit($, updated)

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
    const tracked = carryProgress(await read($, plan), { title, steps })
    await commit($, tracked)

    return { result: summarize(tracked) }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await commit($, null)

      return { text: 'Forgot the tracked plan.' }
    }

    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })

      return { text: 'Plan panel closed.' }
    }

    await $.ui.open({ id: PANE, title: 'Plan' })

    return { text: 'Plan panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const current = await read($, plan)

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No plan tracked yet.</Text>
          <Text dimColor>Approve a plan in plan mode and its steps appear here.</Text>
        </Box>
      )
    }

    const finished = current.steps.filter(isFinished).length
    const total = current.steps.length
    const barWidth = Math.max(4, e.props.bodyColumns - 10)

    return (
      <Box flexDirection="column">
        <Text weight="bold">{current.title}</Text>
        <Text>
          {progressBar(finished, total, barWidth)} {finished}/{total}
        </Text>
        {current.steps.map(step => (
          <Box flexDirection="column" marginTop={1}>
            <Text color={COLORS[step.status]} dimColor={step.status === 'skipped'}>
              {MARKS[step.status]} {step.n}. {step.title}
            </Text>
            {!isFinished(step) &&
              step.details.map(detail => (
                <Box paddingLeft={4}>
                  <Text dimColor>{detail}</Text>
                </Box>
              ))}
          </Box>
        ))}
      </Box>
    )
  })
}
