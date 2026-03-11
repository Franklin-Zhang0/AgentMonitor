# Templates & CLAUDE.md

Templates let you save and reuse CLAUDE.md configurations across agents.

## Auto-Detect CLAUDE.md

When creating a new agent, **Agent Monitor automatically detects** if the selected working directory already contains a `CLAUDE.md` file. If found, you'll see a prompt offering to:

- **Load existing** — Use the project's CLAUDE.md as the agent's instructions
- **Keep custom** — Dismiss the prompt and write your own instructions

This means agents can inherit project-specific instructions without any manual copy-paste. The detection happens via the `GET /api/directories/claude-md?path=...` endpoint.

## Managing Templates

Navigate to **Templates** in the nav bar to:

- **Create**: Click **+ New Template**, enter a name and CLAUDE.md content
- **Edit**: Click the edit button on any template to modify it
- **Delete**: Remove templates you no longer need

## Using Templates

When creating a new agent:
1. Click **Load template...** in the CLAUDE.md section
2. Select a template from the dropdown
3. The template content is loaded into the editor
4. Modify as needed before creating the agent

## Live Editing

You can modify an agent's CLAUDE.md at any time from the Chat view without restarting the agent. Click the **Edit CLAUDE.md** button in the chat header to open the editor.

## Template Tips

- Create a base template with common instructions (coding style, testing requirements)
- Create specialized templates for different task types (frontend, backend, testing)
- Templates are stored server-side and available to all users
