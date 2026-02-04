import path from 'node:path';
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
export function normalizeName(value, fallback) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || fallback;
}
export function normalizeId(value) {
    return typeof value === 'string' ? value.trim() : '';
}
export function parseCsv(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value !== 'string')
        return [];
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}
export function clampNumber(value, min, max, fallback) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num))
        return fallback;
    return Math.min(Math.max(num, min), max);
}
export function resolveWithinRoot(root, target) {
    return path.resolve(root, target);
}
export function isSubpath(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
export function getCommandRoot(command) {
    const trimmed = command.trim();
    if (!trimmed)
        return '';
    return trimmed.split(/\s+/)[0] || '';
}
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
        value /= 1024;
        idx += 1;
    }
    return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}
