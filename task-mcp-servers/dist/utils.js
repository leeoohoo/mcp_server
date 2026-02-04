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
    const base = process.env.MCP_STATE_ROOT && process.env.MCP_STATE_ROOT.trim()
        ? process.env.MCP_STATE_ROOT.trim()
        : path.join(getHomeDir(), '.mcp-servers');
    return path.join(base, normalizeName(serverName));
}
export function normalizeName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'task_manager';
}
export function generateId(prefix) {
    const safePrefix = normalizeName(prefix || 'id') || 'id';
    const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    return `${safePrefix}_${rand}`;
}
export function normalizeId(value) {
    return typeof value === 'string' ? value.trim() : '';
}
export function clampNumber(value, min, max, fallback) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num))
        return fallback;
    return Math.min(Math.max(num, min), max);
}
