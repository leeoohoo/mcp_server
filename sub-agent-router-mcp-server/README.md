# Sub-agent Router MCP Server

TypeScript MCP server that routes tasks to locally configured sub-agents. Sub-agents can be loaded from a marketplace + plugins directory and executed via a local LLM command.

## Install & Build

```bash
npm install
npm run build
```

## Run

```bash
node dist/cli.js --marketplace /path/to/marketplace.json --plugins-root /path/to/plugins
```

## Registry format

Create a `subagents.json` file:

```json
{
  "agents": [
    {
      "id": "python_helper",
      "name": "Python Helper",
      "description": "Run Python scripts for data tasks",
      "category": "python",
      "skills": ["python", "pandas"],
      "defaultCommand": "run",
      "commands": [
        {
          "id": "run",
          "description": "Run a Python script",
          "exec": ["python3", "scripts/worker.py"]
        }
      ]
    }
  ]
}
```

The command receives context via environment variables:

- `SUBAGENT_TASK`
- `SUBAGENT_AGENT_ID`
- `SUBAGENT_COMMAND_ID`
- `SUBAGENT_SKILLS`
- `SUBAGENT_SESSION_ID`
- `SUBAGENT_RUN_ID`
- `SUBAGENT_CATEGORY`
- `SUBAGENT_QUERY`
- `SUBAGENT_MODEL`
- `SUBAGENT_CALLER_MODEL`

## Marketplace

Place `marketplace.json` and the corresponding `plugins/` directory under your state dir, or pass them explicitly:

```bash
node dist/cli.js \
  --marketplace /Users/lilei/.mcp_servers/sub_agent_router/marketplace.json \
  --plugins-root /Users/lilei/.mcp_servers/sub_agent_router
```

Each plugin entry in `marketplace.json` must have `source`, `agents`, `commands`, and `skills` paths that resolve under `plugins-root`.

## Admin UI

Enable a local admin page to configure MCP prefixes, upload marketplace JSON, and inspect agents/skills/commands (with one-click install for missing plugins):

```bash
node dist/cli.js --admin-port 8765
```

Then open `http://127.0.0.1:8765`.

To enable one-click install, set **Plugins Source Root** in the UI to a full subagents repository root (the folder that contains `plugins/`).

## AI command

This server does not embed a model. Configure a local LLM command that reads a prompt from stdin and prints a response to stdout:

```bash
export SUBAGENT_LLM_CMD='["/path/to/llm-runner","--model","deepseek_chat"]'
```

## Tools

- `get_sub_agent`
- `suggest_sub_agent`
- `run_sub_agent`
- `start_sub_agent_async`
- `get_sub_agent_status`
- `cancel_sub_agent_job`

## Environment

- `MCP_STATE_ROOT` sets the base state directory.
- `MODEL_CLI_SUBAGENT_DB` overrides the DB path.
- `MODEL_CLI_SUBAGENT_REGISTRY` overrides the registry path.
- `SUBAGENT_MARKETPLACE_PATH` overrides the marketplace path.
- `SUBAGENT_PLUGINS_ROOT` overrides the plugins root.
- `SUBAGENT_LLM_CMD` sets the AI command (JSON array string recommended).
- `SUBAGENT_LLM_TIMEOUT_MS` overrides AI timeout.
- `SUBAGENT_LLM_MAX_OUTPUT_BYTES` overrides AI output limit.
- `SUBAGENT_ADMIN_PORT` enables admin UI.
- `SUBAGENT_ADMIN_HOST` sets admin host.
- `SUBAGENT_TIMEOUT_MS` overrides the command timeout.
- `SUBAGENT_MAX_OUTPUT_BYTES` overrides the output capture limit.
