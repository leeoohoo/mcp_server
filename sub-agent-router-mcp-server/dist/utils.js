import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
export function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const result = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (!token.startsWith('-')) {
            result._.push(token);
            continue;
        }
        const isLong = token.startsWith('--');
        const key = isLong ? token.slice(2) : token.slice(1);
        if (!key)
            continue;
        const [name, inline] = key.split('=');
        if (inline !== undefined) {
            result[name] = inline;
            continue;
        }
        const next = args[i + 1];
        if (next && !next.startsWith('-')) {
            result[name] = next;
            i += 1;
        }
        else {
            result[name] = true;
        }
    }
    return result;
}
export function normalizeName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'subagent_router';
}
export function normalizeId(value) {
    return typeof value === 'string' ? value.trim() : '';
}
export function generateId(prefix) {
    const safePrefix = normalizeName(prefix || 'id') || 'id';
    const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    return `${safePrefix}_${rand}`;
}
export function ensureDir(dirPath) {
    if (!dirPath)
        return;
    fs.mkdirSync(dirPath, { recursive: true });
}
export function getHomeDir() {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    return typeof home === 'string' && home.trim() ? home.trim() : os.homedir();
}
export function resolveStateDir(serverName) {
    const override = process.env.SUBAGENT_STATE_ROOT || process.env.MCP_STATE_ROOT || '';
    if (override && override.trim()) {
        return path.join(override.trim(), normalizeName(serverName));
    }
    const home = getHomeDir();
    const legacy = path.join(home, '.mcp_servers');
    const modern = path.join(home, '.mcp-servers');
    const base = fs.existsSync(legacy) ? legacy : modern;
    return path.join(base, normalizeName(serverName));
}
export function safeJsonParse(raw, fallback) {
    try {
        const parsed = JSON.parse(raw);
        return parsed;
    }
    catch {
        return fallback;
    }
}
export function tokenize(text) {
    const raw = typeof text === 'string' ? text.toLowerCase().trim() : '';
    if (!raw)
        return [];
    return raw.split(/[\s,;|/]+/).filter(Boolean);
}
export function parseCommand(input) {
    if (!input)
        return null;
    const text = String(input || '').trim();
    if (!text)
        return null;
    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return parsed.map((entry) => String(entry));
            }
        }
        catch {
            // fall through
        }
    }
    return splitCommand(text);
}
function splitCommand(text) {
    const args = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escape = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            escape = true;
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if (!inSingle && !inDouble && /\s/.test(ch)) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current)
        args.push(current);
    return args;
}
