import type { Plan, PlanFile } from '../types'

export type Worktree = { path: string; name: string }

// `git worktree list --porcelain`: a block per worktree, the main one first.
export function readWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split(/\n\s*\n/)
    .flatMap(block => {
      const lines = block.split('\n')
      const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
      if (path === undefined || lines.includes('bare')) return []
      const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length)
      const name = branch?.replace(/^refs\/heads\//, '') ?? path.split('/').pop() ?? path

      return [{ path, name }]
    })
}

// `git ls-files -z`: NUL-separated paths relative to the worktree.
export function readFileList(worktree: Worktree, output: string, isNamed: boolean): PlanFile[] {
  const seen = new Set<string>()

  return output
    .split('\0')
    .filter(label => /\.md$/i.test(label) && !seen.has(label) && seen.add(label))
    .sort((a, b) => a.localeCompare(b))
    .map(label => ({
      path: `${worktree.path.replace(/\/$/, '')}/${label}`,
      label,
      ...(isNamed ? { worktree: worktree.name } : {}),
    }))
}

// The worktree the session runs in first, then the others as git lists them.
export function ownFirst(worktrees: Worktree[], cwd: string): Worktree[] {
  const isOwn = (tree: Worktree) => cwd === tree.path || cwd.startsWith(`${tree.path}/`)
  const own = worktrees.filter(isOwn).sort((a, b) => b.path.length - a.path.length)[0]

  return own === undefined ? worktrees : [own, ...worktrees.filter(tree => tree !== own)]
}

// Every word of the query, in any order, ignoring case.
export function matches(query: string, ...fields: (string | undefined)[]): boolean {
  const haystack = fields.filter(Boolean).join(' ').toLowerCase()

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(word => haystack.includes(word))
}

export function fileMatches(query: string, file: PlanFile): boolean {
  return matches(query, file.label, file.worktree)
}

export function planMatches(query: string, plan: Plan): boolean {
  return matches(query, plan.title, plan.source, ...plan.steps.map(step => step.title))
}

export function newestFirst(plans: readonly Plan[]): Plan[] {
  return [...plans].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}
