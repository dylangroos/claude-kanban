---
description: View and manage the kanban board
argument-hint: [add|done|move] [task]
---

Args: "$ARGUMENTS"

**No args**: Show board. Glob `.kanban/**/*.md`, read each, display by column.

**add <task>**: Create `.kanban/todo/<task-slug>.md`

**done <task>**: Move to `.kanban/done/`

**move <task> <column>**: Move to that column (todo/doing/done)

Task names can be partial. If no `.kanban/`, say: run `/kanban-init`
