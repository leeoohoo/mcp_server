import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { ConfigStore } from './config-store.js';
import { JobStore } from './job-store.js';
import { SubAgentCatalog } from './catalog.js';
import { parseCommand } from './utils.js';

export interface AdminServerOptions {
  host: string;
  port: number;
  configStore: ConfigStore;
  jobStore?: JobStore;
  catalog: SubAgentCatalog;
  marketplacePath?: string;
  pluginsRoot?: string;
  registryPath?: string;
  dbPath?: string;
}

interface EntrySummary {
  id: string;
  title: string;
  path: string;
  exists: boolean;
}

interface PluginSummary {
  name: string;
  source: string;
  category: string;
  description: string;
  version: string;
  repository: string;
  homepage: string;
  exists: boolean;
  counts: {
    agents: { total: number; available: number };
    skills: { total: number; available: number };
    commands: { total: number; available: number };
  };
  agents: EntrySummary[];
  skills: EntrySummary[];
  commands: EntrySummary[];
}

interface MarketplaceSummary {
  plugins: PluginSummary[];
  counts: {
    agents: { total: number; available: number };
    skills: { total: number; available: number };
    commands: { total: number; available: number };
  };
}

export function startAdminServer(options: AdminServerOptions) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url || '/';
      const pathname = url.split('?')[0];
      if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderPage());
        return;
      }
      if (req.method === 'GET' && url === '/api/status') {
        const modelConfig = options.configStore.getModelConfig();
        const modelConfigs = options.configStore.getModelConfigs();
        const activeModelId = options.configStore.getActiveModelId();
        const runtimeConfig = options.configStore.getRuntimeConfig();
        const payload = {
          allow_prefixes: options.configStore.getAllowPrefixes(),
          marketplaces: options.configStore.listMarketplaces(),
          active_marketplaces: options.configStore.getActiveMarketplaces().map((entry) => entry.id),
          marketplace_path: options.marketplacePath || '',
          plugins_root: options.configStore.getPluginsRoot() || options.pluginsRoot || '',
          plugins_source_root: options.configStore.getPluginsSourceRoot(),
          registry_path: options.registryPath || options.configStore.getRegistryPath(),
          db_path: options.dbPath || options.configStore.getDbPath(),
          model_config: {
            api_key: modelConfig.apiKey,
            base_url: modelConfig.baseUrl,
            model: modelConfig.model,
            reasoning_enabled: modelConfig.reasoningEnabled,
          },
          model_configs: modelConfigs.map((entry) => ({
            id: entry.id,
            name: entry.name,
            api_key: entry.apiKey,
            base_url: entry.baseUrl,
            model: entry.model,
            reasoning_enabled: entry.reasoningEnabled,
          })),
          active_model_id: activeModelId,
          runtime_config: runtimeConfig,
        };
        return sendJson(res, payload);
      }
      if (req.method === 'POST' && url === '/api/settings') {
        const body = await readJson(req);
        if (typeof body?.plugins_root === 'string') {
          const root = body.plugins_root.trim();
          options.configStore.setPluginsRoot(root);
          options.catalog.setPluginsRoot(root || undefined);
        }
        if (typeof body?.plugins_source_root === 'string') {
          options.configStore.setPluginsSourceRoot(body.plugins_source_root.trim());
        }
        if (typeof body?.mcp_allow_prefixes === 'string') {
          const prefixes = body.mcp_allow_prefixes
            .split(',')
            .map((p: string) => p.trim())
            .filter(Boolean);
          options.configStore.setAllowPrefixes(prefixes);
        }
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/model_settings') {
        const body = await readJson(req);
        if (Array.isArray(body?.models)) {
          const models = body.models.map((entry: any) => ({
            id: entry?.id,
            name: entry?.name,
            apiKey: entry?.api_key,
            baseUrl: entry?.base_url,
            model: entry?.model,
            reasoningEnabled: entry?.reasoning_enabled !== false,
          }));
          options.configStore.setModelConfigs(models);
          if (typeof body?.active_model_id === 'string') {
            options.configStore.setActiveModelId(body.active_model_id);
          }
        } else {
          const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : '';
          const baseUrl = typeof body?.base_url === 'string' ? body.base_url.trim() : '';
          const model = typeof body?.model === 'string' ? body.model.trim() : '';
          const reasoningEnabled = body?.reasoning_enabled !== false;
          options.configStore.setModelConfig({ apiKey, baseUrl, model, reasoningEnabled });
        }
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/runtime_settings') {
        const body = await readJson(req);
        options.configStore.setRuntimeConfig({
          aiTimeoutMs: body?.ai_timeout_ms,
          aiMaxOutputBytes: body?.ai_max_output_bytes,
          aiToolMaxTurns: body?.ai_tool_max_turns,
          commandTimeoutMs: body?.command_timeout_ms,
          commandMaxOutputBytes: body?.command_max_output_bytes,
        });
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/allow_prefixes') {
        const body = await readJson(req);
        const prefixes = Array.isArray(body?.prefixes) ? body.prefixes : [];
        options.configStore.setAllowPrefixes(prefixes);
        return sendJson(res, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/jobs') {
        if (!options.jobStore) {
          return sendJson(res, { ok: false, error: 'job store not configured' }, 500);
        }
        const parsed = new URL(url, 'http://localhost');
        const status = parsed.searchParams.get('status') || '';
        const sessionId = parsed.searchParams.get('session_id') || '';
        const limit = Number(parsed.searchParams.get('limit') || '');
        const allSessions =
          parsed.searchParams.get('all_sessions') === '1' || parsed.searchParams.get('all_sessions') === 'true';
        const jobs = options.jobStore.listJobs({
          sessionId,
          status: status ? (status as any) : undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
          allSessions,
        });
        return sendJson(res, { ok: true, jobs });
      }
      if (req.method === 'GET' && pathname === '/api/job_sessions') {
        if (!options.jobStore) {
          return sendJson(res, { ok: false, error: 'job store not configured' }, 500);
        }
        const sessions = options.jobStore.listSessions();
        return sendJson(res, { ok: true, sessions });
      }
      if (req.method === 'GET' && url === '/api/mcp_servers') {
        return sendJson(res, { servers: options.configStore.listMcpServers() });
      }
      if (req.method === 'POST' && url === '/api/mcp_servers/save') {
        const body = await readJson(req);
        const id = typeof body?.id === 'string' ? body.id.trim() : '';
        const name = String(body?.name || '').trim();
        const transport = String(body?.transport || 'stdio').trim() || 'stdio';
        const endpointUrl = String(body?.endpoint_url || '').trim();
        const headersJson = String(body?.headers_json || '').trim();
        const parsed = parseCommandParts(String(body?.command || ''), body?.args);
        const command = parsed.command;
        const args = parsed.args;
        const enabled = body?.enabled !== false;
        if (!name) return sendJson(res, { ok: false, error: 'missing name' }, 400);
        if (transport === 'stdio') {
          if (!command) return sendJson(res, { ok: false, error: 'missing command' }, 400);
        } else {
          if (!endpointUrl) return sendJson(res, { ok: false, error: 'missing endpoint url' }, 400);
        }
        const savedId = options.configStore.saveMcpServer({
          id: id || undefined,
          name,
          transport,
          command: transport === 'stdio' ? command : endpointUrl,
          args: transport === 'stdio' ? args : [],
          endpointUrl,
          headersJson,
          enabled,
        });
        return sendJson(res, { ok: true, id: savedId });
      }
      if (req.method === 'POST' && url === '/api/mcp_servers/delete') {
        const body = await readJson(req);
        const id = typeof body?.id === 'string' ? body.id.trim() : '';
        if (!id) return sendJson(res, { ok: false, error: 'missing id' }, 400);
        options.configStore.deleteMcpServer(id);
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/marketplace') {
        const body = await readJson(req);
        if (!body?.json) {
          return sendJson(res, { ok: false, error: 'missing json' }, 400);
        }
        const id = options.configStore.saveMarketplace({
          name: typeof body.name === 'string' ? body.name : undefined,
          json: String(body.json),
          activate: body.activate !== false,
        });
        options.configStore.ensureMarketplaceFile();
        options.catalog.reload();
        return sendJson(res, { ok: true, id });
      }
      if (req.method === 'GET' && url === '/api/marketplace/summary') {
        const summary = buildMarketplaceSummary(options);
        return sendJson(res, summary);
      }
      if (req.method === 'POST' && url === '/api/marketplace/activate') {
        const body = await readJson(req);
        const id = typeof body?.id === 'string' ? body.id : '';
        if (!id) return sendJson(res, { ok: false, error: 'missing id' }, 400);
        const active = body?.active !== false;
        options.configStore.setMarketplaceActive(id, active);
        options.catalog.reload();
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/marketplace/delete') {
        const body = await readJson(req);
        const id = typeof body?.id === 'string' ? body.id : '';
        if (!id) return sendJson(res, { ok: false, error: 'missing id' }, 400);
        options.configStore.deleteMarketplace(id);
        options.catalog.reload();
        return sendJson(res, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/plugins/install') {
        const body = await readJson(req);
        const source = typeof body?.source === 'string' ? body.source : '';
        if (!source) return sendJson(res, { ok: false, error: 'missing source' }, 400);
        const summary = buildMarketplaceSummary(options);
        const plugin = summary.plugins.find((entry) => entry.source === source);
        if (!plugin) return sendJson(res, { ok: false, error: 'plugin not found' }, 404);
        const result = await installPlugin(options, plugin, summary);
        if (!result.ok) return sendJson(res, result, 400);
        options.catalog.reload();
        return sendJson(res, result);
      }
      if (req.method === 'POST' && url === '/api/plugins/install_missing') {
        const summary = buildMarketplaceSummary(options);
        const missing = summary.plugins.filter((entry) => !entry.exists);
        const results = [];
        for (const plugin of missing) {
          const result = await installPlugin(options, plugin, summary);
          results.push({ source: plugin.source, name: plugin.name, ...result });
        }
        options.catalog.reload();
        return sendJson(res, { ok: true, count: results.length, results });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, { ok: false, error: message }, 500);
    }
  });

  server.listen(options.port, options.host);
  return server;
}

