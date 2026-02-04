import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
export function createTaskServer(options) {
    const { serverName, store, defaultSessionId, defaultRunId } = options;
    const server = new McpServer({ name: serverName, version: '0.1.0' });
    const taskInputSchema = z.object({
        title: z.string().min(1),
        details: z.string().optional(),
        priority: z.enum(['high', 'medium', 'low']).optional(),
        status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
        tags: z.array(z.string()).optional(),
        runId: z.string().optional(),
        sessionId: z.string().optional(),
        userMessageId: z.string().optional(),
    });
    const addTaskSchema = z.object({
        title: z.string().min(1).optional(),
        details: z.string().optional(),
        priority: z.enum(['high', 'medium', 'low']).optional(),
        status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
        tags: z.array(z.string()).optional(),
        runId: z.string().optional(),
        sessionId: z.string().optional(),
        userMessageId: z.string().optional(),
        tasks: z.union([z.array(taskInputSchema), z.string()]).optional(),
    });
    server.registerTool('add_task', {
        title: 'Add task',
        description: 'Create one or more tasks.',
        inputSchema: addTaskSchema,
    }, async (payload) => {
        const normalized = normalizeBatch(payload, taskInputSchema);
        const created = normalized.length === 1
            ? [store.addTask(normalized[0])]
            : store.addTasks(normalized);
        return textResult({
            created: created.length,
            defaultSessionId,
            defaultRunId,
            tasks: created,
        });
    });
    server.registerTool('list_tasks', {
        title: 'List tasks',
        description: 'List tasks with optional filters.',
        inputSchema: z.object({
            status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
            tag: z.string().optional(),
            include_done: z.boolean().optional(),
            limit: z.number().int().min(1).max(200).optional(),
            sessionId: z.string().optional(),
            runId: z.string().optional(),
            all_sessions: z.boolean().optional(),
            all_runs: z.boolean().optional(),
        }),
    }, async (payload) => {
        const tasks = store.listTasks({
            status: payload?.status,
            tag: payload?.tag,
            includeDone: payload?.include_done !== false,
            limit: payload?.limit,
            sessionId: payload?.sessionId,
            runId: payload?.runId,
            allSessions: payload?.all_sessions === true,
            allRuns: payload?.all_runs === true,
        });
        return textResult({
            count: tasks.length,
            defaultSessionId,
            defaultRunId,
            tasks,
        });
    });
    server.registerTool('update_task', {
        title: 'Update task',
        description: 'Update an existing task.',
        inputSchema: z.object({
            id: z.string().min(1),
            title: z.string().optional(),
            details: z.string().optional(),
            append_note: z.string().optional(),
            priority: z.enum(['high', 'medium', 'low']).optional(),
            status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
            tags: z.array(z.string()).optional(),
        }),
    }, async (payload) => {
        const updated = store.updateTask(payload.id, {
            title: payload.title,
            details: payload.details,
            appendNote: payload.append_note,
            priority: payload.priority,
            status: payload.status,
            tags: payload.tags,
        });
        return textResult({ updated });
    });
    server.registerTool('complete_task', {
        title: 'Complete task',
        description: 'Mark a task as completed and append a completion note.',
        inputSchema: z.object({
            id: z.string().min(1),
            note: z.string().min(5),
        }),
    }, async (payload) => {
        const updated = store.completeTask(payload.id, payload.note);
        return textResult({ updated });
    });
    server.registerTool('clear_tasks', {
        title: 'Clear tasks',
        description: 'Clear completed tasks or all tasks within the current session scope.',
        inputSchema: z.object({
            mode: z.enum(['done', 'all']).optional(),
            sessionId: z.string().optional(),
            runId: z.string().optional(),
            all_sessions: z.boolean().optional(),
            all_runs: z.boolean().optional(),
        }),
    }, async (payload) => {
        const result = store.clearTasks({
            mode: payload?.mode,
            sessionId: payload?.sessionId,
            runId: payload?.runId,
            allSessions: payload?.all_sessions === true,
            allRuns: payload?.all_runs === true,
        });
        return textResult(result);
    });
    return server;
}
function normalizeBatch(payload, schema) {
    const base = payload && typeof payload === 'object' ? payload : {};
    let tasks = base.tasks;
    if (typeof tasks === 'string') {
        const raw = tasks.trim();
        if (!raw)
            throw new Error('tasks 为空时请省略该字段，或提供 JSON 数组字符串。');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('tasks 必须是 JSON 数组字符串，例如: [{"title":"Fix login bug"}]。');
        }
        if (!Array.isArray(parsed)) {
            throw new Error('tasks 必须是 JSON 数组字符串，例如: [{"title":"Fix login bug"}]。');
        }
        tasks = parsed;
    }
    if (Array.isArray(tasks)) {
        const validated = z.array(schema).safeParse(tasks);
        if (!validated.success) {
            const first = validated.error?.errors?.[0];
            const detail = first?.message ? `（${first.message}）` : '';
            throw new Error(`tasks JSON 数组校验失败${detail}`);
        }
        return validated.data;
    }
    if (!base.title || typeof base.title !== 'string') {
        throw new Error('add_task 需要提供 title 或 tasks。');
    }
    return [schema.parse(base)];
}
function textResult(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return {
        content: [{ type: 'text', text }],
    };
}
