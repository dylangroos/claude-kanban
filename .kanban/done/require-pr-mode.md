---
p: medium
---
Merge-without-PR feels too loose when a GitHub origin exists: agent branches land on main via a single un-confirmed click with no review trail (dogfood 2026-07-13). Make the flow PR-first when `git remote get-url origin` succeeds: Open PR is the primary review action and local Merge is gated behind `--require-pr` / `KANBAN_REQUIRE_PR=1` (or at minimum demoted with a confirm dialog — Discard and Open PR confirm today, Merge doesn't). Keep Merge primary for origin-less repos, which have no PR path.