function sendJson(res: http.ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 5 * 1024 * 1024) {
      throw new Error('payload too large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid json');
  }
}

function parseCommandParts(commandInput: string, argsInput: unknown): { command: string; args: string[] } {
  let command = String(commandInput || '').trim();
  let args = normalizeArgs(argsInput);
  if (!args.length && command && /\s/.test(command)) {
    const parsed = parseCommand(command) || [];
    if (parsed.length > 0) {
      command = parsed[0];
      args = parsed.slice(1);
    }
  }
  return { command, args };
}

function normalizeArgs(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((entry) => String(entry)).filter(Boolean);
  }
  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return [];
    if (raw.startsWith('[')) {
      const parsed = parseCommand(raw);
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
    }
    const commaParts = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (commaParts.length > 1) {
      const args: string[] = [];
      for (const part of commaParts) {
        const parsed = parseCommand(part);
        if (Array.isArray(parsed) && parsed.length > 0) {
          args.push(...parsed.map((entry) => String(entry)));
        } else if (part) {
          args.push(part);
        }
      }
      return args.filter(Boolean);
    }
    const parsed = parseCommand(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  }
  return [];
}

function renderPage() {
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sub-agent Router Config</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB" crossorigin="anonymous" />
  <style>
    :root {
      --app-bg: #f6f7fb;
      --app-muted: #64748b;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: var(--app-bg); color: #0f172a; }
    .page { max-width: 1240px; }
    .page-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0; }
    nav.tabs { display: flex; gap: 8px; margin: 12px 0 16px; flex-wrap: wrap; }
    nav.tabs.sub-tabs { margin-top: 6px; }
    nav.tabs .tab-btn { border-radius: 999px; }
    .tab { display: none; }
    .tab.active { display: block; }
    .subtab { display: none; }
    .subtab.active { display: block; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
    .grid-1 { display: grid; grid-template-columns: 1fr; gap: 20px; }
    @media (max-width: 1000px) { .grid-2 { grid-template-columns: 1fr; } }
    label { display: block; margin: 10px 0 6px; font-weight: 600; }
    textarea, input, select { width: 100%; max-width: 100%; }
    .field-row { margin-bottom: 12px; }
    .muted { color: var(--app-muted); font-size: 0.875rem; }
    .missing { color: #b00020; }
    details { margin: 8px 0; }
    .inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .inline .form-control, .inline .form-select { flex: 1; min-width: 160px; }
    .inline label { margin: 0; font-weight: 400; }
    .alert { margin: 10px 0 16px; }
    .card { padding: 16px; border-radius: 14px; border: 0; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); }
    .list { margin: 6px 0 0; padding-left: 18px; }
    .list li { margin: 4px 0; }
    .section-title { font-weight: 600; margin-bottom: 6px; }
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.35); align-items: center; justify-content: center; z-index: 1000; }
    .modal.active { display: flex; }
    .modal-content { width: min(900px, 92vw); max-height: 90vh; overflow: auto; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .modal-body .field-row { margin-bottom: 12px; }
    .modal-body textarea { width: 100%; min-height: 120px; }
    .modal-body input { width: 100%; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #f3f3f3; font-size: 12px; margin-left: 6px; }
  </style>
</head>
<body>
  <div class="page container py-4">
    <div class="page-header">
      <div>
        <h1>Sub-agent Router</h1>
        <div class="muted">Admin UI</div>
      </div>
      <span class="badge text-bg-primary-subtle border border-primary-subtle">Local</span>
    </div>

    <nav class="tabs main-tabs btn-group" role="tablist">
      <button class="btn btn-outline-primary tab-btn active" data-tab="settings">设置</button>
      <button class="btn btn-outline-primary tab-btn" data-tab="jobs">任务</button>
    </nav>

    <div id="message" class="alert d-none" role="alert"></div>

    <section id="tab-settings" class="tab active">
      <nav class="tabs sub-tabs btn-group" role="tablist">
        <button class="btn btn-outline-secondary tab-btn active" data-subtab="model">模型</button>
        <button class="btn btn-outline-secondary tab-btn" data-subtab="mcp">MCP</button>
        <button class="btn btn-outline-secondary tab-btn" data-subtab="marketplace">Marketplace</button>
      </nav>

      <section id="subtab-model" class="subtab active">
        <div class="grid-2">
          <div class="card">
            <div class="field-row">
              <div class="section-title">模型列表</div>
              <div class="table-responsive">
                <table id="modelTable" class="table table-sm table-hover align-middle">
                  <thead>
                    <tr><th>名称</th><th>Model</th><th>Base URL</th><th>推理</th><th>当前</th><th>操作</th></tr>
                  </thead>
                  <tbody></tbody>
                </table>
              </div>
              <div class="inline">
                <button id="modelAdd" class="btn btn-primary btn-sm">新增模型</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="field-row">
              <div class="section-title" id="modelFormTitle">新增/编辑模型</div>
              <label>名称</label>
              <input id="modelNameInput" class="form-control form-control-sm" placeholder="例如：Kimi / GPT" />
              <label>API Key</label>
              <input id="modelApiKeyInput" class="form-control form-control-sm" type="password" placeholder="sk-..." />
              <div class="muted">仅保存在本地数据库中，不会上传。</div>
            </div>
            <div class="field-row">
              <label>Base URL</label>
              <input id="modelBaseUrlInput" class="form-control form-control-sm" placeholder="https://api.openai.com/v1" />
            </div>
            <div class="field-row">
              <label>Model</label>
              <input id="modelModelInput" class="form-control form-control-sm" placeholder="gpt-4o-mini / kimi-k2.5 / ..." />
            </div>
            <div class="field-row inline">
              <label><input id="modelReasoningEnabled" type="checkbox" /> 启用推理</label>
            </div>
            <div class="field-row inline">
              <button id="modelSave" class="btn btn-primary btn-sm">保存模型</button>
              <button id="modelClear" class="btn btn-outline-secondary btn-sm">清空</button>
            </div>
          </div>

          <div class="card">
            <div class="field-row">
              <div class="section-title">运行参数</div>
              <label>AI Timeout (ms, 0=无限)</label>
              <input id="aiTimeoutMs" class="form-control form-control-sm" placeholder="180000" />
            </div>
            <div class="field-row">
              <label>AI Max Output Bytes (0=无限)</label>
              <input id="aiMaxOutputBytes" class="form-control form-control-sm" placeholder="2097152" />
            </div>
            <div class="field-row">
              <label>AI Tool Max Turns</label>
              <input id="aiToolMaxTurns" class="form-control form-control-sm" placeholder="100" />
            </div>
            <div class="field-row">
              <label>Command Timeout (ms, 0=无限)</label>
              <input id="commandTimeoutMs" class="form-control form-control-sm" placeholder="120000" />
            </div>
            <div class="field-row">
              <label>Command Max Output Bytes (0=无限)</label>
              <input id="commandMaxOutputBytes" class="form-control form-control-sm" placeholder="1048576" />
            </div>
            <div class="field-row inline">
              <button id="saveRuntime" class="btn btn-outline-secondary btn-sm">保存运行参数</button>
            </div>
          </div>
        </div>
      </section>

      <section id="subtab-mcp" class="subtab">
      <div class="grid-1">
        <div class="card">
          <div class="field-row">
            <div class="section-title">MCP Allow Prefixes</div>
            <label>前缀（逗号分隔）</label>
            <input id="allowPrefixes" class="form-control form-control-sm" placeholder="mcp_task_manager_, mcp_filesystem_" />
            <div class="inline">
              <button id="saveAllow" class="btn btn-primary btn-sm">保存</button>
            </div>
            <div class="muted">用于提示子代理允许使用的 MCP 前缀（运行时只做提示约束）。</div>
          </div>
        </div>

        <div class="card">
          <div class="field-row">
            <div class="section-title">MCP Servers</div>
            <div class="muted">配置子代理可用的 MCP 服务（name + 协议 + cmd + args）。</div>
            <div class="inline">
              <button id="mcpOpenModal" class="btn btn-primary btn-sm">新增 MCP</button>
            </div>
            <div class="table-responsive">
              <table id="mcpTable" class="table table-sm table-hover align-middle">
                <thead>
                  <tr><th>Name</th><th>协议</th><th>Target</th><th>配置</th><th>启用</th><th>操作</th></tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      </section>

      <section id="subtab-marketplace" class="subtab">
      <div class="grid-2">
        <div class="card">
          <div class="field-row">
            <div class="section-title">插件根目录</div>
            <label>Plugins Root（安装目录）</label>
            <input id="pluginsRoot" class="form-control form-control-sm" placeholder="/path/to/plugins" />
            <div class="muted">子代理可用插件的安装目录（用于加载 agents/skills/commands）。</div>
          </div>
          <div class="field-row">
            <label>Plugins Source Root（用于一键安装）</label>
            <input id="pluginsSourceRoot" class="form-control form-control-sm" placeholder="/path/to/source/subagents" />
            <div class="muted">可指向本地完整 subagents 仓库，用于一键安装缺失插件。</div>
          </div>
          <div class="field-row inline">
            <button id="saveSettings" class="btn btn-primary btn-sm">保存</button>
          </div>
        </div>

        <div class="card">
          <div class="field-row">
            <div class="section-title">系统路径</div>
            <label>Marketplace 路径（只读）</label>
            <input id="marketplacePathInput" class="form-control form-control-sm" readonly />
          </div>
          <div class="field-row">
            <label>Registry 路径（只读）</label>
            <input id="registryPathInput" class="form-control form-control-sm" readonly />
          </div>
          <div class="field-row">
            <label>DB 路径（只读）</label>
            <input id="dbPathInput" class="form-control form-control-sm" readonly />
          </div>
        </div>
      </div>

      <div class="grid-1">
        <div class="card">
          <div class="field-row">
            <div class="section-title">上传 marketplace.json</div>
            <input type="file" id="marketplaceFile" class="form-control form-control-sm" accept=".json" />
            <div class="inline">
              <button id="uploadMarketplace" class="btn btn-primary btn-sm">上传并激活</button>
            </div>
            <div class="muted" id="marketplacePath"></div>
          </div>
        </div>

        <div class="card">
          <div class="field-row">
            <div class="section-title">已保存的 Marketplace</div>
            <div class="table-responsive">
              <table id="marketplaceStoreTable" class="table table-sm table-hover align-middle">
                <thead><tr><th>名称</th><th>插件数</th><th>创建时间</th><th>启用</th><th>操作</th></tr></thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="field-row">
            <div class="section-title">Marketplace 概览</div>
            <div class="inline">
              <button id="installMissing" class="btn btn-primary btn-sm">安装缺失插件</button>
            </div>
            <div id="marketplaceSummary" class="muted"></div>
            <div class="table-responsive">
              <table id="pluginsTable" class="table table-sm table-hover align-middle">
                <thead><tr><th>插件</th><th>分类</th><th>Agents</th><th>Skills</th><th>Commands</th><th>状态</th><th>操作</th></tr></thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="field-row">
            <div class="section-title">插件详情</div>
            <div id="marketplaceDetails"></div>
          </div>
        </div>
      </div>
      </section>
    </section>

    <section id="tab-jobs" class="tab">
      <div class="grid-1">
        <div class="card">
          <div class="field-row">
            <div class="section-title">任务列表</div>
            <div class="inline">
              <input id="jobSessionFilter" class="form-control form-control-sm" placeholder="Session ID (留空=全部)" list="jobSessionList" />
              <datalist id="jobSessionList"></datalist>
              <select id="jobStatusFilter" class="form-select form-select-sm">
                <option value="">状态: 全部</option>
                <option value="queued">queued</option>
                <option value="running">running</option>
                <option value="done">done</option>
                <option value="error">error</option>
                <option value="cancelled">cancelled</option>
              </select>
              <label><input id="jobAllSessions" type="checkbox" checked /> 全部会话</label>
              <button id="jobRefresh" class="btn btn-outline-secondary btn-sm">刷新</button>
            </div>
            <div class="table-responsive">
              <table id="jobsTable" class="table table-sm table-hover align-middle">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>Session</th>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Task</th>
                    <th>Duration</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div id="mcpModal" class="modal">
      <div class="modal-content card">
        <div class="modal-header">
          <h3 id="mcpModalTitle">新增 MCP</h3>
          <button id="mcpCloseModal" class="btn btn-outline-secondary btn-sm">关闭</button>
        </div>
        <div class="modal-body">
          <div class="field-row">
            <label>名称</label>
            <input id="mcpName" class="form-control form-control-sm" placeholder="filesystem / task / lsp" />
          </div>
          <div class="field-row">
            <label>协议</label>
            <select id="mcpTransport" class="form-select form-select-sm">
              <option value="stdio">stdio</option>
              <option value="sse">sse</option>
              <option value="http">http</option>
            </select>
            <span class="pill" id="mcpTransportHint">stdio</span>
          </div>
          <div id="mcpStdioFields">
            <div class="field-row">
              <label>Cmd</label>
              <input id="mcpCommand" class="form-control form-control-sm" placeholder="node /path/server.js" />
            </div>
            <div class="field-row">
              <label>Args</label>
              <textarea id="mcpArgs" class="form-control form-control-sm" placeholder="--root /path/to/project&#10;--verbose"></textarea>
            </div>
          </div>
          <div id="mcpHttpFields" style="display:none;">
            <div class="field-row">
              <label>Endpoint URL</label>
              <input id="mcpEndpoint" class="form-control form-control-sm" placeholder="http://127.0.0.1:8080/sse 或 http://127.0.0.1:8080/mcp" />
            </div>
            <div class="field-row">
              <label>Headers (JSON)</label>
              <textarea id="mcpHeaders" class="form-control form-control-sm" placeholder='{"Authorization":"Bearer xxx"}'></textarea>
            </div>
          </div>
          <div class="field-row">
            <label><input type="checkbox" id="mcpEnabled" checked /> 启用</label>
          </div>
          <div class="field-row inline">
            <button id="mcpSave" class="btn btn-primary btn-sm">保存</button>
            <button id="mcpClear" class="btn btn-outline-secondary btn-sm">清空</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const mainTabs = document.querySelectorAll('nav.tabs.main-tabs .tab-btn');
    mainTabs.forEach(btn => btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      if (!target) return;
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      const section = document.getElementById('tab-' + target);
      if (section) section.classList.add('active');
      mainTabs.forEach(node => {
        node.classList.remove('active');
      });
      btn.classList.add('active');
    }));

    const subTabs = document.querySelectorAll('nav.tabs.sub-tabs .tab-btn');
    subTabs.forEach(btn => btn.addEventListener('click', () => {
      const target = btn.dataset.subtab;
      if (!target) return;
      document.querySelectorAll('.subtab').forEach(tab => tab.classList.remove('active'));
      const section = document.getElementById('subtab-' + target);
      if (section) section.classList.add('active');
      subTabs.forEach(node => {
        node.classList.remove('active');
      });
      btn.classList.add('active');
    }));

    function showMessage(text, kind) {
      const box = document.getElementById('message');
      if (!box) return;
      if (!text) {
        box.classList.add('d-none');
        box.textContent = '';
        box.className = 'alert d-none';
        return;
      }
      box.textContent = text;
      const tone = kind === 'error' ? 'danger' : 'success';
      box.className = 'alert alert-' + tone;
    }

    async function fetchStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('allowPrefixes').value = (data.allow_prefixes || []).join(', ');
      document.getElementById('pluginsRoot').value = data.plugins_root || '';
      document.getElementById('pluginsSourceRoot').value = data.plugins_source_root || '';
      document.getElementById('marketplacePathInput').value = data.marketplace_path || '';
      document.getElementById('registryPathInput').value = data.registry_path || '';
      document.getElementById('dbPathInput').value = data.db_path || '';
      loadModelConfigs(data);
      document.getElementById('aiTimeoutMs').value = valueOrEmpty(data.runtime_config && data.runtime_config.aiTimeoutMs);
      document.getElementById('aiMaxOutputBytes').value = valueOrEmpty(data.runtime_config && data.runtime_config.aiMaxOutputBytes);
      document.getElementById('aiToolMaxTurns').value = valueOrEmpty(data.runtime_config && data.runtime_config.aiToolMaxTurns);
      document.getElementById('commandTimeoutMs').value = valueOrEmpty(data.runtime_config && data.runtime_config.commandTimeoutMs);
      document.getElementById('commandMaxOutputBytes').value = valueOrEmpty(data.runtime_config && data.runtime_config.commandMaxOutputBytes);
      document.getElementById('marketplacePath').textContent = 'marketplace 路径: ' + (data.marketplace_path || '');
      renderMarketplaceStore(data.marketplaces || []);
    }

    function renderMarketplaceStore(list) {
      const body = document.querySelector('#marketplaceStoreTable tbody');
      body.innerHTML = '';
      list.forEach(item => {
        const tr = document.createElement('tr');
        const enabled = item.active ? 'checked' : '';
        tr.innerHTML = '<td>' + item.name + '</td>' +
          '<td>' + item.pluginCount + '</td>' +
          '<td>' + item.createdAt + '</td>' +
          '<td><input type="checkbox" data-toggle-marketplace="' + item.id + '" ' + enabled + ' /></td>' +
          '<td>' +
          '<button class="btn btn-outline-danger btn-sm" data-del="' + item.id + '">删除</button>' +
          '</td>';
        body.appendChild(tr);
      });
    }

    let jobs = [];
    let jobSessions = [];

    function parseJsonSafe(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    }

    function formatDuration(ms) {
      const num = Number(ms);
      if (!Number.isFinite(num) || num <= 0) return '';
      if (num < 1000) return num + ' ms';
      const sec = (num / 1000).toFixed(2);
      return sec + ' s';
    }

    function formatTime(iso) {
      if (!iso) return '';
      return String(iso).replace('T', ' ').replace('Z', '');
    }

    function renderJobSessions() {
      const list = document.getElementById('jobSessionList');
      if (!list) return;
      list.innerHTML = '';
      jobSessions.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.sessionId || '';
        opt.label = (item.sessionId || '') + ' (' + item.count + ')';
        list.appendChild(opt);
      });
    }

    async function fetchJobSessions() {
      const res = await fetch('/api/job_sessions');
      const data = await res.json();
      jobSessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderJobSessions();
    }

    function renderJobs() {
      const body = document.querySelector('#jobsTable tbody');
      if (!body) return;
      body.innerHTML = '';
      jobs.forEach(job => {
        const result = parseJsonSafe(job.resultJson);
        const duration = result && result.duration_ms ? formatDuration(result.duration_ms) : '';
        const errorText = job.error || (result && result.error) || '';
        const status = job.status || '';
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + formatTime(job.createdAt) + '</td>' +
          '<td>' + (job.sessionId || '') + '</td>' +
          '<td>' + (job.agentId || '') + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' + String(job.task || '').slice(0, 120) + '</td>' +
          '<td>' + duration + '</td>' +
          '<td>' + (errorText ? String(errorText).slice(0, 120) : '') + '</td>';
        body.appendChild(tr);
      });
    }

    function updateJobSessionState() {
      const allSessions = document.getElementById('jobAllSessions');
      const sessionInput = document.getElementById('jobSessionFilter');
      if (!allSessions || !sessionInput) return;
      sessionInput.disabled = allSessions.checked;
    }

    async function fetchJobs() {
      const sessionInput = document.getElementById('jobSessionFilter');
      const statusSelect = document.getElementById('jobStatusFilter');
      const allSessionsToggle = document.getElementById('jobAllSessions');
      const sessionId = sessionInput ? sessionInput.value.trim() : '';
      const status = statusSelect ? statusSelect.value : '';
      const allSessions = allSessionsToggle ? allSessionsToggle.checked : false;
      const params = new URLSearchParams();
      if (allSessions) params.set('all_sessions', '1');
      if (!allSessions && sessionId) params.set('session_id', sessionId);
      if (status) params.set('status', status);
      const qs = params.toString();
      const res = await fetch('/api/jobs' + (qs ? '?' + qs : ''));
      const data = await res.json();
      jobs = Array.isArray(data.jobs) ? data.jobs : [];
      renderJobs();
    }

    function valueOrEmpty(value) {
      if (value === null || value === undefined) return '';
      return String(value);
    }

    let modelConfigs = [];
    let activeModelId = '';
    let modelEditId = '';

    function loadModelConfigs(data) {
      let list = Array.isArray(data.model_configs) ? data.model_configs : [];
      if (!list.length && data.model_config) {
        const legacy = data.model_config || {};
        list = [{
          id: 'default',
          name: 'Default',
          api_key: legacy.api_key || '',
          base_url: legacy.base_url || '',
          model: legacy.model || '',
          reasoning_enabled: legacy.reasoning_enabled !== false
        }];
      }
      modelConfigs = list.map(entry => normalizeModelEntry(entry));
      activeModelId = data.active_model_id || (modelConfigs[0] && modelConfigs[0].id) || '';
      renderModels();
    }

    function normalizeModelEntry(entry) {
      const id = String(entry.id || '').trim() || ('model_' + Math.random().toString(36).slice(2, 8));
      return {
        id,
        name: String(entry.name || id),
        api_key: String(entry.api_key || ''),
        base_url: String(entry.base_url || ''),
        model: String(entry.model || ''),
        reasoning_enabled: entry.reasoning_enabled !== false
      };
    }

    function renderModels() {
      const body = document.querySelector('#modelTable tbody');
      body.innerHTML = '';
      modelConfigs.forEach(entry => {
        const tr = document.createElement('tr');
        const reasoning = entry.reasoning_enabled ? '开' : '关';
        const active = entry.id === activeModelId;
        const activeCell = active ? '<span class="badge text-bg-primary">当前</span>' : '<button class="btn btn-outline-primary btn-sm" data-activate="' + entry.id + '">设为当前</button>';
        tr.innerHTML = '<td>' + entry.name + '</td>' +
          '<td>' + entry.model + '</td>' +
          '<td>' + entry.base_url + '</td>' +
          '<td>' + reasoning + '</td>' +
          '<td>' + activeCell + '</td>' +
          '<td>' +
          '<button class="btn btn-outline-secondary btn-sm" data-model-edit="' + entry.id + '">编辑</button>' +
          '<button class="btn btn-outline-danger btn-sm" data-model-del="' + entry.id + '">删除</button>' +
          '</td>';
        body.appendChild(tr);
      });
    }

    function setModelForm(entry) {
      document.getElementById('modelNameInput').value = entry ? entry.name || '' : '';
      document.getElementById('modelApiKeyInput').value = entry ? entry.api_key || '' : '';
      document.getElementById('modelBaseUrlInput').value = entry ? entry.base_url || '' : '';
      document.getElementById('modelModelInput').value = entry ? entry.model || '' : '';
      document.getElementById('modelReasoningEnabled').checked = entry ? entry.reasoning_enabled !== false : true;
      modelEditId = entry ? entry.id : '';
      document.getElementById('modelFormTitle').textContent = entry ? '编辑模型' : '新增模型';
    }

    async function saveModelConfigs() {
      const payload = {
        models: modelConfigs,
        active_model_id: activeModelId
      };
      const res = await fetch('/api/model_settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || data.ok === false) {
        showMessage(data.error || '保存模型配置失败', 'error');
        return false;
      }
      showMessage('已保存模型配置', 'success');
      return true;
    }

    let mcpServers = [];
    let mcpEditId = '';
    let mcpModalOpen = false;

    async function fetchMcpServers() {
      const res = await fetch('/api/mcp_servers');
      const data = await res.json();
      mcpServers = Array.isArray(data.servers) ? data.servers : [];
      renderMcpServers();
    }

    function renderMcpServers() {
      const body = document.querySelector('#mcpTable tbody');
      body.innerHTML = '';
      mcpServers.forEach(entry => {
        const tr = document.createElement('tr');
        const argsText = Array.isArray(entry.args) ? entry.args.join(' ') : '';
        const target = entry.transport === 'stdio'
          ? entry.command
          : (entry.endpointUrl || entry.command || '');
        const configText = entry.transport === 'stdio'
          ? argsText
          : (entry.headersJson || '');
        const enabled = entry.enabled ? 'checked' : '';
        tr.innerHTML = '<td>' + entry.name + '</td>' +
          '<td>' + (entry.transport || '') + '</td>' +
          '<td>' + target + '</td>' +
          '<td>' + configText + '</td>' +
          '<td><input type="checkbox" data-toggle="' + entry.id + '" ' + enabled + ' /></td>' +
          '<td>' +
          '<button class="btn btn-outline-secondary btn-sm" data-edit="' + entry.id + '">编辑</button>' +
          '<button class="btn btn-outline-danger btn-sm" data-del="' + entry.id + '">删除</button>' +
          '</td>';
        body.appendChild(tr);
      });
    }

    function setMcpForm(entry) {
      document.getElementById('mcpName').value = entry ? entry.name || '' : '';
      document.getElementById('mcpTransport').value = entry ? entry.transport || 'stdio' : 'stdio';
      document.getElementById('mcpCommand').value = entry ? entry.command || '' : '';
      document.getElementById('mcpArgs').value = entry && Array.isArray(entry.args) ? entry.args.join(' ') : '';
      document.getElementById('mcpEndpoint').value = entry ? entry.endpointUrl || '' : '';
      document.getElementById('mcpHeaders').value = entry ? entry.headersJson || '' : '';
      document.getElementById('mcpEnabled').checked = entry ? !!entry.enabled : true;
      mcpEditId = entry ? entry.id : '';
      document.getElementById('mcpSave').textContent = entry ? '保存' : '新增';
      document.getElementById('mcpModalTitle').textContent = entry ? '编辑 MCP' : '新增 MCP';
      updateMcpTransport();
    }

    document.getElementById('saveAllow').onclick = async () => {
      const raw = document.getElementById('allowPrefixes').value || '';
      const prefixes = raw.split(',').map(s => s.trim()).filter(Boolean);
      await fetch('/api/allow_prefixes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes })
      });
      await fetchStatus();
    };

    document.getElementById('jobRefresh').onclick = async () => {
      await fetchJobs();
    };
    document.getElementById('jobStatusFilter').onchange = async () => {
      await fetchJobs();
    };
    document.getElementById('jobSessionFilter').onchange = async () => {
      await fetchJobs();
    };
    document.getElementById('jobAllSessions').onchange = async () => {
      updateJobSessionState();
      await fetchJobs();
    };

    document.getElementById('saveSettings').onclick = async () => {
      const pluginsRoot = document.getElementById('pluginsRoot').value || '';
      const pluginsSourceRoot = document.getElementById('pluginsSourceRoot').value || '';
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugins_root: pluginsRoot, plugins_source_root: pluginsSourceRoot })
      });
      await fetchStatus();
      await fetchSummary();
    };

    document.getElementById('modelAdd').onclick = () => {
      setModelForm(null);
    };

    document.getElementById('modelSave').onclick = async () => {
      const name = document.getElementById('modelNameInput').value || '';
      const apiKey = document.getElementById('modelApiKeyInput').value || '';
      const baseUrl = document.getElementById('modelBaseUrlInput').value || '';
      const model = document.getElementById('modelModelInput').value || '';
      const reasoningEnabled = document.getElementById('modelReasoningEnabled').checked;
      if (!model) {
        showMessage('模型名称不能为空', 'error');
        return;
      }
      const entry = {
        id: modelEditId || ('model_' + Math.random().toString(36).slice(2, 8)),
        name: name || model,
        api_key: apiKey,
        base_url: baseUrl,
        model: model,
        reasoning_enabled: reasoningEnabled
      };
      const index = modelConfigs.findIndex(item => item.id === entry.id);
      if (index >= 0) {
        modelConfigs[index] = entry;
      } else {
        modelConfigs.unshift(entry);
      }
      if (!activeModelId) activeModelId = entry.id;
      if (await saveModelConfigs()) {
        setModelForm(null);
        await fetchStatus();
      }
    };

    document.getElementById('modelClear').onclick = () => {
      setModelForm(null);
    };

    document.getElementById('modelTable').onclick = async (event) => {
      const target = event.target;
      if (!target) return;
      const editId = target.getAttribute('data-model-edit');
      const delId = target.getAttribute('data-model-del');
      const activateId = target.getAttribute('data-activate');
      if (editId) {
        const entry = modelConfigs.find(item => item.id === editId);
        if (entry) setModelForm(entry);
        return;
      }
      if (activateId) {
        activeModelId = activateId;
        if (await saveModelConfigs()) {
          await fetchStatus();
        }
        return;
      }
      if (delId) {
        modelConfigs = modelConfigs.filter(item => item.id !== delId);
        if (activeModelId === delId) {
          activeModelId = (modelConfigs[0] && modelConfigs[0].id) || '';
        }
        if (await saveModelConfigs()) {
          await fetchStatus();
        }
      }
    };

    document.getElementById('saveRuntime').onclick = async () => {
      const aiTimeout = document.getElementById('aiTimeoutMs').value || '';
      const aiMax = document.getElementById('aiMaxOutputBytes').value || '';
      const aiToolMax = document.getElementById('aiToolMaxTurns').value || '';
      const cmdTimeout = document.getElementById('commandTimeoutMs').value || '';
      const cmdMax = document.getElementById('commandMaxOutputBytes').value || '';
      const res = await fetch('/api/runtime_settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ai_timeout_ms: aiTimeout,
          ai_max_output_bytes: aiMax,
          ai_tool_max_turns: aiToolMax,
          command_timeout_ms: cmdTimeout,
          command_max_output_bytes: cmdMax
        })
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || data.ok === false) {
        showMessage(data.error || '保存运行参数失败', 'error');
        return;
      }
      showMessage('已保存运行参数', 'success');
      await fetchStatus();
    };

    document.getElementById('mcpSave').onclick = async () => {
      const name = document.getElementById('mcpName').value || '';
      const transport = document.getElementById('mcpTransport').value || 'stdio';
      const command = document.getElementById('mcpCommand').value || '';
      const args = document.getElementById('mcpArgs').value || '';
      const endpointUrl = document.getElementById('mcpEndpoint').value || '';
      const headersJson = document.getElementById('mcpHeaders').value || '';
      const enabled = document.getElementById('mcpEnabled').checked;
      const payload = {
        id: mcpEditId || undefined,
        name,
        transport,
        command,
        args,
        endpoint_url: endpointUrl,
        headers_json: headersJson,
        enabled
      };
      const res = await fetch('/api/mcp_servers/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || data.ok === false) {
        showMessage(data.error || '保存失败', 'error');
        return;
      }
      showMessage('已保存 MCP 服务', 'success');
      setMcpForm(null);
      await fetchMcpServers();
      closeMcpModal();
    };

    document.getElementById('mcpClear').onclick = () => {
      setMcpForm(null);
    };

    document.getElementById('mcpTable').onclick = async (event) => {
      const target = event.target;
      if (!target) return;
      const editId = target.getAttribute('data-edit');
      const delId = target.getAttribute('data-del');
      if (editId) {
        const entry = mcpServers.find(item => item.id === editId);
        if (entry) {
          setMcpForm(entry);
          openMcpModal();
        }
        return;
      }
      if (delId) {
        if (!confirm('确认删除该 MCP 服务吗？')) return;
        await fetch('/api/mcp_servers/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: delId })
        });
        await fetchMcpServers();
      }
    };

    document.getElementById('mcpTable').onchange = async (event) => {
      const target = event.target;
      if (!target) return;
      const toggleId = target.getAttribute('data-toggle');
      if (!toggleId) return;
      const entry = mcpServers.find(item => item.id === toggleId);
      if (!entry) return;
      const payload = {
        id: entry.id,
        name: entry.name,
        transport: entry.transport,
        command: entry.command,
        args: entry.args || [],
        endpoint_url: entry.endpointUrl || '',
        headers_json: entry.headersJson || '',
        enabled: target.checked
      };
      const res = await fetch('/api/mcp_servers/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || data.ok === false) {
        showMessage(data.error || '更新失败', 'error');
      } else {
        showMessage('已更新 MCP 服务', 'success');
      }
      await fetchMcpServers();
    };

    function openMcpModal() {
      const modal = document.getElementById('mcpModal');
      if (!modal) return;
      modal.classList.add('active');
      mcpModalOpen = true;
    }

    function closeMcpModal() {
      const modal = document.getElementById('mcpModal');
      if (!modal) return;
      modal.classList.remove('active');
      mcpModalOpen = false;
    }

    function updateMcpTransport() {
      const transport = document.getElementById('mcpTransport').value || 'stdio';
      document.getElementById('mcpTransportHint').textContent = transport;
      const stdioFields = document.getElementById('mcpStdioFields');
      const httpFields = document.getElementById('mcpHttpFields');
      if (transport === 'stdio') {
        stdioFields.style.display = 'block';
        httpFields.style.display = 'none';
      } else {
        stdioFields.style.display = 'none';
        httpFields.style.display = 'block';
      }
    }

    document.getElementById('mcpOpenModal').onclick = () => {
      setMcpForm(null);
      openMcpModal();
    };

    document.getElementById('mcpCloseModal').onclick = () => {
      closeMcpModal();
    };

    document.getElementById('mcpModal').onclick = (event) => {
      if (event.target && event.target.id === 'mcpModal') {
        closeMcpModal();
      }
    };

    document.getElementById('mcpTransport').onchange = () => {
      updateMcpTransport();
    };

    document.getElementById('uploadMarketplace').onclick = async () => {
      const fileInput = document.getElementById('marketplaceFile');
      if (!fileInput.files || !fileInput.files[0]) return;
      const file = fileInput.files[0];
      const text = await file.text();
      const payload = { name: file.name, json: text, activate: true };
      await fetch('/api/marketplace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await fetchStatus();
      await fetchSummary();
    };

    document.getElementById('marketplaceStoreTable').onclick = async (event) => {
      const target = event.target;
      if (!target) return;
      const delId = target.getAttribute('data-del');
      if (delId) {
        await fetch('/api/marketplace/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: delId })
        });
        await fetchStatus();
        await fetchSummary();
      }
    };

    document.getElementById('marketplaceStoreTable').onchange = async (event) => {
      const target = event.target;
      if (!target) return;
      const toggleId = target.getAttribute('data-toggle-marketplace');
      if (!toggleId) return;
      await fetch('/api/marketplace/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: toggleId, active: target.checked })
      });
      await fetchStatus();
      await fetchSummary();
    };

    document.getElementById('pluginsTable').onclick = async (event) => {
      const target = event.target;
      if (!target) return;
      const installSource = target.getAttribute('data-install');
      if (installSource) {
        const res = await fetch('/api/plugins/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: installSource })
        });
        let data = {};
        try { data = await res.json(); } catch {}
        if (!res.ok || data.ok === false) {
          showMessage(data.error || '安装失败', 'error');
        } else {
          showMessage('安装成功', 'success');
        }
        await fetchSummary();
      }
    };

    document.getElementById('installMissing').onclick = async () => {
      const res = await fetch('/api/plugins/install_missing', { method: 'POST' });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok || data.ok === false) {
        showMessage(data.error || '批量安装失败', 'error');
      } else {
        const failures = Array.isArray(data.results)
          ? data.results.filter(item => !item.ok).length
          : 0;
        if (failures > 0) {
          showMessage('批量安装完成，但有失败项，请查看控制台或逐个安装。', 'error');
        } else {
          showMessage('批量安装完成', 'success');
        }
      }
      await fetchSummary();
    };

    async function fetchSummary() {
      const res = await fetch('/api/marketplace/summary');
      const data = await res.json();
      if (!data || !data.plugins) return;
      const summary = document.getElementById('marketplaceSummary');
      summary.innerHTML = [
        '<span class="badge text-bg-secondary">Agents: ' + data.counts.agents.available + '/' + data.counts.agents.total + '</span>',
        '<span class="badge text-bg-secondary">Skills: ' + data.counts.skills.available + '/' + data.counts.skills.total + '</span>',
        '<span class="badge text-bg-secondary">Commands: ' + data.counts.commands.available + '/' + data.counts.commands.total + '</span>'
      ].join(' ');
      const tbody = document.querySelector('#pluginsTable tbody');
      tbody.innerHTML = '';
      data.plugins.forEach(plugin => {
        const tr = document.createElement('tr');
        const status = plugin.exists ? '可用' : '<span class="missing">缺失</span>';
        const installBtn = plugin.exists ? '' : '<button class="btn btn-primary btn-sm" data-install="' + plugin.source + '">一键安装</button>';
        tr.innerHTML = '<td>' + plugin.name + '</td>' +
          '<td>' + (plugin.category || '') + '</td>' +
          '<td>' + plugin.counts.agents.available + '/' + plugin.counts.agents.total + '</td>' +
          '<td>' + plugin.counts.skills.available + '/' + plugin.counts.skills.total + '</td>' +
          '<td>' + plugin.counts.commands.available + '/' + plugin.counts.commands.total + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' + installBtn + '</td>';
        tbody.appendChild(tr);
      });
      const details = document.getElementById('marketplaceDetails');
      details.innerHTML = data.plugins.map(plugin => {
        const meta = [
          plugin.description ? '<div class="muted">' + plugin.description + '</div>' : '',
          plugin.repository ? '<div class="muted">repo: ' + plugin.repository + '</div>' : '',
          plugin.version ? '<div class="muted">version: ' + plugin.version + '</div>' : ''
        ].join('');
        return '<details class="card">' +
          '<summary>' + plugin.name + ' (' + plugin.counts.agents.available + '/' + plugin.counts.agents.total + ' agents)</summary>' +
          meta +
          renderList('Agents', plugin.agents) +
          renderList('Skills', plugin.skills) +
          renderList('Commands', plugin.commands) +
          '</details>';
      }).join('');
    }

    function renderList(title, items) {
      if (!items || items.length === 0) return '<div class="muted">' + title + ': none</div>';
      const rows = items.map(item => {
        const status = item.exists ? '' : ' missing';
        return '<li class="' + status + '">' + item.id + (item.title ? ' - ' + item.title : '') + '</li>';
      }).join('');
      return '<div class="section-title">' + title + '</div><ul class="list">' + rows + '</ul>';
    }

    fetchStatus();
    fetchSummary();
    fetchMcpServers();
    fetchJobSessions();
    updateJobSessionState();
    fetchJobs();
    setMcpForm(null);
  </script>
