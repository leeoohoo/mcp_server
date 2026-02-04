#!/usr/bin/env node
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTaskServer } from './server.js';
import { TaskStore } from './task-store.js';
import { parseArgs, ensureDir, generateId, normalizeId, normalizeName, resolveStateDir, } from './utils.js';
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
    printHelp();
    process.exit(0);
}
const serverName = normalizeName(String(args.name || 'task_manager'));
const sessionIdArg = normalizeId(args['session-id'] || args.session);
const runIdArg = normalizeId(args['run-id'] || args.run);
const sessionId = sessionIdArg || normalizeId(process.env.MODEL_CLI_SESSION_ID) || generateId('session');
const runId = runIdArg || normalizeId(process.env.MODEL_CLI_RUN_ID);
process.env.MODEL_CLI_SESSION_ID = sessionId;
if (runId)
    process.env.MODEL_CLI_RUN_ID = runId;
const stateDir = resolveStateDir(serverName);
ensureDir(stateDir);
const dbPath = normalizeId(args.db) ||
    normalizeId(process.env.MODEL_CLI_TASK_DB) ||
    path.join(stateDir, `${serverName}.db.sqlite`);
const store = new TaskStore(dbPath, { defaultSessionId: sessionId, defaultRunId: runId });
const server = createTaskServer({
    serverName,
    store,
    defaultSessionId: sessionId,
    defaultRunId: runId,
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[${serverName}] Task MCP server ready (db=${dbPath}).`);
}
main().catch((err) => {
    console.error(`[${serverName}] Task MCP server crashed:`, err);
    process.exit(1);
});
function printHelp() {
    console.log(`Usage: task-mcp-server [--name <id>] [--db <path>] [--session-id <id>] [--run-id <id>]

Options:
  --name <id>        MCP server name (default task_manager)
  --db <path>        Database file path (default: $HOME/.mcp-servers/<server>/<server>.db.sqlite)
  --session-id <id>  Session ID override (optional; default generated per process)
  --run-id <id>      Run ID override (optional)
  --help             Show help`);
}
