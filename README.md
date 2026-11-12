# plan-tracker-panel

A side panel for the Claude Code CLI that shows your approved implementation plan and which steps are done, in progress or still left, so you don't have to scroll back or ask Claude to reprint it.

## Install

At the prompt of a terminal session:

```
/plugin install plan-tracker-panel --marketplace henriquepaulalima/plan-tracker-panel
```

Answer `y` to add the marketplace, then choose a scope.

## Use

| Command | Key | What it does |
| --- | --- | --- |
| `/plan-tracker-panel` | | Shows or hides the panel |
| `/plan-tracker-focus` | `alt+k` | Gives the panel the keyboard, or hands it back |
| `/plan-tracker-import` | `alt+i` | Opens the picker of every `.md` file in the repository and its worktrees |
| `/plan-tracker-import <path>` | | Imports that file directly |
| `/plan-tracker-plans` | `alt+l` | Opens the list of saved plans, to search and switch |
| `/plan-tracker-next-view`, `/plan-tracker-previous-view` | `right`, `left` | Move the panel's highlight to the next or previous view name |
| `/plan-tracker-press` | `enter` | Presses what the panel's highlight is on |
| `/plan-tracker-find` | `f` | Opens the find bar over the Plan view |
| `/plan-tracker-escape` | `escape` | Closes the panel from the view names |
| `/plan-tracker-panel clear` | | Forgets the tracked plan and drops it from the list |

Only `/plan-tracker-panel` is listed when you type `/`. The other commands are left out of the typeahead and `/help` because the key bindings run them, but each still runs when typed in full. In the Claude desktop app they are not registered at all, since key bindings only apply in the terminal: click the view names instead, and use `/plan-tracker-panel import <path>` to import a file directly.

The keys are bindings in `~/.claude/keybindings.json`. `alt+k` works from the prompt and the panel. `alt+i`, `alt+l`, the arrows and Enter work only while the panel is open and has the keyboard, so they are bound in the `Pane` context alone. Left must be bound there: otherwise it falls through to Claude Code's own `←` shortcut, which leaves the panel for the agents view. Enter must be bound too: until you have moved the highlight with an arrow yourself, Claude Code sends Enter to the prompt, even with the highlight on a view name. Inside the search field none of these fire, so the arrows move the cursor and Enter searches.

```json
{ "context": "Chat", "bindings": {
  "alt+k": "command:plan-tracker-focus" } },
{ "context": "Pane", "bindings": {
  "alt+k": "abovePrompt:leave",
  "escape": "command:plan-tracker-escape",
  "alt+i": "command:plan-tracker-import",
  "alt+l": "command:plan-tracker-plans",
  "right": "command:plan-tracker-next-view",
  "left": "command:plan-tracker-previous-view",
  "enter": "command:plan-tracker-press",
  "f": "command:plan-tracker-find" } },
{ "context": "PaneField", "bindings": {
  "escape": "abovePrompt:previous" } }
```

In the pane, `alt+k` is bound to Claude Code's own `abovePrompt:leave`, which hands the keyboard back and leaves the pane where it is: a command would have to close and reopen the pane, and the chat would widen across the gap for a frame. Esc is the panel's `plan-tracker-escape`, which closes the panel from the view names. Inside a field Claude Code runs no `command:` binding, so there Esc is bound to `abovePrompt:previous`: it steps out of the field, which closes the find bar or goes back to the view names.

Approve a plan in plan mode and its steps are tracked automatically. Claude reports progress as it works, and the panel updates live:

```
Add login                    1 of 3
━━━━━━━━━──────────────────────────

● Create the User model
◐ Add the /login route
  validate the password
○ Write tests
```

The panel has four views, in this order: Plan, Progress, Plans and Import. While the panel has the keyboard, `1` to `4` switch between them. Left and Right move the highlight along the view names, and Enter opens the highlighted one. Down from the view names goes to the search field and then the rows, and Up from the search field goes back to the view names. The keyboard lands on the view names, not in the search field, so the keys keep working as you switch.