</body>
</html>`;
}

function buildMarketplaceSummary(options: AdminServerOptions): MarketplaceSummary {
  const raw = loadMarketplaceJson(options);
  const plugins = Array.isArray(raw?.plugins) ? raw.plugins : [];
  const marketplaceDir = options.marketplacePath ? path.dirname(options.marketplacePath) : process.cwd();
  const pluginsRoot = options.configStore.getPluginsRoot() || options.pluginsRoot || marketplaceDir;
  const summaryPlugins: PluginSummary[] = plugins.map((plugin: any) => {
    const source = String(plugin.source || '').trim();
    const pluginRoot = resolvePluginRoot(source, pluginsRoot);
    const exists = source ? fs.existsSync(pluginRoot) : false;
    const agents = mapEntries(pluginRoot, plugin.agents || []);
    const skills = mapEntries(pluginRoot, plugin.skills || []);
    const commands = mapEntries(pluginRoot, plugin.commands || []);
    return {
      name: plugin.name || source,
      source,
      category: plugin.category || '',
      description: plugin.description || '',
      version: plugin.version || '',
      repository: plugin.repository || '',
      homepage: plugin.homepage || '',
      exists,
      counts: {
        agents: countAvailability(agents),
        skills: countAvailability(skills),
        commands: countAvailability(commands),
      },
      agents,
      skills,
      commands,
    };
  });
  const counts = {
    agents: aggregateCounts(summaryPlugins, 'agents'),
    skills: aggregateCounts(summaryPlugins, 'skills'),
    commands: aggregateCounts(summaryPlugins, 'commands'),
  };
  return { plugins: summaryPlugins, counts };
}

function loadMarketplaceJson(options: AdminServerOptions) {
  const activeList = options.configStore.getActiveMarketplaces();
  if (activeList.length > 0) {
    return mergeMarketplaces(activeList);
  }
  const pathFromOption = options.marketplacePath;
  if (pathFromOption && fs.existsSync(pathFromOption)) {
    try {
      return JSON.parse(fs.readFileSync(pathFromOption, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function mergeMarketplaces(entries: Array<{ id: string; name: string; json: string }>) {
  const plugins: any[] = [];
  const seen = new Set<string>();
  const sources = [];
  for (const entry of entries) {
    const parsed = safeParse(entry.json);
    const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    sources.push({ id: entry.id, name: entry.name, plugins: list.length });
    for (const plugin of list) {
      const key = buildPluginKey(plugin);
      if (seen.has(key)) continue;
      seen.add(key);
      plugins.push(plugin);
    }
  }
  return {
    name: 'merged-marketplace',
    metadata: {
      merged: true,
      sources,
    },
    plugins,
  };
}

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function buildPluginKey(plugin: any): string {
  const source = String(plugin?.source || '').trim();
  const name = String(plugin?.name || '').trim();
  if (source) return `source:${source}`;
  if (name) return `name:${name}`;
  return JSON.stringify(plugin || {});
}

function resolvePluginRoot(source: string, root: string): string {
  if (!source) return root;
  if (path.isAbsolute(source)) return source;
  return path.resolve(root, source);
}

function mapEntries(pluginRoot: string, entries: string[]): EntrySummary[] {
  const list: EntrySummary[] = [];
  for (const entry of entries || []) {
    const resolved = resolveMarkdownPath(pluginRoot, entry);
    const exists = resolved ? fs.existsSync(resolved) : false;
    const title = exists ? readMarkdownTitle(resolved) : '';
    list.push({
      id: deriveId(resolved || entry),
      title,
      path: resolved,
      exists,
    });
  }
  return list;
}

function resolveMarkdownPath(root: string, rawPath: string): string {
  if (!rawPath) return '';
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '';
  if (path.isAbsolute(trimmed)) return trimmed;
  let resolved = path.resolve(root, trimmed);
  if (fs.existsSync(resolved)) return resolved;
  if (!path.extname(resolved)) {
    const withMd = `${resolved}.md`;
    if (fs.existsSync(withMd)) return withMd;
    const withSkill = path.join(resolved, 'SKILL.md');
    if (fs.existsSync(withSkill)) return withSkill;
    const withIndex = path.join(resolved, 'index.md');
    if (fs.existsSync(withIndex)) return withIndex;
  }
  return resolved;
}

function readMarkdownTitle(filePath: string): string {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.trim().startsWith('#'));
    return line ? line.replace(/^#+\s*/, '').trim() : '';
  } catch {
    return '';
  }
}

function deriveId(resolvedPath: string): string {
  const base = path.basename(resolvedPath);
  const lower = base.toLowerCase();
  let raw = '';
  if (lower === 'skill.md' || lower === 'index.md') {
    raw = path.basename(path.dirname(resolvedPath));
  } else {
    raw = path.basename(resolvedPath, path.extname(resolvedPath));
  }
  return slugify(raw);
}

function slugify(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function countAvailability(items: Array<{ exists: boolean }>): { total: number; available: number } {
  const total = items.length;
  const available = items.filter((item) => item.exists).length;
  return { total, available };
}

function aggregateCounts(plugins: PluginSummary[], key: 'agents' | 'skills' | 'commands') {
  return plugins.reduce(
    (acc, plugin) => {
      acc.total += plugin.counts[key].total;
      acc.available += plugin.counts[key].available;
      return acc;
    },
    { total: 0, available: 0 }
  );
}

function copyDir(src: string, dest: string) {
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

async function installPlugin(options: AdminServerOptions, plugin: PluginSummary, summary: MarketplaceSummary) {
  const marketplaceDir = options.marketplacePath ? path.dirname(options.marketplacePath) : process.cwd();
  const destRoot = options.configStore.getPluginsRoot() || options.pluginsRoot || marketplaceDir;
  const sourceRoot = options.configStore.getPluginsSourceRoot() || marketplaceDir;
  if (!destRoot) return { ok: false, error: 'plugins_root not set' };
  const source = plugin.source;
  const destPath = resolvePluginRoot(source, destRoot);
  if (fs.existsSync(destPath)) {
    return { ok: true, installed: true, method: 'exists' };
  }
  const srcPath = resolvePluginRoot(source, sourceRoot);
  if (fs.existsSync(srcPath)) {
    copyDir(srcPath, destPath);
    return { ok: true, installed: true, method: 'local' };
  }
  const repoUrl = plugin.repository || plugin.homepage || '';
  if (!repoUrl) {
    return {
      ok: false,
      error: `source plugin not found: ${srcPath}. Set plugins_source_root or provide repository in marketplace.json.`,
    };
  }
  const gitRoot = resolveGitCacheRoot(options, marketplaceDir);
  const repoPath = await ensureGitRepo(repoUrl, gitRoot);
  const repoPluginPath = resolvePluginRoot(source, repoPath);
  if (!fs.existsSync(repoPluginPath)) {
    return { ok: false, error: `plugin path not found in repo: ${repoPluginPath}` };
  }
  copyDir(repoPluginPath, destPath);
  return { ok: true, installed: true, method: 'git' };
}

function resolveGitCacheRoot(options: AdminServerOptions, marketplaceDir: string): string {
  const dbPath = options.configStore.getDbPath();
  if (dbPath) {
    return path.join(path.dirname(dbPath), 'git-cache');
  }
  return path.join(marketplaceDir, 'git-cache');
}

async function ensureGitRepo(repoUrl: string, cacheRoot: string): Promise<string> {
  const safeName = sanitizeRepoName(repoUrl);
  const repoPath = path.join(cacheRoot, safeName);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const gitDir = path.join(repoPath, '.git');
  if (fs.existsSync(gitDir)) {
    try {
      await updateGitRepo(repoPath);
      return repoPath;
    } catch {
      try {
        fs.rmSync(repoPath, { recursive: true, force: true });
      } catch {}
    }
  } else if (fs.existsSync(repoPath)) {
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {}
  }
  await runGit(['clone', '--depth', '1', repoUrl, repoPath]);
  return repoPath;
}

async function updateGitRepo(repoPath: string) {
  try {
    await runGit(['-C', repoPath, 'pull', '--ff-only']);
    return;
  } catch {
    // fall back to hard reset against origin/HEAD or common defaults
  }
  await runGit(['-C', repoPath, 'fetch', '--all', '--prune']);
  const originHead = await resolveOriginHead(repoPath);
  if (originHead) {
    await runGit(['-C', repoPath, 'reset', '--hard', originHead]);
    return;
  }
  try {
    await runGit(['-C', repoPath, 'reset', '--hard', 'origin/main']);
    return;
  } catch {}
  await runGit(['-C', repoPath, 'reset', '--hard', 'origin/master']);
}

function sanitizeRepoName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/[:/]/g, '-')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'repo';
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
    }
    child.on('error', (err: Error) => {
      reject(new Error(`git failed: ${err.message}`));
    });
    child.on('close', (code: number) => {
      if (code === 0) return resolve();
      reject(new Error(`git exited with code ${code}: ${stderr}`));
    });
  });
}

async function resolveOriginHead(repoPath: string): Promise<string> {
  try {
    const result = await runGitCapture(['-C', repoPath, 'rev-parse', '--abbrev-ref', 'origin/HEAD']);
    const ref = String(result.stdout || '').trim();
    if (ref && ref !== 'origin/HEAD') return ref;
  } catch {}
  return '';
}

function runGitCapture(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
    }
    child.on('error', (err: Error) => {
      reject(new Error(`git failed: ${err.message}`));
    });
    child.on('close', (code: number) => {
      if (code === 0) return resolve({ stdout, stderr, code });
      reject(new Error(`git exited with code ${code}: ${stderr}`));
    });
  });
}
