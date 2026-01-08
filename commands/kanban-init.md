---
description: Initialize a kanban board in the current project
---

Create the kanban board structure:

```bash
mkdir -p .kanban/{todo,doing,done}
mkdir -p hooks
mkdir -p .claude
```

Create the context hook at `hooks/kanban-context.sh`:

```bash
#!/bin/bash
if [ -d ".kanban" ]; then
  todo=$(find .kanban/todo -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  doing=$(find .kanban/doing -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  done=$(find .kanban/done -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  cat <<EOF
<kanban-context>
Kanban board active (todo: $todo, doing: $doing, done: $done)
Commands: /kanban, /kanban add <task>, /kanban done <task>
Agents: task-planner (break down features), standup (status report)
USE THE BOARD when user mentions tasks or work tracking.
</kanban-context>
EOF
fi
```

Make it executable: `chmod +x hooks/kanban-context.sh`

Create `.claude/settings.json` (project-level hooks):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./hooks/kanban-context.sh",
            "timeout": 1000
          }
        ]
      }
    ]
  }
}
```

Confirm to the user:
- Board ready at `.kanban/`
- Hook installed - context auto-injected on every prompt
- Try: "/kanban" to view, "plan out the auth feature" to use task-planner
