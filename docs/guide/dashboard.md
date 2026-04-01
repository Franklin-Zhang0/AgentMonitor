# Dashboard

The dashboard provides a real-time overview of all your AI coding agents.

## Agent Cards

Each agent is displayed as a rich information card showing:
- **Provider badge**: CLAUDE (orange) or CODEX (green)
- **Agent name**: Click to enter chat view
- **Status indicator**: Running (green), Stopped (gray), Error (red), Waiting Input (yellow)
- **Project & git branch**: Which repository and branch the agent is working on
- **Pull Request link**: If the agent created a PR, a direct link is shown (auto-detected from agent output)
- **Model & context usage**: Which LLM model the session uses and a visual progress bar showing context window consumption
- **Task description**: A summary of what the agent is currently doing (from the initial prompt)
- **MCP servers**: Which Model Context Protocol servers are connected to the session (parsed from `--mcp-config`)
- **Cost**: Total API cost in USD (Claude) or token count (Codex)
- **Latest message**: Preview of the most recent agent response

## Actions

- **+ New Agent**: Navigate to the agent creation form
- **Stop All**: Stop all running agents at once
- **Delete**: Remove a stopped internal agent. If configured as `ask` or `do not purge`, a confirm dialog appears and lets you choose whether to purge CLI session files by `sessionId`
- **Settings**: Configure auto-delete retention for stopped internal agents and default session-file delete policy (`ask` / `do not purge` / `always purge`)

## External Agent Discovery

Agent Monitor automatically discovers Claude Code and Codex processes running outside the dashboard (e.g., started from a terminal). These are displayed with an **EXT** badge while their local process is alive.

- **Automatic session ingestion**: Existing local sessions are loaded from provider log files (`~/.claude/projects/**.jsonl` and `~/.codex/sessions/**.jsonl`) so history appears automatically after discovery.
- **Running-only visibility**: External cards are removed automatically after the underlying process exits.
- **Safe deletion model**: External cards cannot be deleted from Agent Monitor.
- **Toggle visibility**: Click the **External (N)** button in the dashboard toolbar to show or hide external agents. The preference is persisted across sessions.
- **Live updates**: External agents stream messages and status changes in real time, including tool calls/results and token/context updates when available.
- **Source indicator**: External agents are marked with `source: 'external'` and display an "EXT" badge on their card.
- **Internal agents are unaffected**: Internal agents created by Agent Monitor remain visible after stop (until manual delete or retention cleanup).

## Auto-Delete Expired Agents

Stopped internal agents can be automatically cleaned up after a configurable retention period. Open **Settings** from the dashboard to set the retention time in hours (default: 24 hours). Set to 0 to keep agents forever. The server checks for expired agents every 60 seconds.

## Real-time Updates

The dashboard uses Socket.IO for live updates. Agent status changes, new messages, and cost updates stream instantly without refreshing the page via `agent:update` (per-agent room events) and `agent:snapshot` (broadcast dashboard updates).
