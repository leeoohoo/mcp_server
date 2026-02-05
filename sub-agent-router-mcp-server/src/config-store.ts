import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ensureDir, generateId } from './utils.js';
import { McpServerConfig } from './types.js';

export interface ConfigStoreOptions {
  marketplacePath?: string;
}

export interface MarketplaceRecord {
  id: string;
  name: string;
  pluginCount: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfigRecord {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEnabled: boolean;
  responsesEnabled: boolean;
}

type DbMcpServerRow = {
  id: string;
  name: string;
  transport: string;
  command: string;
  args_json: string | null;
  endpoint_url: string | null;
  headers_json: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export class ConfigStore {
  private db: Database.Database;
  private marketplacePath?: string;

  constructor(dbPath: string, options: ConfigStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.marketplacePath = options.marketplacePath;
    this.init();
  }

  private init() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subagent_marketplaces (
        id TEXT PRIMARY KEY,
        name TEXT,
        json TEXT NOT NULL,
        plugin_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS subagent_marketplaces_active_idx ON subagent_marketplaces(active);

      CREATE TABLE IF NOT EXISTS subagent_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT,
        endpoint_url TEXT,
        headers_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS subagent_mcp_servers_enabled_idx ON subagent_mcp_servers(enabled);
    `);
    this.ensureColumn('subagent_mcp_servers', 'endpoint_url', 'TEXT');
    this.ensureColumn('subagent_mcp_servers', 'headers_json', 'TEXT');
  }

  private ensureColumn(table: string, column: string, type: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    const safeType = type || 'TEXT';
    this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${safeType}`).run();
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM subagent_settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row?.value_json) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO subagent_settings (key, value_json, updated_at) VALUES (@key, @value, @updated) ON CONFLICT(key) DO UPDATE SET value_json = @value, updated_at = @updated'
    );
    stmt.run({
      key,
      value: JSON.stringify(value ?? null),
      updated: now,
    });
  }

  getAllowPrefixes(): string[] {
    const parsed = this.getSetting<string[]>('mcp_allow_prefixes', []);
    return Array.isArray(parsed) ? parsed.map((p) => String(p || '').trim()).filter(Boolean) : [];
  }

  setAllowPrefixes(prefixes: string[]) {
    const cleaned = Array.isArray(prefixes) ? prefixes.map((p) => String(p || '').trim()).filter(Boolean) : [];
    this.setSetting('mcp_allow_prefixes', cleaned);
  }

  getEffectiveAllowPrefixes(): string[] {
    const manual = this.getAllowPrefixes();
    if (manual.length > 0) return manual;
    const servers = this.listMcpServers().filter((entry) => entry.enabled);
    const prefixes = servers
      .map((entry) => normalizeMcpName(entry.name))
      .filter(Boolean)
      .map((name) => `mcp_${name}_`);
    return Array.from(new Set(prefixes));
  }

  getPluginsRoot(): string {
    return String(this.getSetting('plugins_root', '') || '');
  }

  setPluginsRoot(value: string) {
    this.setSetting('plugins_root', value);
  }

  getPluginsSourceRoot(): string {
    return String(this.getSetting('plugins_source_root', '') || '');
  }

  setPluginsSourceRoot(value: string) {
    this.setSetting('plugins_source_root', value);
  }


  getMarketplacePath(): string {
    return String(this.getSetting('marketplace_path', '') || '');
  }

  setMarketplacePath(value: string) {
    this.setSetting('marketplace_path', value);
  }

  getRegistryPath(): string {
    return String(this.getSetting('registry_path', '') || '');
  }

  setRegistryPath(value: string) {
    this.setSetting('registry_path', value);
  }

  getDbPath(): string {
    return String(this.getSetting('db_path', '') || '');
  }

  setDbPath(value: string) {
    this.setSetting('db_path', value);
  }

  getModelConfig(): { apiKey: string; baseUrl: string; model: string; reasoningEnabled: boolean; responsesEnabled: boolean } {
    const active = this.getActiveModelConfig();
    return {
      apiKey: active.apiKey,
      baseUrl: active.baseUrl,
      model: active.model,
      reasoningEnabled: active.reasoningEnabled,
      responsesEnabled: active.responsesEnabled,
    };
  }

  setModelConfig(input: { apiKey?: string; baseUrl?: string; model?: string; reasoningEnabled?: boolean; responsesEnabled?: boolean }) {
    const next = {
      apiKey: String(input?.apiKey || '').trim(),
      baseUrl: String(input?.baseUrl || '').trim(),
      model: String(input?.model || '').trim(),
      reasoningEnabled: input?.reasoningEnabled !== false,
      responsesEnabled: input?.responsesEnabled === true,
    };
    const legacyId = 'default';
    this.setModelConfigs([
      {
        id: legacyId,
        name: 'Default',
        apiKey: next.apiKey,
        baseUrl: next.baseUrl,
        model: next.model,
        reasoningEnabled: next.reasoningEnabled,
        responsesEnabled: next.responsesEnabled,
      },
    ]);
    this.setActiveModelId(legacyId);
    this.setSetting('model_config', next);
  }

  getModelConfigs(): ModelConfigRecord[] {
    const parsed = this.getSetting<ModelConfigRecord[]>('model_configs', []);
    const cleaned = Array.isArray(parsed)
      ? parsed
          .map((entry) => normalizeModelConfig(entry))
          .filter((entry) => entry.model || entry.baseUrl || entry.apiKey)
      : [];
    if (cleaned.length > 0) return cleaned;
    const legacy = this.getSetting('model_config', null) as
      | { apiKey?: string; baseUrl?: string; model?: string; reasoningEnabled?: boolean; responsesEnabled?: boolean }
      | null;
    if (!legacy) return [];
    const apiKey = String(legacy.apiKey || '').trim();
    const baseUrl = String(legacy.baseUrl || '').trim();
    const model = String(legacy.model || '').trim();
    if (!apiKey && !baseUrl && !model) return [];
    return [
      {
        id: 'default',
        name: 'Default',
        apiKey,
        baseUrl,
        model,
        reasoningEnabled: legacy.reasoningEnabled !== false,
        responsesEnabled: legacy.responsesEnabled === true,
      },
    ];
  }

  setModelConfigs(list: ModelConfigRecord[]) {
    const cleaned = Array.isArray(list) ? list.map((entry) => normalizeModelConfig(entry)).filter((entry) => entry.id) : [];
    this.setSetting('model_configs', cleaned);
  }

  getActiveModelId(): string {
    return String(this.getSetting('active_model_id', '') || '').trim();
  }

  setActiveModelId(id: string) {
    this.setSetting('active_model_id', String(id || '').trim());
  }

  getActiveModelConfig(): ModelConfigRecord {
    const configs = this.getModelConfigs();
    const activeId = this.getActiveModelId();
    const found = configs.find((entry) => entry.id === activeId) || configs[0];
    if (found) return found;
    return {
      id: 'default',
      name: 'Default',
      apiKey: '',
      baseUrl: '',
      model: '',
      reasoningEnabled: true,
      responsesEnabled: false,
    };
  }

  getRuntimeConfig(): {
    aiTimeoutMs?: number;
    aiMaxOutputBytes?: number;
    aiToolMaxTurns?: number;
    aiMaxRetries?: number;
    commandTimeoutMs?: number;
    commandMaxOutputBytes?: number;
  } {
    const parsed = this.getSetting('runtime_config', {}) as Record<string, unknown>;
    return {
      aiTimeoutMs: parseNumber(parsed?.aiTimeoutMs),
      aiMaxOutputBytes: parseNumber(parsed?.aiMaxOutputBytes),
      aiToolMaxTurns: parseNumber(parsed?.aiToolMaxTurns),
      aiMaxRetries: parseNumber(parsed?.aiMaxRetries),
      commandTimeoutMs: parseNumber(parsed?.commandTimeoutMs),
      commandMaxOutputBytes: parseNumber(parsed?.commandMaxOutputBytes),
    };
  }

  setRuntimeConfig(input: {
    aiTimeoutMs?: number;
    aiMaxOutputBytes?: number;
    aiToolMaxTurns?: number;
    aiMaxRetries?: number;
    commandTimeoutMs?: number;
    commandMaxOutputBytes?: number;
  }) {
    const next = {
      aiTimeoutMs: sanitizeNumber(input.aiTimeoutMs),
      aiMaxOutputBytes: sanitizeNumber(input.aiMaxOutputBytes),
      aiToolMaxTurns: sanitizeNumber(input.aiToolMaxTurns),
      aiMaxRetries: sanitizeNumber(input.aiMaxRetries),
      commandTimeoutMs: sanitizeNumber(input.commandTimeoutMs),
      commandMaxOutputBytes: sanitizeNumber(input.commandMaxOutputBytes),
    };
    this.setSetting('runtime_config', next);
  }

  listMcpServers(): McpServerConfig[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, transport, command, args_json, endpoint_url, headers_json, enabled, created_at, updated_at FROM subagent_mcp_servers ORDER BY created_at DESC'
      )
      .all() as DbMcpServerRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: parseArgsJson(row.args_json),
      endpointUrl: row.endpoint_url || '',
      headersJson: row.headers_json || '',
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  saveMcpServer(input: {
    id?: string;
    name: string;
    transport: string;
    command: string;
    args?: string[];
    endpointUrl?: string;
    headersJson?: string;
    enabled?: boolean;
  }): string {
    const now = new Date().toISOString();
    const normalizedName = String(input.name || '').trim();
    const normalizedTransport = String(input.transport || '').trim() || 'stdio';
    const normalizedCommand = String(input.command || '').trim();
    const argsJson = JSON.stringify(Array.isArray(input.args) ? input.args : []);
    const endpointUrl = String(input.endpointUrl || '').trim();
    const headersJson = String(input.headersJson || '').trim();
    const enabled = input.enabled === false ? 0 : 1;
    if (input.id) {
      const stmt = this.db.prepare(
        `UPDATE subagent_mcp_servers
         SET name = @name,
             transport = @transport,
             command = @command,
             args_json = @args_json,
             endpoint_url = @endpoint_url,
             headers_json = @headers_json,
             enabled = @enabled,
             updated_at = @updated_at
         WHERE id = @id`
      );
      stmt.run({
        id: input.id,
        name: normalizedName,
        transport: normalizedTransport,
        command: normalizedCommand,
        args_json: argsJson,
        endpoint_url: endpointUrl,
        headers_json: headersJson,
        enabled,
        updated_at: now,
      });
      return input.id;
    }
    const id = generateId('mcp');
    const stmt = this.db.prepare(
      `INSERT INTO subagent_mcp_servers
        (id, name, transport, command, args_json, endpoint_url, headers_json, enabled, created_at, updated_at)
       VALUES (@id, @name, @transport, @command, @args_json, @endpoint_url, @headers_json, @enabled, @created_at, @updated_at)`
    );
    stmt.run({
      id,
      name: normalizedName,
      transport: normalizedTransport,
      command: normalizedCommand,
      args_json: argsJson,
      endpoint_url: endpointUrl,
      headers_json: headersJson,
      enabled,
      created_at: now,
      updated_at: now,
    });
    return id;
  }

  deleteMcpServer(id: string) {
    this.db.prepare('DELETE FROM subagent_mcp_servers WHERE id = ?').run(id);
  }

  listMarketplaces(): MarketplaceRecord[] {
    const rows = this.db.prepare(
      'SELECT id, name, plugin_count, active, created_at, updated_at FROM subagent_marketplaces ORDER BY created_at DESC'
    ).all() as Array<{
      id: string;
      name: string;
      plugin_count: number;
      active: number;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name || row.id,
      pluginCount: row.plugin_count || 0,
      active: row.active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getActiveMarketplaces(): Array<{ id: string; name: string; json: string }> {
    const rows = this.db
      .prepare('SELECT id, name, json FROM subagent_marketplaces WHERE active = 1 ORDER BY created_at DESC')
      .all() as Array<{ id: string; name: string; json: string }>;
    return rows || [];
  }

  saveMarketplace(input: { name?: string; json: string; activate?: boolean }) {
    const now = new Date().toISOString();
    const parsed = parseMarketplaceJson(input.json);
    const pluginCount = parsed.pluginCount;
    const id = generateId('marketplace');
    const stmt = this.db.prepare(
      `INSERT INTO subagent_marketplaces (id, name, json, plugin_count, created_at, updated_at, active)
       VALUES (@id, @name, @json, @plugin_count, @created_at, @updated_at, @active)`
    );
    stmt.run({
      id,
      name: input.name || `marketplace-${pluginCount}`,
      json: input.json,
      plugin_count: pluginCount,
      created_at: now,
      updated_at: now,
      active: input.activate ? 1 : 0,
    });
    if (input.activate) {
      this.setMarketplaceActive(id, true);
    }
    return id;
  }

  setMarketplaceActive(id: string, active: boolean) {
    const stmt = this.db.prepare('UPDATE subagent_marketplaces SET active = ? WHERE id = ?');
    stmt.run(active ? 1 : 0, id);
    this.ensureMarketplaceFile();
  }

  activateMarketplace(id: string) {
    this.setMarketplaceActive(id, true);
  }

  deleteMarketplace(id: string) {
    this.db.prepare('DELETE FROM subagent_marketplaces WHERE id = ?').run(id);
    this.ensureMarketplaceFile();
  }

  ensureMarketplaceFile() {
    if (!this.marketplacePath) return;
    const active = this.getActiveMarketplaces();
    if (!active || active.length === 0) {
      try {
        fs.unlinkSync(this.marketplacePath);
      } catch {}
      return;
    }
    const merged = mergeMarketplaces(active);
    this.writeMarketplaceFile(JSON.stringify(merged, null, 2));
  }

  writeMarketplaceFile(jsonText: string) {
    if (!this.marketplacePath) return;
    try {
      ensureDir(path.dirname(this.marketplacePath));
      fs.writeFileSync(this.marketplacePath, jsonText, 'utf8');
    } catch {
      // ignore
    }
  }
}

function parseMarketplaceJson(text: string): { pluginCount: number } {
  try {
    const parsed = JSON.parse(text);
    const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins.length : 0;
    return { pluginCount: plugins };
  } catch {
    throw new Error('Invalid marketplace.json (must be valid JSON with plugins array)');
  }
}

function parseArgsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function normalizeMcpName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseNumber(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  return num;
}

function sanitizeNumber(value: unknown): number | null {
  const num = parseNumber(value);
  if (num === undefined) return null;
  return num;
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

function normalizeModelConfig(input: Partial<ModelConfigRecord>): ModelConfigRecord {
  const id = String(input?.id || '').trim() || `model_${Math.random().toString(36).slice(2, 8)}`;
  const name = String(input?.name || '').trim() || id;
  const apiKey = String(input?.apiKey || '').trim();
  const baseUrl = String(input?.baseUrl || '').trim();
  const model = String(input?.model || '').trim();
  const reasoningEnabled = input?.reasoningEnabled !== false;
  const responsesEnabled = input?.responsesEnabled === true;
  return { id, name, apiKey, baseUrl, model, reasoningEnabled, responsesEnabled };
}
