# Templates & CLAUDE.md

Templates let you save and reuse CLAUDE.md configurations across agents. Combined with the **Clone Agent** feature, you can quickly spin up new agents with pre-configured instructions and settings.

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

## Cloning Agents

The **Clone** button (visible on every agent card and in the chat header) creates a new agent pre-filled with:

- Same working directory
- Same provider (Claude Code / Codex)
- Same flags and configuration
- Same CLAUDE.md content

This is the fastest way to run a variation of an existing agent — clone it, adjust the prompt or flags, and launch. Cloning does **not** copy the conversation history; the new agent starts fresh.

### Workflow: Template → Clone

A common pattern for reusable agent setups:

1. **Create a template** with your standard instructions (e.g., "TypeScript coding standards")
2. **Create an agent**, load the template as its CLAUDE.md, set the directory and flags
3. **Clone** that agent whenever you need a fresh instance with the same setup

This gives you a library of reusable agent configurations without manually re-entering settings each time.

## Template Tips

- Create a base template with common instructions (coding style, testing requirements)
- Create specialized templates for different task types (frontend, backend, testing)
- Templates are stored server-side and available to all users
- Use Clone + Template together: template provides the instructions, clone replicates the full agent config
