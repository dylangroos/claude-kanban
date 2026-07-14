# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Claude Code plugin that provides a filesystem-based kanban board. Tasks are stored as markdown files in folder columns (`.kanban/todo/`, `.kanban/doing/`, `.kanban/done/`). No servers or databases required.

The web UI (`bin/serve.mjs`) can optionally dispatch cards to Claude Code sessions: `bin/agents.mjs` manages these behind the `--agents` flag, running each session in its own git worktree/branch and tracking state as JSON in `.kanban/.agents/`. Finished sessions can be merged locally or pushed as a GitHub PR (requires an authed `gh` CLI; `KANBAN_GH_BIN` overrides the binary); `--require-pr` (or `KANBAN_REQUIRE_PR=1`) disables local merges and forces every session through a PR.

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

Cards can be grouped into **projects** — one-level subfolders inside a column (`.kanban/todo/<project>/<slug>.md`). A card at a column's root has no project. Claude infers and assigns projects automatically when creating cards, reusing an existing project folder when one fits and only inventing a new slug when none does.

## Operations Reference

| Action | Implementation |
|--------|----------------|
| View board | `Glob .kanban/**/*.md` then `Read` each |
| Add card | `Write` to `.kanban/todo/<project>/<slug>.md` (column root if no project) |
| Move card | `mv .kanban/<from>/x.md .kanban/<to>/`, keeping the project subfolder |
| Update card | `Edit` the file |
| Delete card | `rm` the file |
