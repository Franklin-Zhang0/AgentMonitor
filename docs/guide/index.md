# Quick Start

## Prerequisites

- Node.js 18+
- Claude Code CLI (`claude`) or OpenAI Codex CLI (`codex`)
- Git (optional; needed for worktree isolation in git repos)

## Installation

```bash
git clone <repo-url> && cd AgentMonitor
npm install
```

## Running

```bash
# Development mode (hot reload)
npm run dev

# Production build
npm run build
npm start
```

The server starts on `http://localhost:3456`.

## Creating Your First Agent

1. Navigate to **New Agent** in the nav bar
2. Enter a name, working directory, and prompt
3. Use **Browse** to pick a directory — if a `CLAUDE.md` exists, you'll be prompted to load it
4. Select provider (Claude Code or Codex)
5. Configure flags (e.g., `--dangerously-skip-permissions`, `--chrome`, `--permission-mode`)
6. Click **Create Agent**

If the working directory is a git repo, the agent will start in an isolated worktree branch. Otherwise, it works directly in the target directory.

## Using the Dashboard

The dashboard shows all active agents as cards with:
- Provider badge (CLAUDE / CODEX)
- Current status (running, stopped, error, waiting_input)
- Cost and token usage
- Latest message preview

Click any card to enter the full chat interface.

## Settings

Open **Settings** from the dashboard to configure:
- **Auto-delete retention**: Automatically remove stopped agents after a configurable period (default 24h, set to 0 to keep forever)

## Language

Use the language dropdown in the top-right corner to switch between 7 supported languages: English, 中文, 日本語, 한국어, Español, Français, Deutsch.
