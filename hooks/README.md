# Kanban Hooks

## Two Installation Scenarios

### 1. Plugin Installation (recommended)

Install via marketplace:
```bash
claude plugin marketplace add <marketplace-name>
claude plugin install kanban
```

The plugin's `hooks/hooks.json` is automatically loaded. Uses `${CLAUDE_PLUGIN_ROOT}` for portable paths.

### 2. Project-level Setup (standalone)

Run `/kanban-init` to set up a kanban board in any project. This creates:
- `.kanban/` folder structure
- `hooks/kanban-context.sh` script
- `.claude/settings.json` with project-level hooks

## What the Hook Does

On every prompt (`UserPromptSubmit`), the hook:

1. Checks if `.kanban/` exists
2. Counts cards in each column
3. Outputs context that Claude sees:

```
<kanban-context>
Kanban board active (todo: 2, doing: 1, done: 1)
Commands: /kanban, /kanban add <task>, /kanban done <task>
Agents: task-planner (break down features), standup (status report)
USE THE BOARD when user mentions tasks or work tracking.
</kanban-context>
```

This makes the kanban board "salient" - Claude will use it when you mention tasks.

## Test the Hook

```bash
./hooks/kanban-context.sh
```

## Hook Configuration Formats

**Plugin hooks** (`hooks/hooks.json`):
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/hooks/kanban-context.sh"
      }]
    }]
  }
}
```

**Project hooks** (`.claude/settings.json`):
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "./hooks/kanban-context.sh"
      }]
    }]
  }
}
```
