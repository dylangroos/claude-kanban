---
name: kanban
description: Manage tasks using .kanban/ folders. Use when user mentions tasks, cards, board, todo, doing, done, or tracking work.
---

# Kanban Board

Tasks live in `.kanban/` as markdown files in column folders. Cards can be grouped into **projects** — subfolders inside each column.

## Structure

```
.kanban/
├── todo/                # To do
│   ├── quick-fix.md         ← no project
│   └── auth/                ← project "auth"
│       └── add-login-form.md
├── doing/               # In progress
│   └── auth/
│       └── setup-jwt.md
└── done/                # Complete
```

Projects are just directories — one level deep, kebab-case. A card at the column root has no project.

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

**With dependencies** (`add-logout.md`):
```
---
needs: [auth/setup-jwt, add-login-form]
---
Implement logout and token invalidation.
```

`needs:` lists ids of prerequisite cards — `project/slug` for a card in a project folder, bare `slug` for one at the column root. A card is blocked (no agent dispatch) until every listed card is in `done/`.

## Projects — assign them yourself

The user should never have to categorize cards by hand. When creating cards:

1. `ls .kanban/todo .kanban/doing .kanban/done` to see existing project folders — reuse one if it fits.
2. Otherwise infer a short kebab-case project slug from the feature, component, or area being discussed (e.g. work on the login flow → `auth`).
3. Write the card into `.kanban/todo/<project>/<slug>.md` (`mkdir -p` the folder).
4. Only leave a card at the column root when no project genuinely fits.

Cards from one feature or planning session share one project. Keep a card's project folder when moving it between columns.

## Operations

| Do this | How |
|---------|-----|
| View board | `Glob .kanban/**/*.md` then `Read` each |
| Add card | `Write` to `.kanban/todo/<project>/<slug>.md` (or column root if no project) |
| Move card | `mkdir -p .kanban/doing/<project> && mv .kanban/todo/<project>/x.md .kanban/doing/<project>/` |
| Finish card | `mv .kanban/doing/<project>/x.md .kanban/done/<project>/` (create dir first) |
| Reassign project | `mv` between subfolders of the same column |
| Update | `Edit` the file |
| Delete | `rm` the file (then `rmdir` its project folder if empty) |

## Display

Group by project within each column:

```
## Todo (3)
auth:
- add-login-form [high]
- setup-jwt
(no project)
- quick-fix

## Doing (1)
auth:
- add-protected-routes

## Done (0)
```
