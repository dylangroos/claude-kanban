# Agent Dispatch — Design Spec

**Date:** 2026-07-06
**Status:** Approved
**Scope:** The web UI can spawn, watch, and manage headless Claude Code sessions that work cards ("Claude Kanban" — a multiplexer for Claude sessions). Gated behind an opt-in startup flag; the default server is unchanged.

## Problem

The board records work but doesn't perform it. The user wants board actions to launch Claude Code sessions: click a button on a card → an agent works that card in the repo, visibly, alongside other running sessions — with the board as the dashboard for all of them.

## Opt-in startup flag

The entire feature is off by default. Enable with `npx dot-kanban --agents` (any argv position; board path argument still works) or `KANBAN_AGENTS=1`. When disabled: agent endpoints are not registered (404), the board payload carries `agents: false`, and the UI renders no agent controls — byte-for-byte today's behavior. `/kanban ui` docs mention the flag.

Independent of the flag (applies always): the server binds `127.0.0.1` instead of all interfaces, and the wildcard CORS header is dropped. **The request handler also rejects any request whose `Host` header is not `localhost`/`127.0.0.1` (+ the server port) and any request carrying a non-localhost `Origin`** — loopback binding alone does not stop a drive-by web page from issuing simple cross-site POSTs, and the agent routes turn that into code execution, so an Origin/Host guard is required, not optional. This also defeats DNS-rebinding. Endpoints that spawn processes and run merges must never be reachable cross-origin; the plain board gets the same hardening for free.

## Card lifecycle

```
todo ──▶ Work ──> doing[running] ──> doing[review] ──Merge──> done
                       │                  │
                       │ stop/error       └─Discard──> todo (branch deleted)
                       ▼
                  doing[failed]  ──Retry──> doing[running]
                  doing[interrupted] (server restarted; resume hint)
```

- Columns stay the source of truth for todo/doing/done; the sub-states (running/review/failed/interrupted) come from the session registry.
- **Review** is the default hand-back: the worker's branch waits for a human Merge/Discard in the UI. A card reaches `done/` only via a successful merge (or the normal manual/agent move — non-dispatched flows are untouched).

## Session state

- **Live state** (process handle, buffered log) is in server memory.
- **Durable state** is one JSON file per dispatched card: `.kanban/.agents/<flat-id>.json` — `{ id, sessionId, branch, worktree, base, status, startedAt, endedAt, cost, summary, error, commits, diffstat }`. Dot-directories are already invisible to `getBoard()` and the context hook (shipped in v1.2.0), so this nests inside the existing structure without touching board semantics. README recommends adding `.kanban/.agents/` to `.gitignore`.
- On server restart, a card in `doing/` with an agents file whose status was `running` but no live process is reported as **interrupted**, and the UI shows the exact take-over command: `claude --resume <sessionId>`.

## The worker contract

