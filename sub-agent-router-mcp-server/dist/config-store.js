import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ensureDir, generateId } from './utils.js';
export class ConfigStore {
    db;
    marketplacePath;
    constructor(dbPath, options = {}) {
        this.db = new Database(dbPath);
        this.marketplacePath = options.marketplacePath;
        this.init();
    }
    init() {
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
    ensureColumn(table, column, type) {
        const rows = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (rows.some((row) => row.name === column))
            return;
        const safeType = type || 'TEXT';
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${safeType}`).run();
    }
    getSetting(key, fallback) {
        const row = this.db.prepare('SELECT value_json FROM subagent_settings WHERE key = ?').get(key);
        if (!row?.value_json)
            return fallback;
        try {
            return JSON.parse(row.value_json);
        }
        catch {
            return fallback;
        }
    }
    setSetting(key, value) {
        const now = new Date().toISOString();
        const stmt = this.db.prepare('INSERT INTO subagent_settings (key, value_json, updated_at) VALUES (@key, @value, @updated) ON CONFLICT(key) DO UPDATE SET value_json = @value, updated_at = @updated');
        stmt.run({
            key,
            value: JSON.stringify(value ?? null),
            updated: now,
        });
    }
    getAllowPrefixes() {
        const parsed = this.getSetting('mcp_allow_prefixes', []);
        return Array.isArray(parsed) ? parsed.map((p) => String(p || '').trim()).filter(Boolean) : [];
    }
    setAllowPrefixes(prefixes) {
        const cleaned = Array.isArray(prefixes) ? prefixes.map((p) => String(p || '').trim()).filter(Boolean) : [];
        this.setSetting('mcp_allow_prefixes', cleaned);
    }
    getEffectiveAllowPrefixes() {
        const manual = this.getAllowPrefixes();
        if (manual.length > 0)
            return manual;
        const servers = this.listMcpServers().filter((entry) => entry.enabled);
        const prefixes = servers
            .map((entry) => normalizeMcpName(entry.name))
            .filter(Boolean)
            .map((name) => `mcp_${name}_`);
        return Array.from(new Set(prefixes));
    }
    getPluginsRoot() {
        return String(this.getSetting('plugins_root', '') || '');
    }
    setPluginsRoot(value) {
        this.setSetting('plugins_root', value);
    }
    getPluginsSourceRoot() {
        return String(this.getSetting('plugins_source_root', '') || '');
    }
    setPluginsSourceRoot(value) {
        this.setSetting('plugins_source_root', value);
    }
    getMarketplacePath() {
        return String(this.getSetting('marketplace_path', '') || '');
    }
    setMarketplacePath(value) {
        this.setSetting('marketplace_path', value);
    }
    getRegistryPath() {
        return String(this.getSetting('registry_path', '') || '');
    }
    setRegistryPath(value) {
        this.setSetting('registry_path', value);
    }
    getDbPath() {
        return String(this.getSetting('db_path', '') || '');
    }
    setDbPath(value) {
        this.setSetting('db_path', value);
    }
    getModelConfig() {
        const fallback = { apiKey: '', baseUrl: '', model: '' };
        const parsed = this.getSetting('model_config', fallback);
        return {
            apiKey: String(parsed?.apiKey || '').trim(),
            baseUrl: String(parsed?.baseUrl || '').trim(),
            model: String(parsed?.model || '').trim(),
        };
    }
    setModelConfig(input) {
        const next = {
            apiKey: String(input?.apiKey || '').trim(),
            baseUrl: String(input?.baseUrl || '').trim(),
            model: String(input?.model || '').trim(),
        };
        this.setSetting('model_config', next);
    }
    getRuntimeConfig() {
        const parsed = this.getSetting('runtime_config', {});
        return {
            aiTimeoutMs: parseNumber(parsed?.aiTimeoutMs),
            aiMaxOutputBytes: parseNumber(parsed?.aiMaxOutputBytes),
            commandTimeoutMs: parseNumber(parsed?.commandTimeoutMs),
            commandMaxOutputBytes: parseNumber(parsed?.commandMaxOutputBytes),
        };
    }
    setRuntimeConfig(input) {
        const next = {
            aiTimeoutMs: sanitizeNumber(input.aiTimeoutMs),
            aiMaxOutputBytes: sanitizeNumber(input.aiMaxOutputBytes),
            commandTimeoutMs: sanitizeNumber(input.commandTimeoutMs),
            commandMaxOutputBytes: sanitizeNumber(input.commandMaxOutputBytes),
        };
        this.setSetting('runtime_config', next);
    }
    listMcpServers() {
        const rows = this.db
            .prepare('SELECT id, name, transport, command, args_json, endpoint_url, headers_json, enabled, created_at, updated_at FROM subagent_mcp_servers ORDER BY created_at DESC')
            .all();
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
    saveMcpServer(input) {
        const now = new Date().toISOString();
        const normalizedName = String(input.name || '').trim();
        const normalizedTransport = String(input.transport || '').trim() || 'stdio';
        const normalizedCommand = String(input.command || '').trim();
        const argsJson = JSON.stringify(Array.isArray(input.args) ? input.args : []);
        const endpointUrl = String(input.endpointUrl || '').trim();
        const headersJson = String(input.headersJson || '').trim();
        const enabled = input.enabled === false ? 0 : 1;
        if (input.id) {
            const stmt = this.db.prepare(`UPDATE subagent_mcp_servers
         SET name = @name,
             transport = @transport,
             command = @command,
             args_json = @args_json,
             endpoint_url = @endpoint_url,
             headers_json = @headers_json,
             enabled = @enabled,
             updated_at = @updated_at
         WHERE id = @id`);
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
        const stmt = this.db.prepare(`INSERT INTO subagent_mcp_servers
        (id, name, transport, command, args_json, endpoint_url, headers_json, enabled, created_at, updated_at)
       VALUES (@id, @name, @transport, @command, @args_json, @endpoint_url, @headers_json, @enabled, @created_at, @updated_at)`);
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
    deleteMcpServer(id) {
        this.db.prepare('DELETE FROM subagent_mcp_servers WHERE id = ?').run(id);
    }
    listMarketplaces() {
        const rows = this.db.prepare('SELECT id, name, plugin_count, active, created_at, updated_at FROM subagent_marketplaces ORDER BY created_at DESC').all();
        return rows.map((row) => ({
            id: row.id,
            name: row.name || row.id,
            pluginCount: row.plugin_count || 0,
            active: row.active === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }
    getActiveMarketplaces() {
        const rows = this.db
            .prepare('SELECT id, name, json FROM subagent_marketplaces WHERE active = 1 ORDER BY created_at DESC')
            .all();
        return rows || [];
    }
    saveMarketplace(input) {
        const now = new Date().toISOString();
        const parsed = parseMarketplaceJson(input.json);
        const pluginCount = parsed.pluginCount;
        const id = generateId('marketplace');
        const stmt = this.db.prepare(`INSERT INTO subagent_marketplaces (id, name, json, plugin_count, created_at, updated_at, active)
       VALUES (@id, @name, @json, @plugin_count, @created_at, @updated_at, @active)`);
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
    setMarketplaceActive(id, active) {
        const stmt = this.db.prepare('UPDATE subagent_marketplaces SET active = ? WHERE id = ?');
        stmt.run(active ? 1 : 0, id);
        this.ensureMarketplaceFile();
    }
    activateMarketplace(id) {
        this.setMarketplaceActive(id, true);
    }
    deleteMarketplace(id) {
        this.db.prepare('DELETE FROM subagent_marketplaces WHERE id = ?').run(id);
        this.ensureMarketplaceFile();
    }
    ensureMarketplaceFile() {
        if (!this.marketplacePath)
            return;
        const active = this.getActiveMarketplaces();
        if (!active || active.length === 0) {
            try {
                fs.unlinkSync(this.marketplacePath);
            }
            catch { }
            return;
        }
        const merged = mergeMarketplaces(active);
        this.writeMarketplaceFile(JSON.stringify(merged, null, 2));
    }
    writeMarketplaceFile(jsonText) {
        if (!this.marketplacePath)
            return;
        try {
            ensureDir(path.dirname(this.marketplacePath));
            fs.writeFileSync(this.marketplacePath, jsonText, 'utf8');
        }
        catch {
            // ignore
        }
    }
}
function parseMarketplaceJson(text) {
    try {
        const parsed = JSON.parse(text);
        const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins.length : 0;
        return { pluginCount: plugins };
    }
    catch {
        throw new Error('Invalid marketplace.json (must be valid JSON with plugins array)');
    }
}
function parseArgsJson(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
    }
    catch {
        return [];
    }
}
function normalizeMcpName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}
function parseNumber(value) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num))
        return undefined;
    return num;
}
function sanitizeNumber(value) {
    const num = parseNumber(value);
    if (num === undefined)
        return null;
    return num;
}
function mergeMarketplaces(entries) {
    const plugins = [];
    const seen = new Set();
    const sources = [];
    for (const entry of entries) {
        const parsed = safeParse(entry.json);
        const list = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
        sources.push({ id: entry.id, name: entry.name, plugins: list.length });
        for (const plugin of list) {
            const key = buildPluginKey(plugin);
            if (seen.has(key))
                continue;
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
function safeParse(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function buildPluginKey(plugin) {
    const source = String(plugin?.source || '').trim();
    const name = String(plugin?.name || '').trim();
    if (source)
        return `source:${source}`;
    if (name)
        return `name:${name}`;
    return JSON.stringify(plugin || {});
}
