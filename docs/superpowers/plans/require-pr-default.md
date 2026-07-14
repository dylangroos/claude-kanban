# Require-PR by Default

## Context

PR #8 added the `--require-pr` gate as opt-in. Decision (Dylan, 2026-07-14): PR-required should be the **default at startup** whenever the repo has an `origin` — local merge becomes the thing you opt into, not out of. Origin-less repos keep local merge (their only landing path). This is a pure policy-resolution change: the UI already renders entirely from the board's `requirePr` field and needs no edits.

## Global constraints

- Three-state resolution, evaluated **per request** (origin is already probed live):
  - force-on: `--require-pr` CLI flag OR `KANBAN_REQUIRE_PR=1` (unchanged spelling)
  - force-off: new `--allow-merge` CLI flag OR `KANBAN_REQUIRE_PR=0`
  - neither: gate iff `agents.hasOrigin()` is true
  - force-on wins over force-off if a user passes both.
- The merge route and the board's `requirePr` field must use the SAME resolution — no state where the UI hides Merge but the route allows it, or vice versa.
- Gated merge keeps the exact 409 error from #8 (contains "require-pr" and "Open PR").
- Flag-off (`--agents` absent) responses stay byte-identical; no changes to `ui/index.html`, `openPr`, `discard`, `diff`, or card moves.

## Task 1 — resolution change, e2e, docs

**`bin/serve.mjs`:**
- Line 17: replace the single `REQUIRE_PR` const with `const REQUIRE_PR_ON = args.includes("--require-pr") || process.env.KANBAN_REQUIRE_PR === "1";` and `const ALLOW_MERGE = args.includes("--allow-merge") || process.env.KANBAN_REQUIRE_PR === "0";`
- Add one helper next to them: `const requirePr = async () => REQUIRE_PR_ON || (!ALLOW_MERGE && await agents.hasOrigin());` (only ever called when `agents` exists).
- Line 184: `b.requirePr = await requirePr();` — reuse `b.hasOrigin` if that reads cleaner (`b.requirePr = REQUIRE_PR_ON || (!ALLOW_MERGE && b.hasOrigin)`), but the merge route must call the same helper.
- Line 304: `if (await requirePr()) return json(...409...)` — error text unchanged.

**`test/agents-e2e.sh`:** the fixture repo HAS an origin, so the default now gates merges. Update:
- Happy-path block (line 42) and merge-conflict block: start with `AGENTS_FLAG="--agents --allow-merge"` so local-merge mechanics stay covered, and change the line-48 assert to `b.requirePr === false` under `--allow-merge` (rename the label accordingly).
- In the happy-path area add one default-on probe: before the `--allow-merge` runs, do a plain `AGENTS_FLAG=--agents start`, assert `b.requirePr === true` (origin present → gated by default) and that a merge attempt on a fresh review session 409s; then `stop_srv`. Cheapest shape: fold this into the existing require-pr-gate block instead by dropping its `--require-pr` flag — the gate block then proves the DEFAULT gate; add a small separate board-only check that `--require-pr` still forces on. Implementer's choice; every behavior below must end up pinned:
  1. origin + no flags → `requirePr === true`, merge 409s with the #8 message, PR path still 200
  2. origin + `--allow-merge` → `requirePr === false`, local merge succeeds
  3. origin + `KANBAN_REQUIRE_PR=0` → `requirePr === false` (board check only)
  4. no origin + no flags → `requirePr === false` (extend the existing no-origin block at line 135)
  5. `--require-pr` and `KANBAN_REQUIRE_PR=1` still force on (existing env block stays)
  6. flag-off: no `requirePr` key (existing line 71 stays)
- Suite ends PASS via `npm run test:agents`.

**Docs:** README agents section + CLAUDE.md: PR-required is the default when an origin exists; `--allow-merge` / `KANBAN_REQUIRE_PR=0` restores local Merge; origin-less repos are unaffected. Adjust the #8 wording that presented `--require-pr` as opt-in.

## Verification

`npm run test:agents` PASS; live check on the dogfood board (has origin): review strip shows Open PR only by default, Merge returns after restarting with `--allow-merge`.

## Execution

Single-task SDD (implementer + task review, review doubles as whole-branch since it is the branch), then PR. Target v1.6.0.
