# Code Maintainer MCP Server (TypeScript)

Standalone stdio MCP server for code maintenance workflows.

## Install
```bash
npm install code-maintainer-mcp-server
```

## Run
```bash
code-maintainer-mcp-server --root /path/to/workspace --write
```

## Storage
- Defaults to `$HOME/.mcp-servers/<server>/<server>.db.sqlite`
- Override with `--db` or `MCP_STATE_ROOT`

## Tools
- `read_file_raw`
- `read_file_range`
- `list_dir`
- `search_text`
- `write_file`
- `append_file`
- `delete_path`
- `apply_patch`
