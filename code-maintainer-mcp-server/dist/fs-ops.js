import fs from 'fs';
import path from 'path';
import { ensurePathInsideRoot, isBinaryBuffer, sha256 } from './utils.js';
const fsp = fs.promises;
export class FsOps {
    root;
    allowWrites;
    maxFileBytes;
    maxWriteBytes;
    searchLimit;
    constructor(options) {
        this.root = path.resolve(options.root);
        this.allowWrites = options.allowWrites;
        this.maxFileBytes = options.maxFileBytes;
        this.maxWriteBytes = options.maxWriteBytes;
        this.searchLimit = options.searchLimit;
    }
    resolvePath(relPath) {
        const target = ensurePathInsideRoot(this.root, relPath || '.');
        return target;
    }
    async readFileRaw(relPath) {
        const target = this.resolvePath(relPath);
        const stats = await fsp.stat(target);
        if (!stats.isFile())
            throw new Error('Target is not a file.');
        if (stats.size > this.maxFileBytes) {
            throw new Error(`File too large (${stats.size} bytes).`);
        }
        const buffer = await fsp.readFile(target);
        if (isBinaryBuffer(buffer)) {
            throw new Error('Binary file not supported.');
        }
        return {
            content: buffer.toString('utf8'),
            size: stats.size,
            sha256: sha256(buffer),
            path: relPath,
        };
    }
    async readFileRange(relPath, start, end, withLineNumbers) {
        const raw = await this.readFileRaw(relPath);
        const lines = raw.content.split(/\r?\n/);
        const startIdx = Math.max(1, start);
        const endIdx = Math.min(lines.length, end);
        const slice = lines.slice(startIdx - 1, endIdx).map((line, idx) => {
            if (!withLineNumbers)
                return line;
            return `${startIdx + idx}: ${line}`;
        });
        return {
            ...raw,
            content: slice.join('\n'),
            startLine: startIdx,
            endLine: endIdx,
            totalLines: lines.length,
        };
    }
    async listDir(relPath, maxEntries = 200) {
        const target = this.resolvePath(relPath || '.');
        const entries = await fsp.readdir(target, { withFileTypes: true });
        const result = [];
        for (const entry of entries.slice(0, maxEntries)) {
            const entryPath = path.join(target, entry.name);
            const stats = await fsp.lstat(entryPath);
            const type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file';
            result.push({
                name: entry.name,
                path: path.relative(this.root, entryPath),
                type,
                size: stats.size,
                mtimeMs: stats.mtimeMs,
            });
        }
        return result;
    }
    async searchText(pattern, relPath = '.', maxResults) {
        const root = this.resolvePath(relPath || '.');
        const limit = maxResults && maxResults > 0 ? maxResults : this.searchLimit;
        const results = [];
        const walk = async (dir) => {
            if (results.length >= limit)
                return;
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= limit)
                    return;
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
                    continue;
                }
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                    continue;
                }
                if (!entry.isFile())
                    continue;
                const stats = await fsp.stat(full);
                if (stats.size > this.maxFileBytes)
                    continue;
                const buffer = await fsp.readFile(full);
                if (isBinaryBuffer(buffer))
                    continue;
                const content = buffer.toString('utf8');
                const lines = content.split(/\r?\n/);
                lines.forEach((line, idx) => {
                    if (results.length >= limit)
                        return;
                    if (line.includes(pattern)) {
                        results.push({
                            path: path.relative(this.root, full),
                            line: idx + 1,
                            text: line.trim().slice(0, 400),
                        });
                    }
                });
            }
        };
        await walk(root);
        return results;
    }
    async writeFile(relPath, content) {
        if (!this.allowWrites)
            throw new Error('Writes are disabled.');
        const target = this.resolvePath(relPath);
        const buffer = Buffer.from(content, 'utf8');
        if (buffer.length > this.maxWriteBytes) {
            throw new Error('Write exceeds max-write-bytes limit.');
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, buffer);
        return { bytes: buffer.length, sha256: sha256(buffer), path: relPath };
    }
    async appendFile(relPath, content) {
        if (!this.allowWrites)
            throw new Error('Writes are disabled.');
        const target = this.resolvePath(relPath);
        const buffer = Buffer.from(content, 'utf8');
        if (buffer.length > this.maxWriteBytes) {
            throw new Error('Write exceeds max-write-bytes limit.');
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.appendFile(target, buffer);
        return { bytes: buffer.length, sha256: sha256(buffer), path: relPath };
    }
    async deletePath(relPath) {
        if (!this.allowWrites)
            throw new Error('Writes are disabled.');
        const target = this.resolvePath(relPath);
        await fsp.rm(target, { recursive: true, force: true });
        return { path: relPath };
    }
}
