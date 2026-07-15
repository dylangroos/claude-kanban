---
p: high
---
Make interrupted/failed sessions recoverable in place (Dylan, 2026-07-14: "tough when I can't resume one that's been interrupted or restart it"). Two changes in bin/agents.mjs + bin/serve.mjs + ui/index.html:

1. **Resume**: for `interrupted` sessions whose worktree still exists and which have a `sessionId`, add a Resume button (`POST /api/sessions/:id/resume`) that re-spawns the worker in the SAME worktree/branch with `claude -p --resume <sessionId>` and a short continuation prompt ("you were interrupted; review your worktree state, finish the card, commit"). Falls back to 409 with a clear error when the worktree or sessionId is gone (UI then only offers Retry).
2. **Retry from anywhere**: the retry route currently 404s "card not in doing" if the card was dragged elsewhere; make retry locate the card in any column (todo/doing/done), move it to doing, and dispatch. Same for the UI's Retry button visibility.

e2e in test/agents-e2e.sh: fake-claude honors --resume passthrough (extend the shim: when args contain --resume, append "resumed" to fake-work.txt and exit 0); block asserting resume produces a review session reusing the same branch, and retry succeeding on a card sitting in todo with a stale interrupted session. Keep every existing test green via npm run test:agents (~60s).
