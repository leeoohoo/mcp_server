#!/usr/bin/env node
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSubAgentRouterServer } from './server.js';
import { AgentRegistry } from './registry.js';
import { JobStore } from './job-store.js';
import { SubAgentCatalog } from './catalog.js';
import { ConfigStore } from './config-store.js';
import { startAdminServer } from './admin-server.js';
import {
  parseArgs,
  ensureDir,
  generateId,
  normalizeId,
  normalizeName,
  resolveStateDir,
  parseCommand,
} from './utils.js';

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const serverName = normalizeName(String(args.name || 'sub_agent_router'));
const sessionIdArg = normalizeId(args['session-id'] || args.session);
const runIdArg = normalizeId(args['run-id'] || args.run);

const sessionId = sessionIdArg || normalizeId(process.env.MODEL_CLI_SESSION_ID) || generateId('session');
const runId = runIdArg || normalizeId(process.env.MODEL_CLI_RUN_ID);

process.env.MODEL_CLI_SESSION_ID = sessionId;
if (runId) process.env.MODEL_CLI_RUN_ID = runId;

const stateDir = resolveStateDir(serverName);
ensureDir(stateDir);

const dbPath =
  normalizeId(args.db) ||
  normalizeId(process.env.MODEL_CLI_SUBAGENT_DB) ||
  path.join(stateDir, `${serverName}.db.sqlite`);

const registryPath =
  normalizeId(args.registry) ||
  normalizeId(process.env.MODEL_CLI_SUBAGENT_REGISTRY) ||
  path.join(stateDir, 'subagents.json');

ensureDir(path.dirname(registryPath));

const marketplacePath =
  normalizeId(args.marketplace) ||
  normalizeId(process.env.SUBAGENT_MARKETPLACE_PATH) ||
  normalizeId(process.env.MODEL_CLI_SUBAGENT_MARKETPLACE) ||
  path.join(stateDir, 'marketplace.json');

const pluginsRoot =
  normalizeId(args['plugins-root']) ||
  normalizeId(process.env.SUBAGENT_PLUGINS_ROOT) ||
  path.join(stateDir, 'plugins');

const timeoutMs =
  parseNumber(args['timeout-ms']) ||
  parseNumber(process.env.SUBAGENT_TIMEOUT_MS) ||
  ONE_DAY_MS;

const maxOutputBytes =
  parseNumber(args['max-output-bytes']) ||
  parseNumber(process.env.SUBAGENT_MAX_OUTPUT_BYTES) ||
  1024 * 1024;

const llmTimeoutMs =
  parseNumber(args['llm-timeout-ms']) ||
  parseNumber(process.env.SUBAGENT_LLM_TIMEOUT_MS) ||
  ONE_DAY_MS;

const llmMaxOutputBytes =
  parseNumber(args['llm-max-output-bytes']) ||
  parseNumber(process.env.SUBAGENT_LLM_MAX_OUTPUT_BYTES) ||
  2 * 1024 * 1024;

if (pluginsRoot) {
  ensureDir(pluginsRoot);
}

const registry = new AgentRegistry(stateDir, registryPath);
const catalog = new SubAgentCatalog({
  registry,
  marketplacePath,
  pluginsRoot: pluginsRoot || undefined,
});
const configStore = new ConfigStore(dbPath, { marketplacePath });
configStore.setPluginsRoot(pluginsRoot || '');
configStore.setMarketplacePath(marketplacePath);
configStore.setRegistryPath(registryPath);
configStore.setDbPath(dbPath);
configStore.ensureMarketplaceFile();
const jobStore = new JobStore(dbPath, { defaultSessionId: sessionId, defaultRunId: runId });
const server = createSubAgentRouterServer({
  serverName,
  catalog,
  jobStore,
  configStore,
  defaultSessionId: sessionId,
  defaultRunId: runId,
  timeoutMs,
  maxOutputBytes,
  ai: {
    timeoutMs: llmTimeoutMs,
    maxOutputBytes: llmMaxOutputBytes,
  },
});

async function main() {
  const adminPort =
    parseNumber(args['admin-port']) ||
    parseNumber(process.env.SUBAGENT_ADMIN_PORT) ||
    null;
  const adminHost = String(args['admin-host'] || process.env.SUBAGENT_ADMIN_HOST || '127.0.0.1');
  if (adminPort) {
    startAdminServer({
      host: adminHost,
      port: adminPort,
      configStore,
      jobStore,
      catalog,
      marketplacePath,
      pluginsRoot,
      registryPath,
      dbPath,
    });
    console.error(`[${serverName}] Admin UI running at http://${adminHost}:${adminPort}`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[${serverName}] Sub-agent router ready (db=${dbPath}, registry=${registry.getFilePath()}, marketplace=${marketplacePath}).`
  );
}

main().catch((err) => {
  console.error(`[${serverName}] Sub-agent router crashed:`, err);
  process.exit(1);
});

function parseNumber(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function printHelp() {
  console.log(`Usage: sub-agent-router-mcp-server [options]

Options:
  --name <id>             MCP server name (default sub_agent_router)
  --db <path>             Database file path
  --registry <path>       Registry JSON path (default: $HOME/.mcp_servers/<server>/subagents.json)
  --marketplace <path>    Marketplace JSON path (default: <stateDir>/marketplace.json)
  --plugins-root <path>   Root to resolve marketplace plugin sources
  --session-id <id>       Session ID override (optional; default generated)
  --run-id <id>           Run ID override (optional)
  --timeout-ms <ms>       Command timeout in milliseconds (default 86400000)
  --max-output-bytes <n>  Max stdout/stderr capture per stream (default 1048576)
  --llm-timeout-ms <ms>   AI command timeout (default 86400000)
  --llm-max-output-bytes  AI max stdout/stderr bytes (default 2097152)
  --admin-port <n>        Enable admin config UI on this port
  --admin-host <host>     Admin UI host (default 127.0.0.1)
  --help                  Show help`);
}
