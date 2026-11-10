# plan-tracker-panel

A side panel for the Claude Code CLI that shows your approved implementation plan and which steps are done, in progress or still left, so you don't have to scroll back or ask Claude to reprint it.

## Install

At the prompt of a terminal session:

```
/plugin install plan-tracker-panel --marketplace henriquepaulalima/plan-tracker-panel
```

Answer `y` to add the marketplace, then choose a scope.

## Use

| Command | What it does |
| --- | --- |
| `/plan-tracker-panel` | Shows or hides the panel |
| `/plan-tracker-panel clear` | Forgets the tracked plan |

Approve a plan in plan mode and its steps are tracked automatically. Claude reports progress as it works, and the panel updates live:

```
Add login
██████░░░░░░░░░ 1/3

✓ 1. Create the User model

▶ 2. Add the /login route
    validate the password

○ 3. Write tests
```

Press `ctrl+x tab` to give the panel the keyboard, then use the arrows to scroll a long plan. With Claude Code's fullscreen renderer the panel docks beside the conversation. Otherwise it opens above the prompt.

## How it works

- When a plan is approved, the mod splits it into steps. It looks for numbered headings, then checkboxes, numbered lists, section headings and bullets, and skips sections such as Context or Verification.
- Claude reports progress through a small `plan_step` tool added by the mod. The tool only updates the panel, so it runs without a permission prompt.
- A plan agreed outside plan mode can be tracked through the `plan_set` tool. Ask Claude to track it.
- If a plan is revised, steps whose titles did not change keep their progress.
- An unfinished plan is saved per project folder and comes back in your next session there.

## Limits

The checkmarks are only as accurate as Claude's reporting. If a step looks stale, ask Claude to update the plan panel.

The mod adds a short instruction to the system prompt and one tool definition to every session.

## Develop

```
claude --plugin-dir ./
claude plugin validate .
claude plugin test .
```

## License

MIT
