---
p: high
---
Model card dependencies first-class. A card may declare `needs: [id, ...]` in its YAML frontmatter (ids are `project/slug` or bare `slug`, matching existing card ids). Changes:

1. bin/serve.mjs — parse `needs` from frontmatter in readCard() (comma/bracket list → array); each card in /api/board gains `needs` and computed `blocked: true` when any needed id is not present in the done column. The /api/cards/:id/work route returns 409 `{error: "blocked by <id>"}` naming the first unmet dep (server-side backstop).
2. ui/index.html — blocked cards render a small chip (e.g. `⛓ needs <n>`) and their ▶ dispatch button is not shown (or disabled with a title tooltip naming the deps); everything else unchanged.
3. skills/kanban/SKILL.md card-format section + agents/task-planner.md — document `needs:` and instruct planners to emit it when breaking a feature into ordered cards.
4. test/agents-e2e.sh — new block: card A with `needs: [B]` where B is in todo → work returns 409 mentioning B; move B to done (mv the file) → work on A succeeds. Keep every existing test green; verify with `npm run test:agents` (takes ~60s).

Match the existing terse code style; no new dependencies. Cards without `needs` behave exactly as today.
