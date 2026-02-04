#!/usr/bin/env node
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCodeMaintainerServer } from './server.js';
import { ChangeLogStore } from './storage.js';
import { FsOps } from './fs-ops.js';
import {
  clampNumber,
  ensureDir,
  generateId,
  normalizeId,
  normalizeName,
  parseArgs,
  resolveStateDir,
} from './utils.js';

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const serverName = normalizeName(String(args.name || 'code_maintainer'));
const root = path.resolve(String(args.root || process.cwd()));
const allowWrites = Boolean(args.write) || /write/i.test(String(args.mode || ''));
const maxFileBytes = clampNumber(args['max-bytes'], 1024, 50 * 1024 * 1024, 256 * 1024);
const maxWriteBytes = clampNumber(args['max-write-bytes'], 1024, 100 * 1024 * 1024, 5 * 1024 * 1024);
const searchLimit = clampNumber(args['max-search-results'], 1, 500, 40);

const sessionIdArg = normalizeId(args['session-id'] || args.session);
const runIdArg = normalizeId(args['run-id'] || args.run);
const sessionId = sessionIdArg || normalizeId(process.env.MODEL_CLI_SESSION_ID) || generateId('session');
const runId = runIdArg || normalizeId(process.env.MODEL_CLI_RUN_ID);

process.env.MODEL_CLI_SESSION_ID = sessionId;
if (runId) process.env.MODEL_CLI_RUN_ID = runId;

ensureDir(root);

const stateDir = resolveStateDir(serverName);
ensureDir(stateDir);

const dbPath =
  normalizeId(args.db) ||
  normalizeId(process.env.MODEL_CLI_FILE_CHANGES_DB) ||
  path.join(stateDir, `${serverName}.db.sqlite`);

const changeLog = new ChangeLogStore({ dbPath });
const fsOps = new FsOps({
  root,
  allowWrites,
  maxFileBytes,
  maxWriteBytes,
  searchLimit,
});

const server = createCodeMaintainerServer({
  serverName,
  fsOps,
  changeLog,
  defaultSessionId: sessionId,
  defaultRunId: runId,
  allowWrites,
  workspaceRoot: root,
  maxFileBytes,
  maxWriteBytes,
  searchLimit,
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${serverName}] Code Maintainer MCP server ready (root=${root}, writes=${allowWrites ? 'on' : 'off'}).`);
}

main().catch((err) => {
  console.error(`[${serverName}] Server crashed:`, err);
  process.exit(1);
});

function printHelp() {
  console.log(`Usage: code-maintainer-mcp-server [--root <path>] [--name <id>] [--write] [--mode <text>] [--session-id <id>] [--run-id <id>]

Options:
  --root <path>            Workspace root (default cwd)
  --name <id>              MCP server name (default code_maintainer)
  --write                  Allow write operations
  --mode <text>            If contains 'write' then enables writes
  --max-bytes <n>          Max file bytes to read (default 256 KB)
  --max-write-bytes <n>    Max write bytes (default 5 MB)
  --max-search-results <n> Max search results (default 40)
  --db <path>              SQLite path for change log
  --session-id <id>        Session ID override
  --run-id <id>            Run ID override
  --help                   Show help`);
}
