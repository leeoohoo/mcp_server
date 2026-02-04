# Task MCP Server (TypeScript)

A standalone Task MCP server implemented in TypeScript, using an embedded SQLite database (better-sqlite3).

## Install
```bash
npm install task-mcp-server
```

## Run (stdio)
```bash
task-mcp-server --name task_manager
```

### Options
- `--name <id>`: server name (default `task_manager`)
- `--db <path>`: custom SQLite file path
- `--session-id <id>`: force a session id (otherwise generated per process)
- `--run-id <id>`: optional run id

## Storage
By default, data is stored under:
```
$HOME/.mcp-servers/<server>/<server>.db.sqlite
```
You can override the base directory with `MCP_STATE_ROOT`.

## Tools
- `add_task`
- `list_tasks`
- `update_task`
- `complete_task`
- `clear_tasks`
