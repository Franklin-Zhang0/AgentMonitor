# REST API Reference

All API endpoints are served at `http://localhost:3456/api/`.

## Base URL

```
http://localhost:3456/api
```

## Authentication

When accessed through the relay server, authentication via `RELAY_PASSWORD` is required. The login endpoint sets a JWT cookie. When running locally, no authentication is required.

## Response Format

All responses are JSON. Errors return:

```json
{
  "error": "Error description"
}
```

## Endpoints

### Agents
- [Agent endpoints](/api/agents) - Create, manage, and interact with agents

### Pipeline Tasks
- [Task endpoints](/api/tasks) - Manage pipeline tasks and meta agent

### Templates
- [Template endpoints](/api/templates) - CRUD operations for CLAUDE.md templates

### Settings
- `GET /api/settings` - Get server settings (agent retention period)
- `PUT /api/settings` - Update server settings

### Other
- `GET /api/sessions` - List Claude Code sessions
- `GET /api/directories?path=/path` - Browse server filesystem directories
- `GET /api/directories/claude-md?path=/path` - Check if CLAUDE.md exists in a directory
- `GET /api/health` - Health check
