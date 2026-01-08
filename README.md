# Claude Kanban

Filesystem-based kanban board for Claude Code. No servers, just folders.

## Install

```
/plugin marketplace add dylangroos/claude-kanban
/plugin install kanban@dylangroos-claude-kanban
```

## Setup

In your project:
```
/kanban-init
```

Or manually: `mkdir -p .kanban/{todo,doing,done}`

## Use

```
/kanban              # view board
/kanban add <task>   # add task
/kanban done <task>  # mark done
/kanban move <task> doing
```

Or natural language:
- "show my board"
- "add a task to fix the login"
- "move refactor-api to done"

## Structure

```
.kanban/
├── todo/              # to do
├── doing/             # in progress
└── done/              # complete
```

## Cards

Filename = task (`fix-bug.md`). Content = description.

```markdown
Users can't log in on Safari.
```

Optional priority:
```markdown
---
p: high
---
Users can't log in on Safari.
```

## Why

- Zero infrastructure
- Human-readable (just browse the folders)
- Git-friendly (branch boards, track changes)
- Works offline
- Agents already know how to use files

## License

MIT
