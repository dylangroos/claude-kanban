---
name: kanban
description: Manage tasks using .kanban/ folders. Use when user mentions tasks, cards, board, todo, doing, done, or tracking work.
---

# Kanban Board

Tasks live in `.kanban/` as markdown files in column folders.

## Structure

```
.kanban/
├── todo/    # To do
├── doing/   # In progress
└── done/    # Complete
```

## Cards

Filename = task title (kebab-case, `.md`).

**Simple card** (`fix-login-bug.md`):
```
Users can't log in on Safari. Check cookie settings.
```

**With priority** (`fix-login-bug.md`):
```
---
p: high
---
Users can't log in on Safari.
```

## Operations

| Do this | How |
|---------|-----|
| View board | `Glob .kanban/**/*.md` then `Read` each |
| Add card | `Write` to `.kanban/todo/<slug>.md` |
| Move card | `mv .kanban/todo/x.md .kanban/doing/` |
| Finish card | `mv .kanban/doing/x.md .kanban/done/` |
| Update | `Edit` the file |
| Delete | `rm` the file |

## Display

```
## Todo (2)
- fix-login-bug [high]
- add-dark-mode

## Doing (1)
- refactor-api

## Done (1)
- setup-eslint
```
