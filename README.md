# Claude Kanban

Filesystem-based kanban board for Claude Code. No servers, no databases, just folders and markdown files.

```
.kanban/
├── todo/           auth/fix-login-bug.md
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

## Projects

Group cards by dropping them in a subfolder — the folder name is the project:

```
.kanban/todo/auth/add-login-form.md   ← project "auth"
.kanban/todo/quick-fix.md             ← no project
```

Claude assigns projects automatically when it creates cards (it reuses existing folders or infers a slug from the feature). In the web UI, projects show as colored badges with filter chips in the header.

## Agents

### Dispatch work to Claude

Enable with `npx dot-kanban --agents` (or `KANBAN_AGENTS=1`). A ▶ button appears on each card in the web UI — click it to dispatch that card to a Claude Code session.

Each dispatch runs in an isolated git worktree on its own branch — `kanban/<card-id>`, with `/` in the id replaced by `--` (e.g. `kanban/api--do-thing`) — so your checkout is untouched while the agent works. Watch it live in the session panel, then when it finishes:
- **Review** the summary and full diff on the card (**View diff**)
- **Open PR** to push the branch to `origin` and open a GitHub PR from the card title and agent summary — needs the [`gh` CLI](https://cli.github.com) installed and authed (`gh auth status`), an `origin` remote, and a checked-out branch as base (detached HEAD is rejected). The card stays in doing with a link to the PR; discard it later to drop the local branch
- **Merge** to merge the branch into your checkout (a merge commit, `--no-ff`) and clean up the worktree — asks for confirmation first
- **Discard** to drop the branch and return the card to todo

When an `origin` remote is configured, PR is required by default: Open PR is the only action shown, and local merges 409 server-side too, as a backstop. Pass `--allow-merge` (or `KANBAN_REQUIRE_PR=0`) to restore local Merge alongside Open PR. Repos with no `origin` are unaffected — only Merge is offered, since Open PR would just 409. `--require-pr` (or `KANBAN_REQUIRE_PR=1`) forces the PR-only gate even without an `origin`.

Env knobs:
- `KANBAN_MAX_AGENTS` - concurrent session cap (default 3)
- `KANBAN_AGENT_TOOLS` - allowed tools passed to the agent (default `Bash(git *),Bash(npm test*),Bash(npm run *)`)
  The allowlist is your real safety boundary — a dispatched worker can run anything it matches, so widen it deliberately.
- `KANBAN_CLAUDE_BIN` - path to the `claude` binary (default `claude`)
- `KANBAN_GH_BIN` - path to the `gh` binary used by Open PR (default `gh`)
- `KANBAN_REQUIRE_PR` - set to `1` to force the PR-only gate (same as `--require-pr`), or `0` to force local Merge back on even with an `origin` (same as `--allow-merge`)

If the agent tries a command outside `KANBAN_AGENT_TOOLS`, the session fails fast rather than prompting — widen the allowlist and retry. Session metadata lives in `.kanban/.agents/`; add it to `.gitignore`. The server only binds `127.0.0.1`, agents mode included.

### Claude Code agents

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
