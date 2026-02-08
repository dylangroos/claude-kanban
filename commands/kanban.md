---
description: View and manage the kanban board
argument-hint: [add|done|move|work|ui] [task]
---

Args: "$ARGUMENTS"

**No args**: Show board. Glob `.kanban/**/*.md`, read each, display by column.

**add <task>**: Create `.kanban/todo/<task-slug>.md`

**done <task>**: Move to `.kanban/done/`

**move <task> <column>**: Move to that column (todo/doing/done)

**ui**: Launch the web UI. Use the Bash tool with `run_in_background: true` to run:
```
node $CLAUDE_PLUGIN_ROOT/bin/serve.mjs
```
This starts a local server at http://localhost:4040 (or $PORT) that auto-opens the browser. Tell the user the board is live and they can manage cards visually. The server runs in the background — changes sync both ways with the .kanban/ folder every 3 seconds.

**work <feature description>**: Full automation pipeline:
1. Use Task tool to invoke `task-planner` agent - break the feature into kanban cards
2. For each card created in `.kanban/todo/`, spawn a subagent (using Task tool) to implement it
3. As each subagent completes, move its card to `.kanban/done/`
4. Show final board status

Task names can be partial. If no `.kanban/`, say: run `/kanban-init`
