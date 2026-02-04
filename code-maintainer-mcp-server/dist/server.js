import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatBytes } from './utils.js';
import { applyPatch } from './patch.js';
import { sha256 } from './utils.js';
export function createCodeMaintainerServer(options) {
    const { serverName, fsOps, changeLog, defaultSessionId, defaultRunId, allowWrites, workspaceRoot, maxFileBytes, maxWriteBytes, searchLimit, } = options;
    const server = new McpServer({ name: serverName, version: '0.1.0' });
    const workspaceNote = `Workspace root: ${workspaceRoot}. Paths must stay inside this directory.`;
    server.registerTool('read_file_raw', {
        title: 'Read file (raw)',
        description: ['Return UTF-8 file content without line numbers.', workspaceNote].join('\n'),
        inputSchema: z.object({ path: z.string() }),
    }, async ({ path }) => {
        const result = await fsOps.readFileRaw(path);
        return textResult({
            path: result.path,
            size_bytes: result.size,
            sha256: result.sha256,
            content: result.content,
        });
    });
    server.registerTool('read_file_range', {
        title: 'Read file (line range)',
        description: [
            'Return UTF-8 content from start_line to end_line (1-based, inclusive).',
            `File size limit: ${formatBytes(maxFileBytes)}.`,
            workspaceNote,
        ].join('\n'),
        inputSchema: z.object({
            path: z.string(),
            start_line: z.number().int().min(1),
            end_line: z.number().int().min(1),
            with_line_numbers: z.boolean().optional(),
        }),
    }, async ({ path, start_line, end_line, with_line_numbers }) => {
        const result = await fsOps.readFileRange(path, start_line, end_line, Boolean(with_line_numbers));
        return textResult({
            path: result.path,
            size_bytes: result.size,
            sha256: result.sha256,
            start_line: result.startLine,
            end_line: result.endLine,
            total_lines: result.totalLines,
            content: result.content,
        });
    });
    server.registerTool('list_dir', {
        title: 'List directory',
        description: ['List directory entries.', workspaceNote].join('\n'),
        inputSchema: z.object({
            path: z.string().optional(),
            max_entries: z.number().int().min(1).max(1000).optional(),
        }),
    }, async ({ path, max_entries }) => {
        const entries = await fsOps.listDir(path || '.', max_entries || 200);
        return textResult({ entries });
    });
    server.registerTool('search_text', {
        title: 'Search text',
        description: ['Search text recursively under a directory.', workspaceNote].join('\n'),
        inputSchema: z.object({
            pattern: z.string().min(1),
            path: z.string().optional(),
            max_results: z.number().int().min(1).max(500).optional(),
        }),
    }, async ({ pattern, path, max_results }) => {
        const results = await fsOps.searchText(pattern, path || '.', max_results || searchLimit);
        return textResult({ count: results.length, results });
    });
    server.registerTool('write_file', {
        title: 'Write file',
        description: [
            'Write file content (overwrite).',
            `Max write bytes: ${formatBytes(maxWriteBytes)}.`,
            allowWrites ? 'Writes enabled.' : 'Writes disabled.',
            workspaceNote,
        ].join('\n'),
        inputSchema: z.object({
            path: z.string(),
            content: z.string(),
        }),
    }, async ({ path, content }) => {
        const result = await fsOps.writeFile(path, content);
        const record = changeLog.logChange({
            path: result.path,
            action: 'write',
            bytes: result.bytes,
            sha256: result.sha256,
            sessionId: defaultSessionId,
            runId: defaultRunId,
        });
        return textResult({ result, change: record });
    });
    server.registerTool('append_file', {
        title: 'Append file',
        description: [
            'Append content to file.',
            `Max write bytes: ${formatBytes(maxWriteBytes)}.`,
            allowWrites ? 'Writes enabled.' : 'Writes disabled.',
            workspaceNote,
        ].join('\n'),
        inputSchema: z.object({
            path: z.string(),
            content: z.string(),
        }),
    }, async ({ path, content }) => {
        const result = await fsOps.appendFile(path, content);
        const record = changeLog.logChange({
            path: result.path,
            action: 'append',
            bytes: result.bytes,
            sha256: result.sha256,
            sessionId: defaultSessionId,
            runId: defaultRunId,
        });
        return textResult({ result, change: record });
    });
    server.registerTool('delete_path', {
        title: 'Delete path',
        description: ['Delete a file or directory.', allowWrites ? 'Writes enabled.' : 'Writes disabled.', workspaceNote].join('\n'),
        inputSchema: z.object({ path: z.string() }),
    }, async ({ path }) => {
        const result = await fsOps.deletePath(path);
        const record = changeLog.logChange({
            path: result.path,
            action: 'delete',
            bytes: 0,
            sha256: '',
            sessionId: defaultSessionId,
            runId: defaultRunId,
        });
        return textResult({ result, change: record });
    });
    server.registerTool('apply_patch', {
        title: 'Apply patch',
        description: [
            'Apply a patch to one or more files.',
            'Patch format uses *** Begin Patch / *** Update File / *** Add File / *** Delete File / *** End Patch.',
            allowWrites ? 'Writes enabled.' : 'Writes disabled.',
            workspaceNote,
        ].join('\n'),
        inputSchema: z.object({
            patch: z.string().min(1),
        }),
    }, async ({ patch }) => {
        const result = applyPatch({ root: workspaceRoot, patch, allowWrites });
        const changeHashes = result.updated.map((filePath) => {
            const fullPath = fsOps.resolvePath(filePath);
            const content = fs.readFileSync(fullPath, 'utf8');
            const hash = sha256(content);
            changeLog.logChange({
                path: filePath,
                action: 'write',
                bytes: Buffer.byteLength(content, 'utf8'),
                sha256: hash,
                sessionId: defaultSessionId,
                runId: defaultRunId,
            });
            return { path: filePath, sha256: hash };
        });
        result.added.forEach((filePath) => {
            const fullPath = fsOps.resolvePath(filePath);
            const content = fs.readFileSync(fullPath, 'utf8');
            const hash = sha256(content);
            changeLog.logChange({
                path: filePath,
                action: 'write',
                bytes: Buffer.byteLength(content, 'utf8'),
                sha256: hash,
                sessionId: defaultSessionId,
                runId: defaultRunId,
            });
        });
        result.deleted.forEach((filePath) => {
            changeLog.logChange({
                path: filePath,
                action: 'delete',
                bytes: 0,
                sha256: '',
                sessionId: defaultSessionId,
                runId: defaultRunId,
            });
        });
        return textResult({ result, files: changeHashes });
    });
    return server;
}
function textResult(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return { content: [{ type: 'text', text }] };
}
