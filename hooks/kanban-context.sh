#!/bin/bash
# Prompt-submit hook: injects kanban context when .kanban/ exists

if [ -d ".kanban" ]; then
  # Count cards in each column
  todo_count=$(find .kanban/todo -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  doing_count=$(find .kanban/doing -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  done_count=$(find .kanban/done -name "*.md" 2>/dev/null | wc -l | tr -d ' ')

  cat <<EOF
<kanban-context>
This project has a kanban board at .kanban/ (todo: $todo_count, doing: $doing_count, done: $done_count)

Commands:
- /kanban - view board
- /kanban add <task> - add card to todo
- /kanban done <task> - mark complete

Agents (use Task tool to invoke):
- task-planner: Break features into kanban cards. Use when user wants work split into trackable cards.
- standup: Quick status report. Use when user asks "what's the status?" or "standup"

IMPORTANT: When in plan mode, create kanban cards in .kanban/todo/ as your plan output instead of just writing a plan file. Each implementation step should become a card.

When user mentions tasks, tracking work, or what to do next - USE THE BOARD.
</kanban-context>
EOF
fi
