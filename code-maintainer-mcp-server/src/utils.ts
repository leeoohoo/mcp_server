import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type ParsedArgs = { _: string[] } & Record<string, string | boolean | string[] | undefined>;

export function parseArgs(argv: string[]): ParsedArgs {
  const args = Array.isArray(argv) ? argv : [];
  const result: ParsedArgs = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('-')) {
      result._.push(token);
      continue;
    }
    const isLong = token.startsWith('--');
    const key = isLong ? token.slice(2) : token.slice(1);
    if (!key) continue;
    const [name, inline] = key.split('=');
    if (inline !== undefined) {
      result[name] = inline;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith('-')) {
      result[name] = next;
      i += 1;
    } else {
      result[name] = true;
    }
  }
  return result;
}

export function ensureDir(dirPath: string) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

export function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'code_maintainer';
}

export function generateId(prefix: string): string {
  const safePrefix = normalizeName(prefix || 'id') || 'id';
  const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  return `${safePrefix}_${rand}`;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

export function getHomeDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return typeof home === 'string' && home.trim() ? home.trim() : os.homedir();
}

export function resolveStateDir(serverName: string): string {
  const base = process.env.MCP_STATE_ROOT && process.env.MCP_STATE_ROOT.trim()
    ? process.env.MCP_STATE_ROOT.trim()
    : path.join(getHomeDir(), '.mcp-servers');
  return path.join(base, normalizeName(serverName));
}

export function ensurePathInsideRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
    throw new Error(`Path is خارج workspace root: ${target}`);
  }
  return resolvedTarget;
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value < 10 && idx > 0 ? 1 : 0)} ${units[idx]}`;
}
