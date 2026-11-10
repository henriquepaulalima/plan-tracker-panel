import type { Plan, Step, StepStatus } from '../types'

// Sections that describe a plan rather than being a step of it.
const META_HEADING =
  /^(context|overview|summary|background|goals?|non-goals?|notes?|verification|testing|test plan|risks?|open questions?|assumptions?|(critical |key )?files|out of scope|references?|problem|why)\b/i

const HEADING = /^(#{1,6})\s+(.*)$/
const NUMBERED_TITLE = /^(?:(?:step|phase|stage|part)\s+)?\d+\s*[.):\-–—]?\s+(.+)$/i
const NUMBERED_ITEM = /^(\s*)\d+[.)]\s+(.+)$/
const CHECKBOX_ITEM = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/
const BULLET_ITEM = /^(\s*)[-*+]\s+(.+)$/

type Line = {
  raw: string
  heading?: { level: number; text: string }
  section?: string
}

type Start = { index: number; title: string; status: StepStatus }

function clean(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/:\s*$/, '')
    .trim()
}

function readLines(markdown: string): Line[] {
  const lines: Line[] = []
  let isInFence = false
  let section: string | undefined

  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      isInFence = !isInFence
      continue
    }
    if (isInFence) continue

    const match = HEADING.exec(raw)
    if (match) {
      const text = clean(match[2] ?? '')
      section = text
      lines.push({ raw, section, heading: { level: match[1]?.length ?? 1, text } })
    } else {
      lines.push({ raw, section })
    }
  }

  return lines
}

function isMeta(section: string | undefined): boolean {
  return section !== undefined && META_HEADING.test(section)
}

function numberedHeadings(lines: Line[]): Start[] {
  return lines.flatMap((line, index) => {
    const match = line.heading && NUMBERED_TITLE.exec(line.heading.text)

    return match ? [{ index, title: clean(match[1] ?? ''), status: 'pending' as const }] : []
  })
}

// Items of the list kind `pattern` at its shallowest indent, outside meta sections.
function listItems(lines: Line[], pattern: RegExp, titleGroup: number): Start[] {
  const found = lines.flatMap((line, index) => {
    const match = isMeta(line.section) ? null : pattern.exec(line.raw)

    return match ? [{ index, match }] : []
  })
  const indent = Math.min(...found.map(item => item.match[1]?.length ?? 0))

  return found
    .filter(item => (item.match[1]?.length ?? 0) === indent)
    .map(item => ({
      index: item.index,
      title: clean(item.match[titleGroup] ?? ''),
      status: titleGroup === 3 && item.match[2] !== ' ' ? ('done' as const) : ('pending' as const),
    }))
}

function plainHeadings(lines: Line[]): Start[] {
  const headings = lines.flatMap((line, index) =>
    line.heading && !isMeta(line.heading.text)
      ? [{ index, level: line.heading.level, text: line.heading.text }]
      : [],
  )
  const titled = headings[0]?.level === 1 ? headings.slice(1) : headings
  const level = Math.min(...titled.map(heading => heading.level))

  return titled
    .filter(heading => heading.level === level)
    .map(heading => ({ index: heading.index, title: heading.text, status: 'pending' as const }))
}

function findStarts(lines: Line[]): Start[] {
  const strategies = [
    () => numberedHeadings(lines),
    () => listItems(lines, CHECKBOX_ITEM, 3),
    () => listItems(lines, NUMBERED_ITEM, 2),
    () => plainHeadings(lines),
    () => listItems(lines, BULLET_ITEM, 2),
  ]

  for (const strategy of strategies) {
    const starts = strategy()
    if (starts.length >= 2) return starts
  }

  return []
}

function detailsOf(lines: Line[], start: Start, end: number): string[] {
  const own = lines[start.index]?.heading
  const details: string[] = []

  for (const line of lines.slice(start.index + 1, end)) {
    if (line.heading && (!own || line.heading.level <= own.level || isMeta(line.heading.text))) break
    const text = clean(line.heading ? line.heading.text : line.raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))
    if (text !== '') details.push(text)
  }

  return details
}

export function parsePlan(markdown: string): Plan {
  const lines = readLines(markdown)
  const first = lines.find(line => line.heading?.level === 1)?.heading?.text
  const starts = findStarts(lines)
  const steps: Step[] = starts.map((start, position) => ({
    n: position + 1,
    title: start.title,
    details: detailsOf(lines, start, starts[position + 1]?.index ?? lines.length),
    status: start.status,
  }))

  return { title: first ?? 'Plan', steps }
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim()
}

// A revised plan keeps the progress of every step whose title did not change.
export function carryProgress(previous: Plan | null, plan: Plan): Plan {
  const known = new Map(previous?.steps.map(step => [titleKey(step.title), step.status]) ?? [])

  return {
    ...plan,
    steps: plan.steps.map(step => ({
      ...step,
      status: step.status === 'pending' ? (known.get(titleKey(step.title)) ?? 'pending') : step.status,
    })),
  }
}

export function isFinished(step: Step): boolean {
  return step.status === 'done' || step.status === 'skipped'
}

export function summarize(plan: Plan): string {
  const finished = plan.steps.filter(isFinished).length
  const rows = plan.steps.map(step => `${step.n}. [${step.status}] ${step.title}`)

  return [`${plan.title}: ${finished}/${plan.steps.length} finished`, ...rows].join('\n')
}
