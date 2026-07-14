---
p: high
---
Make require-pr the startup default when the repo has an origin (Dylan, 2026-07-14: "we should also require PR on startup"). Three-state resolution: `--require-pr`/`KANBAN_REQUIRE_PR=1` forces on, new `--allow-merge`/`KANBAN_REQUIRE_PR=0` forces off, neither → gate iff origin exists (probed live). UI needs no changes (consumes board `requirePr`). Update e2e blocks that merge locally to opt out, add default-on/default-off asserts, docs.
