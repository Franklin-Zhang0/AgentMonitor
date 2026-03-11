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
- **Delete**: Remove a stopped agent (click the X button)
- **Settings**: Configure auto-delete retention for stopped agents

## Auto-Delete Expired Agents

Stopped agents can be automatically cleaned up after a configurable retention period. Open **Settings** from the dashboard to set the retention time in hours (default: 24 hours). Set to 0 to keep agents forever. The server checks for expired agents every 60 seconds.

## Real-time Updates

The dashboard uses Socket.IO for live updates. Agent status changes, new messages, and cost updates stream instantly without refreshing the page via `agent:update` (per-agent room events) and `agent:snapshot` (broadcast dashboard updates).
