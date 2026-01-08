---
description: Initialize a kanban board in the current project
---

Create the kanban board structure:

```bash
mkdir -p .kanban/{todo,doing,done}
```

Confirm to the user:
- Board ready at `.kanban/`
- The plugin's hook auto-injects context on every prompt
- Try: "/kanban" to view board, "/kanban add <task>" to add cards
