#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const distServerPath = path.join(root, 'dist', 'server.js');

if (!fs.existsSync(distServerPath)) {
  console.error('Missing dist build. Run: npm run build');
  process.exit(1);
}

const {
  createSubAgentRouterServer,
} = await import(path.join(root, 'dist', 'server.js'));
const { AgentRegistry } = await import(path.join(root, 'dist', 'registry.js'));
const { JobStore } = await import(path.join(root, 'dist', 'job-store.js'));
const { SubAgentCatalog } = await import(path.join(root, 'dist', 'catalog.js'));
const { ConfigStore } = await import(path.join(root, 'dist', 'config-store.js'));
const {
  resolveStateDir,
  ensureDir,
  normalizeName,
  normalizeId,
  generateId,
} = await import(path.join(root, 'dist', 'utils.js'));

function parseNumber(value) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function parseArgs(argv) {
  const options = {
    task: '',
    agent_id: undefined,
    category: undefined,
    skills: undefined,
    model: undefined,
    caller_model: undefined,
    query: undefined,
    command_id: undefined,
    mcp_allow_prefixes: undefined,
    json_only: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') options.agent_id = argv[++i] || '';
    else if (arg === '--category') options.category = argv[++i] || '';
    else if (arg === '--skills') options.skills = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--model') options.model = argv[++i] || '';
    else if (arg === '--caller-model') options.caller_model = argv[++i] || '';
    else if (arg === '--query') options.query = argv[++i] || '';
    else if (arg === '--command') options.command_id = argv[++i] || '';
    else if (arg === '--allow-prefixes') {
      options.mcp_allow_prefixes = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--json') options.json_only = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else rest.push(arg);
  }
  options.task = rest.length > 0 ? rest.join(' ') : '这个项目是做什么的？';
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/test-run-sub-agent.mjs [options] [task...]

Options:
  --agent <id>            Specify agent_id
  --category <name>       Category hint
  --skills <a,b,c>        Skill ids (comma-separated)
  --model <name>          Model name (meta only)
  --caller-model <name>   Caller model (meta only)
  --query <text>          Query hint
  --command <id>          Command id
  --allow-prefixes <a,b>  MCP allow prefixes (comma-separated)
  --json                  Print parsed payload only
  -h, --help              Show help
`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const serverName = normalizeName(String(process.env.SUBAGENT_SERVER_NAME || 'sub_agent_router'));
const sessionId = normalizeId(process.env.MODEL_CLI_SESSION_ID) || generateId('session');
const runId = normalizeId(process.env.MODEL_CLI_RUN_ID);

const stateDir = resolveStateDir(serverName);
ensureDir(stateDir);

const dbPath =
  normalizeId(process.env.MODEL_CLI_SUBAGENT_DB) ||
  path.join(stateDir, `${serverName}.db.sqlite`);

const registryPath =
  normalizeId(process.env.MODEL_CLI_SUBAGENT_REGISTRY) ||
  path.join(stateDir, 'subagents.json');

const marketplacePath =
  normalizeId(process.env.SUBAGENT_MARKETPLACE_PATH) ||
  normalizeId(process.env.MODEL_CLI_SUBAGENT_MARKETPLACE) ||
  path.join(stateDir, 'marketplace.json');

const pluginsRoot =
  normalizeId(process.env.SUBAGENT_PLUGINS_ROOT) ||
  path.join(stateDir, 'plugins');

const timeoutMs = parseNumber(process.env.SUBAGENT_TIMEOUT_MS) || 120000;
const maxOutputBytes = parseNumber(process.env.SUBAGENT_MAX_OUTPUT_BYTES) || 1024 * 1024;
const llmTimeoutMs = parseNumber(process.env.SUBAGENT_LLM_TIMEOUT_MS) || 180000;
const llmMaxOutputBytes = parseNumber(process.env.SUBAGENT_LLM_MAX_OUTPUT_BYTES) || 2 * 1024 * 1024;

ensureDir(path.dirname(registryPath));
if (pluginsRoot) ensureDir(pluginsRoot);

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

const tool = server?._registeredTools?.['run_sub_agent'];
if (!tool) {
  console.error('run_sub_agent tool not found. Available tools:', Object.keys(server?._registeredTools || {}));
  process.exit(1);
}

const input = { task: options.task };
if (options.agent_id) input.agent_id = options.agent_id;
if (options.category) input.category = options.category;
if (options.skills) input.skills = options.skills;
if (options.model) input.model = options.model;
if (options.caller_model) input.caller_model = options.caller_model;
if (options.query) input.query = options.query;
if (options.command_id) input.command_id = options.command_id;
if (options.mcp_allow_prefixes) input.mcp_allow_prefixes = options.mcp_allow_prefixes;

const modelConfig = configStore.getModelConfig();
if (!options.json_only) {
  console.log('=== config ===');
  console.log(JSON.stringify({
    serverName,
    stateDir,
    dbPath,
    registryPath,
    marketplacePath,
    pluginsRoot,
    modelConfig: {
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.model,
      apiKey: modelConfig.apiKey ? '***' : '',
    },
  }, null, 2));
}

try {
  const result = await tool.handler(input);
  if (!options.json_only) {
    console.log('\n=== tool result ===');
    console.log(JSON.stringify(result, null, 2));
  }

  const text = result?.content?.[0]?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (options.json_only) {
        console.log(JSON.stringify(parsed, null, 2));
      } else {
        console.log('\n=== parsed payload ===');
        console.log(JSON.stringify(parsed, null, 2));
      }
    } catch (err) {
      console.log(text);
    }
  }
} catch (err) {
  console.error('run_sub_agent threw:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
