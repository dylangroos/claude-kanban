---
description: View and manage the kanban board
argument-hint: [add|done|move|work|ui] [task]
---

Args: "$ARGUMENTS"

**No args**: Show board. Glob `.kanban/**/*.md`, read each, display by column.

**add <task>**: Create the card in todo. Infer the project from context (see the kanban skill's project rules): reuse an existing project folder if one fits, else create `.kanban/todo/<project>/<task-slug>.md`; use the column root only if no project fits.

**done <task>**: Move to `.kanban/done/`, keeping its project subfolder (create it under done/ first).

**move <task> <column>**: Move to that column (todo/doing/done), keeping its project subfolder.

**ui**: Launch the web UI. Use the Bash tool with `run_in_background: true` to run:
```
node $CLAUDE_PLUGIN_ROOT/bin/serve.mjs
```
This starts a local server at http://localhost:4040 (or $PORT) that auto-opens the browser. Tell the user the board is live and they can manage cards visually. The server runs in the background — changes sync both ways with the .kanban/ folder every 3 seconds.

If the user asks for agents (dispatching cards to Claude Code sessions from the board), add the `--agents` flag:
```
node $CLAUDE_PLUGIN_ROOT/bin/serve.mjs --agents
```
This adds a ▶ button per card that runs it in an isolated worktree; without the flag those routes are gated off.

**work <feature description>**: Full automation pipeline:
1. Use Task tool to invoke `task-planner` agent - break the feature into kanban cards under one project folder named after the feature
2. For each card created in `.kanban/todo/<project>/`, spawn a subagent (using Task tool) to implement it
3. As each subagent completes, move its card to `.kanban/done/`
4. Show final board status, grouped by project

Task names can be partial. If no `.kanban/`, say: run `/kanban-init`
