---
name: kanban-agents
description: Use when the user asks to launch the kanban web UI, dispatch a Claude agent on a card, review/merge/PR agent work, or when dispatch/merge/PR calls fail. Covers driving the web UI's agent-dispatch surface, not board file ops (see the `kanban` skill for view/add/move cards).
---

# Driving kanban's web UI + agent dispatch

`npx dot-kanban` serves a local web UI over the `.kanban/` board. Board resolution: CLI arg > `KANBAN_DIR` env > walk up from cwd looking for `.kanban/`. Server binds `127.0.0.1` only and rejects requests with a mismatched `Host`/`Origin` header — no remote access by design, agents mode included.

## Launching

```
npx dot-kanban                      # walk up from cwd to find .kanban/
npx dot-kanban ~/path/to/project    # point at a specific project (arg > .../.kanban)
npx dot-kanban --agents             # enable agent dispatch (▶ button on todo cards)
```

- `PORT` — server port (default `4040`)
- `NO_OPEN` — set to skip auto-opening the browser
- `KANBAN_AGENTS=1` — same as `--agents`
- `/kanban ui` from Claude Code does the same launch

## Agent dispatch lifecycle

Click ▶ on a **todo** card → card moves to **doing** → `agents.dispatch` creates an isolated git worktree at `$TMPDIR/dot-kanban-agents/<repo>/<flatId>` on branch `kanban/<id>` (`/` in the id becomes `--`) and spawns `claude -p` there with `--permission-mode acceptEdits`. Watch the live log in the session panel (assistant text + `⚙ toolname` lines). States:

- **running** → Stop button.
- **review** (clean exit, commits present) → **View diff**, **Discard**, plus **Open PR** and/or **Merge** per the PR-required rule below. Card stays in **doing**.
- **pr** (after Open PR succeeds) → card stays in **doing** with a link to the PR; **View diff**, **Discard** (drops the local branch; the PR itself is untouched).
- **failed** / **interrupted** (server restarted mid-run) → **Retry** (redispatches from the current card body) or **Discard** (returns card to **todo**).

Discard (from **review**/**pr**/**failed**/**interrupted**) returns the card to **todo** and deletes the branch+worktree. Merge (on success) moves the card **doing → done**.

## Review policy (PR-required by default)

- Repo **has** an `origin` remote: PR is required by default — only **Open PR** shows, and a direct `merge` call 409s server-side too as a backstop.
- `--allow-merge` (or `KANBAN_REQUIRE_PR=0`) restores **Merge** alongside **Open PR** even with an origin.
- `--require-pr` (or `KANBAN_REQUIRE_PR=1`) forces the PR-only gate even in an origin-less repo.
- Repo has **no** origin and neither flag is set: only **Merge** is offered (Open PR would just 409 on the missing remote).

Open PR pushes `<branch>:<branch>` to `origin`, then runs `gh pr create --head <branch> --base <current-HEAD-branch> --title <slug> --body <agent summary>` — needs `gh` installed and authed, an `origin` remote, and a non-detached HEAD as base.

## Env knobs

| Var | Default | Notes |
|---|---|---|
| `KANBAN_MAX_AGENTS` | `3` | concurrent running-session cap |
| `KANBAN_AGENT_TOOLS` | `Bash(git *),Bash(npm test*),Bash(npm run *)` | passed as `--allowedTools`; **the real security boundary** — a dispatched worker can run anything it matches, widen deliberately |
| `KANBAN_CLAUDE_BIN` | `claude` | binary used to spawn the worker |
| `KANBAN_GH_BIN` | `gh` | binary used by Open PR |
| `KANBAN_REQUIRE_PR` | unset | `1` forces PR-only gate, `0` forces local Merge back on |
| `KANBAN_DIR` | — | explicit board path, overrides cwd walk-up (CLI arg still wins) |
| `PORT` | `4040` | server port |
| `NO_OPEN` | unset | set to skip auto-open |

Session metadata lives in `.kanban/.agents/*.json` — gitignore it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Open PR fails, error tail contains `no origin remote` | `git remote add origin <url>` |
| Open PR fails with a `gh` auth error | `gh auth login`, verify `gh auth status` |
| Merge returns 409 `local merge disabled by require-pr; use Open PR` | expected under the PR-required gate — use Open PR, or relaunch with `--allow-merge` |
| Dispatch returns 409 with message `agent limit (3) reached` | wait for a running session to finish, or raise `KANBAN_MAX_AGENTS` |
| Dispatch/retry returns 409 `session already <status>` | a session already exists for that card id; Discard it first, or wait it out |
| Merge conflict: error tail ends `; branch preserved: kanban/<id>` | merge was aborted, worktree/branch kept — resolve manually or Discard |
| Card shows "Server restarted mid-session. Take over: `claude --resume <sessionId>`" | status is `interrupted` (server died while it was running) — resume the session directly with that command, or click Retry to redispatch fresh |
| Worker aborts a command mid-run | it hit something outside `KANBAN_AGENT_TOOLS` — the run fails fast rather than prompting; widen the allowlist and Retry |

For card CRUD and board layout (columns, projects, frontmatter), see the `kanban` skill — this one only covers the web UI and dispatch surface.
