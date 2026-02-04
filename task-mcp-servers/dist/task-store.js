import Database from 'better-sqlite3';
import { generateId, normalizeId } from './utils.js';
export class TaskStore {
    db;
    defaultSessionId;
    defaultRunId;
    constructor(dbPath, options) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.defaultSessionId = options.defaultSessionId;
        this.defaultRunId = options.defaultRunId;
        this.ensureSchema();
    }
    ensureSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_session_idx ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS tasks_run_idx ON tasks(run_id);
      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at);
    `);
    }
    addTask(input) {
        const task = this.buildTask(input);
        const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, title, details, status, priority, tags_json,
        run_id, session_id, user_message_id, created_at, updated_at
      ) VALUES (
        @id, @title, @details, @status, @priority, @tags_json,
        @run_id, @session_id, @user_message_id, @created_at, @updated_at
      );
    `);
        stmt.run(this.toDbRow(task));
        return task;
    }
    addTasks(inputs) {
        if (!Array.isArray(inputs) || inputs.length === 0)
            return [];
        const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, title, details, status, priority, tags_json,
        run_id, session_id, user_message_id, created_at, updated_at
      ) VALUES (
        @id, @title, @details, @status, @priority, @tags_json,
        @run_id, @session_id, @user_message_id, @created_at, @updated_at
      );
    `);
        const tasks = inputs.map((input) => this.buildTask(input));
        const tx = this.db.transaction((rows) => {
            rows.forEach((row) => stmt.run(this.toDbRow(row)));
        });
        tx(tasks);
        return tasks;
    }
    listTasks(options = {}) {
        const includeDone = options.includeDone !== false;
        const limit = Number.isFinite(options.limit) ? Number(options.limit) : 50;
        const { conditions, params } = this.buildScopeConditions(options);
        if (options.status) {
            conditions.push('status = @status');
            params.status = this.normalizeStatus(options.status);
        }
        else if (!includeDone) {
            conditions.push("status != 'done'");
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `
      SELECT * FROM tasks
      ${where}
      ORDER BY created_at DESC
      LIMIT @limit
    `;
        params.limit = limit > 0 ? limit : 50;
        const rows = this.db.prepare(sql).all(params);
        let tasks = rows.map((row) => this.fromDbRow(row));
        if (options.tag) {
            const needle = options.tag.trim().toLowerCase();
            tasks = tasks.filter((task) => task.tags.some((t) => t.toLowerCase() === needle));
        }
        return tasks;
    }
    getTask(id) {
        const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
        const row = stmt.get(id);
        return row ? this.fromDbRow(row) : null;
    }
    updateTask(id, patch) {
        const existing = this.getTask(id);
        if (!existing) {
            throw new Error(`未找到 ID 为 ${id} 的任务。`);
        }
        const updated = { ...existing };
        if (patch.title !== undefined) {
            const title = patch.title.trim();
            if (!title)
                throw new Error('title 不能为空');
            updated.title = title;
        }
        if (patch.details !== undefined) {
            const details = patch.details.trim();
            updated.details = details;
        }
        if (patch.appendNote) {
            const note = patch.appendNote.trim();
            if (note) {
                updated.details = updated.details ? `${updated.details}\n备注: ${note}` : `备注: ${note}`;
            }
        }
        if (patch.priority !== undefined) {
            updated.priority = this.normalizePriority(patch.priority);
        }
        if (patch.status !== undefined) {
            updated.status = this.normalizeStatus(patch.status);
        }
        if (patch.tags !== undefined) {
            updated.tags = this.normalizeTags(patch.tags);
        }
        updated.updatedAt = new Date().toISOString();
        const stmt = this.db.prepare(`
      UPDATE tasks SET
        title = @title,
        details = @details,
        status = @status,
        priority = @priority,
        tags_json = @tags_json,
        run_id = @run_id,
        session_id = @session_id,
        user_message_id = @user_message_id,
        created_at = @created_at,
        updated_at = @updated_at
      WHERE id = @id
    `);
        stmt.run(this.toDbRow(updated));
        return updated;
    }
    completeTask(id, note) {
        const trimmed = note.trim();
        if (trimmed.length < 5) {
            throw new Error('complete_task 需要提供完成明细 note（至少 5 个字符）。');
        }
        return this.updateTask(id, {
            status: 'done',
            appendNote: `完成明细(${new Date().toISOString()}): ${trimmed}`,
        });
    }
    clearTasks(options = {}) {
        const mode = (options.mode || 'done').toLowerCase();
        if (mode !== 'done' && mode !== 'all') {
            throw new Error('mode 必须是 done 或 all');
        }
        const { conditions, params } = this.buildScopeConditions(options);
        if (mode === 'done') {
            conditions.push("status = 'done'");
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const stmt = this.db.prepare(`DELETE FROM tasks ${where}`);
        const info = stmt.run(params);
        const remainingInfo = this.db
            .prepare(`SELECT COUNT(*) as count FROM tasks ${where.replace("status = 'done'", '1=1')}`)
            .get(params);
        return { removed: info.changes || 0, remaining: remainingInfo?.count ?? 0 };
    }
    buildTask(input) {
        const now = new Date().toISOString();
        const title = input.title.trim();
        if (!title) {
            throw new Error('title is required');
        }
        const details = this.buildDetails(input.details, title);
        return {
            id: generateId('task'),
            title,
            details,
            status: this.normalizeStatus(input.status),
            priority: this.normalizePriority(input.priority),
            tags: this.normalizeTags(input.tags),
            runId: this.resolveRunId(input.runId),
            sessionId: this.resolveSessionId(input.sessionId),
            userMessageId: normalizeId(input.userMessageId),
            createdAt: now,
            updatedAt: now,
        };
    }
    resolveSessionId(sessionId) {
        const normalized = normalizeId(sessionId);
        if (normalized)
            return normalized;
        return this.defaultSessionId;
    }
    resolveRunId(runId) {
        const normalized = normalizeId(runId);
        if (normalized)
            return normalized;
        return this.defaultRunId || '';
    }
    normalizePriority(priority) {
        const value = String(priority || 'medium').toLowerCase();
        return value === 'high' || value === 'low' || value === 'medium' ? value : 'medium';
    }
    normalizeStatus(status) {
        const value = String(status || 'todo').toLowerCase();
        return value === 'todo' || value === 'doing' || value === 'blocked' || value === 'done'
            ? value
            : 'todo';
    }
    normalizeTags(tags) {
        if (!Array.isArray(tags))
            return [];
        return tags.map((t) => String(t || '').trim()).filter(Boolean);
    }
    buildDetails(details, title) {
        const text = typeof details === 'string' ? details.trim() : '';
        if (text.length >= 15)
            return text;
        const base = (text || title || 'Task').replace(/\s+/g, ' ');
        const context = base.length > 180 ? `${base.slice(0, 177)}...` : base;
        return `Context: ${context}\nAcceptance: TBD`;
    }
    fromDbRow(row) {
        return {
            id: row.id,
            title: row.title,
            details: row.details,
            status: this.normalizeStatus(row.status),
            priority: this.normalizePriority(row.priority),
            tags: this.safeParseTags(row.tags_json),
            runId: row.run_id || '',
            sessionId: row.session_id || '',
            userMessageId: row.user_message_id || '',
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
    toDbRow(task) {
        return {
            id: task.id,
            title: task.title,
            details: task.details,
            status: task.status,
            priority: task.priority,
            tags_json: JSON.stringify(task.tags || []),
            run_id: task.runId || '',
            session_id: task.sessionId || '',
            user_message_id: task.userMessageId || '',
            created_at: task.createdAt,
            updated_at: task.updatedAt,
        };
    }
    safeParseTags(value) {
        if (!value)
            return [];
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map((t) => String(t || '').trim()).filter(Boolean) : [];
        }
        catch {
            return [];
        }
    }
    buildScopeConditions(options) {
        const conditions = [];
        const params = {};
        if (!options.allSessions) {
            const sessionId = this.resolveSessionId(options.sessionId);
            if (sessionId) {
                conditions.push('session_id = @session_id');
                params.session_id = sessionId;
            }
        }
        if (!options.allRuns) {
            const runId = this.resolveRunId(options.runId);
            if (runId) {
                conditions.push('run_id = @run_id');
                params.run_id = runId;
            }
        }
        return { conditions, params };
    }
}
