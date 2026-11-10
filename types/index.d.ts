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
}

declare module 'claude-code' {
  interface PluginState {
    'plan-tracker-panel': { plan: Shaped<Plan | null> }
  }
}
