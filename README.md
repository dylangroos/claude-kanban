# Claude Kanban

Filesystem-based kanban board for Claude Code. No servers, no databases, just folders and markdown files.

```
.kanban/
├── todo/           fix-login-bug.md
├── doing/          refactor-api.md
└── done/           setup-eslint.md
```

## Install

### Claude Code Plugin

```
/plugin marketplace add dylangroos/claude-kanban
/plugin install kanban
```

### Standalone (npx)

```
npx dot-kanban
```

Runs a local web UI at `localhost:4040`. Zero dependencies.

## Web UI

Launch the visual board from Claude or standalone:

```
/kanban ui                          # from Claude Code
npx dot-kanban                      # from any terminal
npx dot-kanban ~/path/to/project    # point at a specific project
```

- Drag-and-drop cards between columns
- Click to open full markdown preview
- Add, edit, delete cards from the browser
- Auto-syncs with `.kanban/` folder every 3s

## CLI Commands

```
/kanban              # view board
/kanban add <task>   # add card to todo
/kanban done <task>  # mark complete
/kanban move <task> doing
/kanban ui           # open web UI
```

Or natural language:
- "show my board"
- "add a task to fix the login"
- "move refactor-api to done"

## Setup

Initialize a board in any project:

```
/kanban-init
```

Or manually: `mkdir -p .kanban/{todo,doing,done}`

## Cards

Each card is a markdown file. Filename = task name (`fix-bug.md`). Content = description with full markdown support.

```markdown
Users can't log in on Safari. Check cookie settings.
```

Optional priority:

```markdown
---
p: high
---
Users on Safari get stuck in redirect loop after OAuth login.
```

## Agents

**task-planner** - Break down big features into cards:
- "plan out the authentication system"
- "break this feature into tasks"

**standup** - Quick status report:
- "what's the status?"
- "give me a standup"

## Why

- **Zero infrastructure** - just folders and `.md` files
- **Human-readable** - browse cards in your file explorer or editor
- **Git-friendly** - branch boards, track changes, review diffs
- **Works offline** - no network, no accounts
- **Two interfaces** - CLI via Claude Code, visual via web UI
- **Auto-context** - hook injects board state into every Claude prompt

## License

MIT
