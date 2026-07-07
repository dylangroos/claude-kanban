# Projects — Design Spec

**Date:** 2026-07-06
**Status:** Approved
**Scope:** Project subfolders within one board, agent-driven assignment, badges + filtering in the web UI. A multi-board switcher is a separate future PR.

## Problem

Boards accumulate cards from unrelated streams of work with no way to group them. The user should never have to categorize cards by hand — Claude creates most cards (via the skill, `/kanban add`, `/kanban work`, and the task-planner agent), so Claude should assign projects automatically.

## Data model

A project is a directory inside a column:

```
.kanban/
├── todo/
│   ├── add-dark-mode.md        # no project (column root)
│   └── api/
│       └── fix-login-bug.md    # project "api"
├── doing/
│   └── api/
│       └── refactor-api.md
└── done/
    └── web-ui/
        └── setup-eslint.md
```

Rules:

- **One level deep only.** Directories nested deeper than `<column>/<project>/` are ignored and documented as unsupported.
- **Column root = no project.** Every pre-existing board works unchanged; no migration.
- **Project names are kebab-case slugs**, same rule as card filenames.
- **Card identity is `project/slug`** (bare `slug` for root cards). The same card slug may exist in different projects without conflict.
- **Projects are purely derived** from the directory tree. There is no registry; a project with no cards does not exist. Frontmatter is unchanged (priority only).
- Moving a card between columns keeps its project: `mv .kanban/todo/api/x.md .kanban/doing/api/`.

## Server (`bin/serve.mjs`)

- `getBoard()` reads each column's root files plus one level of subdirectories. Each card gains a `project` field (`null` at root). The `/api/board` response adds a top-level `projects` array (sorted, derived).
- **Composite IDs.** API card IDs become `project/slug` or bare `slug`. The UI URL-encodes IDs (existing behavior), so `api%2Ffix-login-bug` arrives as one path segment; the server decodes and splits on `/` to rebuild the file path. Existing routes are updated; no new endpoints:
  - `GET /api/board` — cards carry `project`; response includes `projects`.
  - `POST /api/cards` `{ title, body?, priority?, column?, project? }` — writes to `.kanban/<col>/<project>/<slug>.md`, creating the project dir on demand (`mkdir -p`).
  - `PUT /api/cards/:id/move` `{ from, to }` — moves between columns, preserving the project encoded in the ID.
  - `PUT /api/cards/:id` `{ body?, priority?, project? }` — a `project` change moves the file between subfolders (or to/from the column root when set/cleared).
  - `DELETE /api/cards/:id` — resolves through the composite path.
- **Cleanup:** after any move or delete, remove now-empty project directories (best-effort, ignore errors).

## Web UI (`ui/index.html`)

- **Badges:** each card with a project shows a small badge. Color comes from hashing the project name into a fixed 8-color palette — stable across reloads, zero config.
- **Filter chips:** header shows `[All]` plus one chip per derived project, and a muted `[none]` chip when unassigned cards coexist with projects. Clicking a chip filters all three columns. Filter state is in-memory only.
- **Add form:** optional project input backed by a `<datalist>` of existing projects.
- **Detail panel:** same project control for reassigning a card (calls `PUT` with `project`).
- **Drag & drop** between columns preserves the project.

## Agent-driven assignment

The core requirement: humans never have to tag cards. Instruction files updated:

- **`skills/kanban/SKILL.md`** — documents the structure; adds the rule: when creating cards, infer the project from context (feature, component, or area under discussion). List existing project folders first and reuse a matching one before inventing a new slug. Leave a card at the column root only when no project fits.
- **`agents/task-planner.md`** — all cards from one feature breakdown go under one project folder named after the feature.
- **`commands/kanban.md`** — `/kanban add` infers the project; `/kanban work` plans into a project folder and reports per project.
- **`agents/standup.md`** — status report grouped by project.
- **`hooks/kanban-context.sh`** — counts are already recursive (`find`); additionally list current project names in the injected context so Claude reuses them.
- **`README.md` / `CLAUDE.md`** — updated structure and operations reference.

## Edge cases

- Duplicate slug across projects, or root vs. project: distinct paths, both valid.
- **Collisions never overwrite and never fail:** if a create, move, or reassign would land on an existing file, the server picks the next free slug (`fix-login-bug` → `fix-login-bug-2`, `-3`, …) and returns the new id; the UI notes the rename in its toast. Reassigns are ordered write-new-then-delete-old, so a mid-operation failure can duplicate a card but never lose one.
- Deleting a project's last card removes it from filters (derived) and its directory (cleanup).
- Manual `git mv` reorganizing works — everything re-derives from the tree.
- Directories nested deeper than one level are ignored, and nested composite ids are rejected. Any non-dot directory name is surfaced as a project as-is; projects created through the API are always slugified to kebab-case.

## Testing & verification

The repo has no test framework; verification is end-to-end, consistent with existing practice:

1. `curl` the API against a fixture board: create card with/without project, move across columns, reassign project, delete, confirm tree and JSON at each step.
2. Drive the UI in a browser: badges render with stable colors, chips filter correctly, add-form datalist works, drag preserves project, empty-dir cleanup happens.
3. Confirm a legacy board (root-only cards) renders and behaves identically to today.

## Out of scope

- Multi-board / cross-repo project switcher (PR 2).
- Project metadata (descriptions, explicit colors, owners) — YAGNI until derived naming proves insufficient.
- Nested project hierarchies.
