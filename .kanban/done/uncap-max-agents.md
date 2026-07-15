---
p: medium
---
Support unlimited agent concurrency (Dylan: "no cap on this"). In bin/agents.mjs, `KANBAN_MAX_AGENTS=0` means no limit: the dispatch guard `running >= MAX` must not fire when MAX is 0 (treat 0 as Infinity when parsing). Nonzero values behave exactly as today; default stays 3. Document the 0 value in README's env-knob table and in skills/kanban-agents/SKILL.md's KANBAN_MAX_AGENTS row. Add an e2e block in test/agents-e2e.sh: start with KANBAN_MAX_AGENTS=0 and FAKE_CLAUDE_SLEEP=5, dispatch 4+ cards, assert all reach running simultaneously (no 409 "agent limit"); keep every existing test green via npm run test:agents.
