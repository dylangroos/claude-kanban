# PR-First Review + `--require-pr` Mode

## Context

Dogfooding v1.4.0 surfaced a review-gate hole: **Merge** is a one-click, no-confirm write into the user's checkout (Discard and Open PR both confirm; Merge doesn't), and it leaves no review trail. Decision with the user: when the repo has a GitHub-style `origin`, the flow should be **PR-first** — Open PR is the primary action — and a hard gate (`--require-pr` / `KANBAN_REQUIRE_PR=1`) can disable local Merge entirely. Origin-less repos (scratch projects) keep Merge primary since they have no PR path. Merge always gets a confirm dialog.

No new dependencies. Everything stays behind the existing `--agents` gate and Origin/Host guard.

## Global constraints

- Flag spelling: `--require-pr` CLI flag OR `KANBAN_REQUIRE_PR=1` env, parsed exactly like `--agents`/`KANBAN_AGENTS` at `bin/serve.mjs:16`.
- Board payload fields (`hasOrigin`, `requirePr`) are added **only when agents are enabled** (inside the existing `if (agents)` at `bin/serve.mjs:180`), so flag-off responses stay byte-identical.
- Gated merge returns **409** with an error message that names both the gate and the alternative (contains "require-pr" and "Open PR").
- No behavior change to `openPr`, `discard`, `diff`, or the card-move logic.

## Task 1 — backend: origin detection, flag, merge gate, e2e

**`bin/agents.mjs`:**
- Add manager method `hasOrigin()`: `try { await git(["remote", "get-url", "origin"]); return true; } catch { return false; }`. Add `hasOrigin` to the returned object (line 263).

**`bin/serve.mjs`:**
- Line 16, alongside `AGENTS`: `const REQUIRE_PR = args.includes("--require-pr") || process.env.KANBAN_REQUIRE_PR === "1";`
- Board handler (line 180): inside the existing `if (agents)` block also set `b.hasOrigin = await agents.hasOrigin(); b.requirePr = REQUIRE_PR;` (live per request — adding/removing origin mid-session updates the UI on the next poll).
- Merge action (line 298): before `agents.merge(id)`, `if (REQUIRE_PR) return json(res, { error: "local merge disabled by require-pr; use Open PR" }, 409);`

**`test/agents-e2e.sh`:**
- In the existing happy-path block: assert `b.hasOrigin === true` and `b.requirePr === false` on `/api/board`.
- In the existing no-origin block (remote removed): assert `b.hasOrigin === false`.
- In the flag-off regression block: assert `'requirePr' in b` is `false`.
- New block "require-pr gate": start with `AGENTS_FLAG="--agents --require-pr"` (the `start` helper expands `$AGENTS_FLAG` unquoted, so two words work), dispatch a fresh card to review, assert `b.requirePr === true`, POST merge → **409** with error matching `require-pr`, session still `review`, card still in doing; then POST pr → **200** (PR path unaffected); discard to clean up. Also verify the env spelling once: a `KANBAN_REQUIRE_PR=1 --agents` start whose board reports `requirePr === true` (board check only, no dispatch).
- Suite must end PASS via `npm run test:agents`.

## Task 2 — UI: PR-first ordering + Merge confirm, docs

**`ui/index.html`:**
- `sconf` (line 298): add `merge:'Merge this branch into your local checkout?'` so Merge confirms like Discard/Open PR.
- `renderSess()` review strip (line 336) — replace the `if(s.commits)` button pair with origin-aware ordering:
  - `B.requirePr` → Open PR only (styled `ok`), no Merge button.
  - else `B.hasOrigin` → Open PR first (styled `ok`), then Merge (plain, no `ok`).
  - else (no origin) → Merge only (styled `ok`); hide Open PR since it can only 409.
  - View diff + Discard unchanged in all cases.
- No other state strips change.

**Docs:**
- `README.md` agents section: document PR-first ordering when an origin exists, the Merge confirm, and `--require-pr` / `KANBAN_REQUIRE_PR=1`.
- `CLAUDE.md` project overview: one sentence on the require-pr gate.

## Verification

- `npm run test:agents` → PASS (covers gate 409, PR-path-still-works, hasOrigin true/false, flag-off byte-compat).
- UI logic is exercised manually on the running dogfood board (localhost:4141) after merge: review strip shows Open PR primary + Merge secondary (origin exists), Merge prompts confirm; restart with `--require-pr` → Merge button gone.

## Risks

- `hasOrigin` runs a git exec per board poll (~every 2s): `git remote get-url` reads `.git/config`, single-digit ms; acceptable, and keeps the UI live when origin changes.
- `--require-pr` with no origin strands the card in review by design: Open PR surfaces the existing "no origin" 409 — a misconfiguration made visible, not silently worked around.

## Execution

Same pipeline as PRs #5–#7: subagent-driven-development, one implementer + task review per task, final whole-branch review, PR. Target v1.5.0.
