---
description: View and manage the kanban board
argument-hint: [add|done|move|work] [task]
---

Args: "$ARGUMENTS"

**No args**: Show board. Glob `.kanban/**/*.md`, read each, display by column.

**add <task>**: Create `.kanban/todo/<task-slug>.md`

**done <task>**: Move to `.kanban/done/`

**move <task> <column>**: Move to that column (todo/doing/done)

**work <feature description>**: Full automation pipeline:
1. Use Task tool to invoke `task-planner` agent - break the feature into kanban cards
2. For each card created in `.kanban/todo/`, spawn a subagent (using Task tool) to implement it
3. As each subagent completes, move its card to `.kanban/done/`
4. Show final board status

Task names can be partial. If no `.kanban/`, say: run `/kanban-init`