Plans and Import show each entry as a card. A plan's card has its title, a progress bar, the step in progress (or the next one, or "Finished"), and where it came from with when it last changed; the tracked plan's card has an accent border. A file's card has its name, folder and worktree. Up to 50 cards are drawn; type in the search field to narrow the rest. In Plans and Import, press Down from the view names to reach the search field and type to filter the list. Down again moves into the rows, and Enter imports or tracks the highlighted one (Enter in the field takes the first match). While the search field has the keyboard, Claude Code sends no key bindings, so press Up or Esc to go back to the view names before using `alt+k`, `alt+i`, `alt+l` or the digits. From the view names, Esc closes the panel.

With Claude Code's fullscreen renderer the panel docks beside the conversation. Otherwise it opens above the prompt.

In the Claude desktop app the Plan view draws the plan with the app's own Markdown. Click "Find in the plan" there to open a search field: the matching lines are listed under it, with the match in bold, and Close puts it away. In the terminal it draws the whole plan with its own Markdown renderer: tables are fitted to the panel's width, with long cells wrapping inside their borders, and code blocks are drawn in a frame with their language. Press `alt+k` then `f` to open the find bar, which floats at the top of the panel as you scroll. Matches are highlighted as you type. Enter goes to the first match and then the next one, and Ctrl+Enter (or any key that types a new line there, such as Shift+Enter) goes to the previous one. Esc closes the find bar and leaves the panel with the keyboard, and a second Esc closes the panel. `f` is bound in the `Pane` context, so it is taken from other plugins' panes too. Giving the panel the keyboard, or taking it back with `alt+k`, keeps the scroll position.

## Importing a plan

The picker lists the `.md` files git knows about in every worktree, tracked or untracked, leaving out what `.gitignore` excludes. An imported plan comes in with each step's status as the file says it:

- checkboxes: `[x]` done, `[~]` or `[/]` in progress, `[-]` skipped, `[ ]` pending
- tags on a step's title: `(done)`, `[WIP]`, `— in progress`, `✅`, `🚧`, `⏭`, or the whole title struck through for skipped
- a `Status: done` line under a step
- a step whose sub-items are checkboxes: done when all are ticked, in progress when some are

When a file says none of this (a plain numbered list, or a table or prose status), the plan is also sent to the `haiku` model, which reads the statuses from the text. The steps found in the file are kept, and only their statuses come from the model.

Importing the same file again keeps the progress Claude reported since, for every step the file still lists as pending.

The tracked plan follows its file. The panel checks the file once a second and reads it again whenever it changes, so a session that keeps editing the plan (ticking boxes, adding or rewording steps) updates the Plan and Progress views as it goes, with no new import. Progress Claude reported is kept the same way as on a re-import. When the steps themselves change, Claude is sent the new step numbers. A file that is deleted or has no steps for a moment leaves the plan as it was until the file is readable again.

## Saved plans

Every imported, approved or `plan_set` plan is kept in a list shared by all worktrees of the repository. Each folder remembers which plan it shows. Switching plans from the list tells Claude, so its `plan_step` reports go to the new plan.

## Limits

The panel's keys run slash commands, which Claude Code normally shows in the chat as a prompt row and a spinner. The mod draws those rows as nothing for its own key-bound commands (not for `/plan-tracker-panel`, which you type), so the chat doesn't jump on each key. If a key is pressed while Claude is working, the spinner is hidden for that moment too.

The checkmarks are only as accurate as Claude's reporting. If a step looks stale, ask Claude to update the plan panel.

The mod adds a short instruction to the system prompt and one tool definition to every session. Importing a file that has no status markers spends one small `haiku` request on it, and so does each later change to that file while it is tracked.

## Develop

```
claude --plugin-dir ./
claude plugin validate .
claude plugin test .
```

## License

MIT
