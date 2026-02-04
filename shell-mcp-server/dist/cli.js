#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createShellServer } from './server.js';
import { clampNumber, normalizeId, normalizeName, parseArgs, parseCsv } from './utils.js';
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
    printHelp();
    process.exit(0);
}
const serverName = normalizeName(String(args.name || process.env.MCP_SERVER_NAME || 'shell_mcp'), 'shell_mcp');
const workspaceRoot = normalizeId(args.root || args.workspace || process.env.MCP_WORKSPACE_ROOT) || process.cwd();
const defaultTimeoutMs = clampNumber(args['timeout-ms'] || args.timeout || process.env.MCP_SHELL_TIMEOUT_MS, 1000, 60 * 60 * 1000, 5 * 60_000);
const maxOutputBytes = clampNumber(args['max-output-bytes'] || process.env.MCP_SHELL_MAX_OUTPUT_BYTES, 1024, 50 * 1024 * 1024, 5 * 1024 * 1024);
const allowCommands = parseCsv(args['allow-commands'] || process.env.MCP_SHELL_ALLOW_CMDS);
const denyCommands = parseCsv(args['deny-commands'] || process.env.MCP_SHELL_DENY_CMDS);
async function main() {
    const server = createShellServer({
        serverName,
        workspaceRoot,
        defaultTimeoutMs,
        maxOutputBytes,
        allowCommands,
        denyCommands,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[${serverName}] shell MCP server ready (root=${workspaceRoot}, timeout=${defaultTimeoutMs}ms, maxOutput=${maxOutputBytes} bytes).`);
}
main().catch((err) => {
    console.error(`[${serverName}] shell MCP server crashed:`, err);
    process.exit(1);
});
function printHelp() {
    console.log(`Usage: shell-mcp-server [--name <id>] [--root <path>] [--timeout-ms <ms>] [--max-output-bytes <bytes>]
       [--allow-commands <cmd1,cmd2>] [--deny-commands <cmd1,cmd2>]

Options:
  --name <id>                 MCP server name (default shell_mcp)
  --root <path>               Workspace root (default: current working directory)
  --timeout-ms <ms>           Inactivity timeout in ms (default: 300000)
  --max-output-bytes <bytes>  Maximum captured output (default: 5242880)
  --allow-commands <list>     Comma-separated command roots allowlist
  --deny-commands <list>      Comma-separated command roots denylist
  --help                      Show help

Environment:
  MCP_SERVER_NAME
  MCP_WORKSPACE_ROOT
  MCP_SHELL_TIMEOUT_MS
  MCP_SHELL_MAX_OUTPUT_BYTES
  MCP_SHELL_ALLOW_CMDS
  MCP_SHELL_DENY_CMDS`);
}
