# Clone Agent With Context (Design)

## Background

Current clone behavior in Agent Monitor is configuration-first:

- Copy provider, directory, flags, prompt, and instruction file content
- Start a fresh conversation with no prior history

This is useful and should remain the default.  
We want to add a second core mode: **clone from current conversation context**.

## Product Goals

- Keep existing clone behavior as **Clone Setup** (today's behavior)
- Add **Clone With Context** as an explicit mode
- Support same-provider and cross-provider context cloning:
- Claude → Claude
- Codex → Codex
- Claude → Codex
- Codex → Claude
- Ensure cloned agent remains independent (new agent ID, isolated lifecycle)

## Non-Goals

- Do not merge process/session IDs between source and target agents
- Do not mutate source agent history
- Do not guarantee perfect tool-state replay (filesystem/process side effects are out of scope)

## UX Design

When user clicks **Clone**, open a modal with mode selection:

1. **Clone Setup (Current)**
- Copy config + instruction file only
- Start fresh context

2. **Clone With Context**
- Copy config + instruction file + selected conversation context
- Allow changing target provider before create

For **Clone With Context**, show options:

- Context source:
- Last `N` turns (default `20`)
- Up to selected turn (advanced)
- Include tool calls/results: on by default
- Context budget:
- Auto (recommended)
- Custom character/token cap
- Target provider:
- Same as source (default)
- Switch to Claude/Codex

## Data Contract (Proposed)

Add clone preview endpoint:

`POST /api/agents/:id/clone-preview`

Request:

```json
{
  "mode": "setup" | "context",
  "targetProvider": "claude" | "codex",
  "context": {
    "strategy": "last_n" | "to_turn",
    "lastNTurns": 20,
    "toTurnIndex": 42,
    "includeTools": true,
    "maxChars": 60000
  }
}
```

Response:

```json
{
  "name": "agent-copy",
  "provider": "codex",
  "directory": "/path",
  "prompt": "initial user prompt",
  "instruction": {
    "fileName": "AGENTS.md",
    "content": "..."
  },
  "flags": {},
  "contextSeed": "provider-ready context seed",
  "meta": {
    "sourceAgentId": "...",
    "sourceProvider": "claude",
    "targetProvider": "codex",
    "estimatedChars": 18342,
    "truncated": false
  }
}
```

Create agent stays `POST /api/agents`, with optional:

```json
{
  "cloneMeta": {
    "mode": "setup" | "context",
    "sourceAgentId": "...",
    "sourceProvider": "claude",
    "targetProvider": "codex"
  },
  "contextSeed": "..."
}
```

## Context Conversion Model

Use a neutral intermediate model before rendering provider-specific prompt text:

- `system` messages
- `user` messages
- `assistant` messages
- `tool` events (`toolName`, `toolInput`, `toolResult`)
- timestamps (optional for ordering only)

Then render per target provider:

- Claude renderer: concise "conversation context" preface + ordered turns
- Codex renderer: same data, phrasing tuned for Codex task continuation

This keeps conversion deterministic and avoids hard-coding one provider's raw JSONL format into the other.

## Behavior Rules

- **Same provider clone with context**:
- Do not reuse `sessionId` / `--resume`
- Start a fresh session with `contextSeed` prepended to first turn

- **Cross provider clone with context**:
- Convert via neutral model
- Rewrite instruction filename automatically (`CLAUDE.md` ↔ `AGENTS.md`)
- Preserve high-signal tool outputs, truncate large logs

- **Fallbacks**:
- If context extraction fails, still allow setup clone
- If target provider unavailable on runtime capability check, block create with clear error

## Safety & Limits

- Default hard cap: `maxChars = 60000` for seed payload
- Truncation policy:
- Keep newest turns first
- Keep tool outputs summarized to bounded length
- Add truncation notice in `contextSeed` header
- Optional redaction pass for obvious secrets in tool output:
- API keys, tokens, passwords (regex-based best-effort)

## Persistence

Store clone provenance on agent for observability:

- `cloneMeta.mode`
- `cloneMeta.sourceAgentId`
- `cloneMeta.sourceProvider`
- `cloneMeta.targetProvider`
- `cloneMeta.createdAt`

This helps debugging and future UX (e.g., "re-clone from same source").

## Rollout Plan

Phase 1 (low risk):

- Modal with two clone modes
- Setup clone unchanged
- Context clone same-provider only
- `contextSeed` injection path (no resume reuse)

Phase 2:

- Cross-provider conversion (Claude ↔ Codex)
- Provider-specific context renderers
- UI hints about conversion/truncation

Phase 3:

- Optional context quality improvements (semantic summarization, smarter truncation)

## Open Questions

- Should context clone create immediately, or first open prefilled Create page for review?
- For cross-provider clone, should model/flags be auto-translated or reset to safe defaults?
- Should code snapshots (worktree restore points) be referenced in context clone metadata?