Spawn per card (Node `child_process.spawn`, zero new dependencies), with `cwd` set to a **server-created worktree** — `git worktree add -b kanban/<flat-id> <os-tmpdir>/dot-kanban-agents/<repo>/<flat-id>` — rather than `claude --worktree` (deterministic branch names, version-independent, and testable with a fake-claude shim that can't create worktrees itself):

```
claude -p "<card title>\n\n<card body>" \
  --output-format stream-json --verbose \
  --permission-mode acceptEdits \
  --allowedTools "Bash(git *),Bash(npm test*),Bash(npm run *)" \
  --append-system-prompt "<dispatch briefing>"
```

Log granularity is whole assistant messages plus tool-call names (no `--include-partial-messages` — partial deltas would duplicate message text in the log for no real liveness gain).

- **Dispatch briefing** (injected system prompt): tells the session it was dispatched from the kanban board; which card, project, and board it serves; that it runs in an isolated git worktree on its own branch while the user's checkout stays untouched; to commit as it goes and never push; that a denied permission aborts the run; and that its final message becomes the card's review summary shown to the user.
- **Isolation:** each session gets its own server-managed worktree and branch; concurrent workers cannot collide with each other or with the user's tree. The flat id is the card id with `/` flattened to `--` (`api--fix-login-bug`); branch = `kanban/<flat-id>`, worktree = `<os-tmpdir>/dot-kanban-agents/<repo>/<flat-id>`, metadata filename = `<flat-id>.json`. The dispatch records the base commit (`HEAD` at spawn) for diffstat and no-changes detection.
- **Allowlist:** default covers file edits (acceptEdits) plus git/test/run commands; overridable via `KANBAN_AGENT_TOOLS` (passed through as the `--allowedTools` value). A tool call outside the list makes the run abort fast (headless behavior) → card shows **failed** with the denial reason; the user can Retry or take over via resume. Accepted trade-off: some cards won't complete unattended.
- **Concurrency cap:** default 3 simultaneous workers (`KANBAN_MAX_AGENTS`); dispatch beyond the cap is rejected with a clear error toast (no queue — YAGNI).
- **Stream parsing:** the server reduces stream-json events to a compact human log (assistant text deltas + tool-call one-liners). The terminal `result` event supplies `session_id`, `total_cost_usd`, and the result text (used as the review summary).

## Server

- A session-manager module: registry keyed by card id, spawn/stop/cleanup, stream parsing, metadata persistence. Lives in `bin/serve.mjs` if it stays small; splits to `bin/agents.mjs` if it outgrows ~150 lines.
- New endpoints (registered only with `--agents`):
  - `POST /api/cards/:id/work` — validates the card is in `todo`, moves it to `doing/` (keeping its project), writes the metadata file, spawns the worker.
  - `POST /api/sessions/:id/stop` — kills the process; status `failed` (reason: stopped).
  - `POST /api/sessions/:id/merge` — runs `git merge --no-ff <branch>` in the user's checkout. On conflict: `git merge --abort`, status stays `review`, error surfaced ("conflicts — resolve manually; branch preserved"). On success: card moves to `done/`, worktree removed, branch deleted, metadata updated.
  - `POST /api/sessions/:id/discard` — worktree removed (`--force`), branch deleted, card moves back to `todo/`, metadata deleted.
  - `POST /api/sessions/:id/retry` — failed/interrupted card only: cleans up remnants, dispatches fresh.
  - `GET /api/sessions/:id/log` — the buffered human log (tail; fetched only while the panel is open).
- `GET /api/board` gains `agents: <bool>` and, when enabled, a `sessions` map `{cardId: {status, cost, branch, summary?, error?, sessionId?}}` — the existing 3-second poll drives all status rendering.
- Card ids in these routes are the composite `project/slug` ids from v1.2.0.

## Web UI

- Todo cards get a **▶** action (visible only when `agents: true`).
- Running: pulsing indicator on the card; panel shows a live log tail (polled ~2s while open) and a **Stop** button.
- Review: card shows a "review" tag; panel shows the worker summary (markdown), diffstat, cost, and **Merge** / **Discard** buttons.
- Failed/interrupted: error message or `claude --resume <id>` hint, plus **Retry**.
- All rendered with the existing panel/toast/badge patterns; project names and all session-derived text pass through `esc()` like every other sink.

## Edge cases

- Graceful server shutdown (SIGINT/SIGTERM) kills live worker children via an `agents.shutdown()` handler, so `Ctrl-C` leaves no orphans. On a hard crash (`kill -9`), a child can outlive the server; on next start `init()` marks such sessions **interrupted** (the metadata's `running` status with no live process), and the UI offers the `claude --resume <sessionId>` take-over. The rendered worker summary allows only `http(s):`/relative links (no `javascript:` sink), since the summary is LLM-authored from untrusted card text.
- Dispatching a card that already has a session file: rejected unless status is failed/interrupted (Retry path).
- Card renamed/moved manually while a session runs: the session finishes against its worktree; merge still works via the API (branch is independent of the card file). The metadata stays keyed by the original id — the UI simply stops showing a chip for it (no card carries that id anymore); it remains visible in `.kanban/.agents/` and manageable via the session endpoints or plain `git worktree remove` + `git branch -D`. Accepted as-is: renaming a card mid-session is an unusual, deliberate act.
- Worker makes no commits: review state shows "no changes"; only Discard is offered.
- `claude` binary missing or too old for a flag: dispatch fails fast with the stderr line in the card's error.
- The board's own repo (`.kanban` committed): worktrees live under the OS temp dir (`<os-tmpdir>/dot-kanban-agents/<repo>/<flat-id>`), outside the repo entirely; branches are `kanban/<flat-id>` — the board reader only globs `.kanban/`, so neither is ever surfaced as a card.

## Verification

- A fake `claude` shim (a small script placed first on `PATH` for the test server) emits scripted stream-json, creates a commit in the assigned worktree, and exits — making spawn → live log → review → merge/discard deterministically testable end-to-end via curl against a `git init` fixture repo, without tokens.
- One manual real-`claude` pass on a trivial card before the PR.
- Regression: with the flag off, the API surface and UI are byte-identical to v1.2.0 (fixture assertions on the board payload and served HTML).

## Out of scope

- Queueing beyond the concurrency cap; scheduling.
- Multi-board dispatch (multi-board switcher remains shelved).
- Auto-merge, PR creation, or pushing anywhere.
- Embedded interactive terminal in the browser (take-over happens in the user's own terminal via `--resume`).

## Version

1.3.0.
