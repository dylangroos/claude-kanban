# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Claude Code plugin that provides a filesystem-based kanban board. Tasks are stored as markdown files in folder columns (`.kanban/todo/`, `.kanban/doing/`, `.kanban/done/`). No servers or databases required.

## Repository Structure

```
.claude-plugin/plugin.json   # Plugin metadata
skills/kanban/SKILL.md       # Main skill definition (triggers on task/board keywords)
commands/kanban.md           # /kanban command handler
commands/kanban-init.md      # /kanban-init command handler
agents/task-planner.md       # Agent for breaking down large tasks into cards
agents/standup.md            # Agent for daily standup summaries
.kanban/                     # Example kanban board structure
```

## Plugin Architecture

- **Skills** (`skills/*/SKILL.md`): Triggered by natural language patterns. The kanban skill activates when users mention tasks, cards, board, todo, doing, done, or tracking work.
- **Commands** (`commands/*.md`): Slash commands like `/kanban` and `/kanban-init`.
- **Agents** (`agents/*.md`): Specialized agents for complex workflows (task planning, standups).

## Card Format

Cards are markdown files where filename = task title (kebab-case). Optional YAML frontmatter for priority:

```markdown
---
p: high
---
Task description here.
```

## Operations Reference

| Action | Implementation |
|--------|----------------|
| View board | `Glob .kanban/**/*.md` then `Read` each |
| Add card | `Write` to `.kanban/todo/<slug>.md` |
| Move card | `mv .kanban/<from>/x.md .kanban/<to>/` |
| Update card | `Edit` the file |
| Delete card | `rm` the file |
