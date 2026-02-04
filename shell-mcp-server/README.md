# Shell MCP Server (TypeScript)

A standalone MCP server that executes shell commands via stdio, with workspace scoping, inactivity timeout, output limits, and optional allow/deny command lists.

## Install
```bash
npm install shell-mcp-server
```

## Run
```bash
shell-mcp-server --root /path/to/workspace
```

### Options
- `--name <id>`: server name (default `shell_mcp`)
- `--root <path>`: workspace root (default current working directory)
- `--timeout-ms <ms>`: inactivity timeout in milliseconds (default `300000`)
- `--max-output-bytes <bytes>`: max captured output (default `5242880`)
- `--allow-commands <list>`: comma-separated allowlist of command roots (e.g. `ls,cat`)
- `--deny-commands <list>`: comma-separated denylist of command roots

### Environment
- `MCP_SERVER_NAME`
- `MCP_WORKSPACE_ROOT`
- `MCP_SHELL_TIMEOUT_MS`
- `MCP_SHELL_MAX_OUTPUT_BYTES`
- `MCP_SHELL_ALLOW_CMDS`
- `MCP_SHELL_DENY_CMDS`

## Tool
- `run_shell`

### Input schema
- `command` (string, required)
- `dir_path` (string, optional)
- `description` (string, optional)
- `timeout_ms` (number, optional)
- `max_output_bytes` (number, optional)

### Output
Returns a JSON object serialized as text with:
- `command`
- `directory`
- `output` (combined stdout + stderr, truncated by max output)
- `stdout`
- `stderr`
- `error`
- `exit_code`
- `signal`
- `background_pids`
- `pgid`
- `timed_out`
- `truncated`

## Notes
- Unix uses `bash -c`; Windows uses `powershell.exe -NoProfile -Command`.
- On Unix, the command is wrapped to collect background PIDs via `pgrep -g 0`.
- `dir_path` must resolve within `--root`.
