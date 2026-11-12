export type StepStatus = 'pending' | 'in_progress' | 'done' | 'skipped'

export type Step = {
  n: number
  title: string
  details: string[]
  status: StepStatus
}

export type Plan = {
  title: string
  steps: Step[]
  markdown?: string
  // Set once the plan is in the library: `file:<absolute path>` for an
  // imported file, `native:<title>` for one approved or set by Claude.
  id?: string
  // The absolute path of the file an imported plan came from.
  source?: string
  // The source file's `<mtimeMs>:<size>` when it was last read: a different one
  // on disk means the file changed and the plan is read from it again.
  sourceStamp?: string
  updatedAt?: number
}

export type PanelView = 'progress' | 'plan' | 'files' | 'plans'

export type Draft = { text: string; cursor: number }

// A Markdown file the import view offers: `path` absolute, `label` the path
// inside its worktree, `worktree` the branch or folder name when there are several.
export type PlanFile = { path: string; label: string; worktree?: string }

export type FileList =
  | { status: 'loading' }
  | { status: 'ready'; files: PlanFile[] }
  | { status: 'error'; message: string }

// `plan` is the text searched in the plan view, `planMatch` the match shown.
export type Search = { files: string; plans: string; plan: string; planMatch: number }

declare module 'claude-code' {
  interface PluginState {
    'plan-tracker-panel': {
      plan: Shaped<Plan | null>
      view: Shaped<PanelView>
      draft: Shaped<Draft | null>
      library: Shaped<Plan[]>
      files: Shaped<FileList>
      search: Shaped<Search>
      // The path being imported while its analysis runs.
      importing: Shaped<string | null>
      // Whether the find bar floats over the plan view, holding the keyboard.
      finding: Shaped<boolean>
      // The row the pane's window shows, which the find bar is drawn at.
      scrollRow: Shaped<number>
    }
  }
}
