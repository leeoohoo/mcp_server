import Database from 'better-sqlite3';
import { generateId, normalizeId } from './utils.js';
export class JobStore {
    db;
    defaultSessionId;
    defaultRunId;
    constructor(dbPath, options) {
        this.db = new Database(dbPath);
        this.defaultSessionId = options.defaultSessionId;
        this.defaultRunId = options.defaultRunId || '';
        this.init();
    }
    init() {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        agent_id TEXT,
        command_id TEXT,
        payload_json TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT
      );
      CREATE INDEX IF NOT EXISTS subagent_jobs_session_idx ON subagent_jobs(session_id);
      CREATE INDEX IF NOT EXISTS subagent_jobs_status_idx ON subagent_jobs(status);

      CREATE TABLE IF NOT EXISTS subagent_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT
      );
      CREATE INDEX IF NOT EXISTS subagent_events_job_idx ON subagent_events(job_id);

      CREATE TABLE IF NOT EXISTS model_routes (
        id TEXT PRIMARY KEY,
        model TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT
      );
    `);
    }
    createJob(input) {
        const now = new Date().toISOString();
        const record = {
            id: generateId('job'),
            status: 'queued',
            task: input.task,
            agentId: input.agentId ?? null,
            commandId: input.commandId ?? null,
            payloadJson: input.payload ? JSON.stringify(input.payload) : null,
            resultJson: null,
            error: null,
            createdAt: now,
            updatedAt: now,
            sessionId: this.resolveSessionId(input.sessionId),
            runId: this.resolveRunId(input.runId),
        };
        const stmt = this.db.prepare(`
      INSERT INTO subagent_jobs (
        id, status, task, agent_id, command_id, payload_json, result_json, error,
        created_at, updated_at, session_id, run_id
      ) VALUES (
        @id, @status, @task, @agent_id, @command_id, @payload_json, @result_json, @error,
        @created_at, @updated_at, @session_id, @run_id
      )
    `);
        stmt.run({
            id: record.id,
            status: record.status,
            task: record.task,
            agent_id: record.agentId,
            command_id: record.commandId,
            payload_json: record.payloadJson,
            result_json: record.resultJson,
            error: record.error,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
            session_id: record.sessionId,
            run_id: record.runId || null,
        });
        return record;
    }
    updateJobStatus(jobId, status, resultJson, error) {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
      UPDATE subagent_jobs
      SET status = @status,
          result_json = @result_json,
          error = @error,
          updated_at = @updated_at
      WHERE id = @id
    `);
        stmt.run({
            id: jobId,
            status,
            result_json: resultJson ?? null,
            error: error ?? null,
            updated_at: now,
        });
        return this.getJob(jobId);
    }
    updateJobFields(jobId, fields) {
        const now = new Date().toISOString();
        const current = this.getJob(jobId);
        if (!current)
            return null;
        const next = { ...current, ...fields, updatedAt: now };
        const stmt = this.db.prepare(`
      UPDATE subagent_jobs
      SET status = @status,
          task = @task,
          agent_id = @agent_id,
          command_id = @command_id,
          payload_json = @payload_json,
          result_json = @result_json,
          error = @error,
          updated_at = @updated_at,
          session_id = @session_id,
          run_id = @run_id
      WHERE id = @id
    `);
        stmt.run({
            id: next.id,
            status: next.status,
            task: next.task,
            agent_id: next.agentId,
            command_id: next.commandId,
            payload_json: next.payloadJson,
            result_json: next.resultJson,
            error: next.error,
            updated_at: next.updatedAt,
            session_id: next.sessionId,
            run_id: next.runId || null,
        });
        return next;
    }
    getJob(jobId) {
        const stmt = this.db.prepare(`SELECT * FROM subagent_jobs WHERE id = ?`);
        const row = stmt.get(jobId);
        if (!row)
            return null;
        return this.fromJobRow(row);
    }
    appendEvent(jobId, type, payload) {
        const now = new Date().toISOString();
        const record = {
            id: generateId('event'),
            jobId,
            type,
            payloadJson: payload ? JSON.stringify(payload) : null,
            createdAt: now,
            sessionId: this.defaultSessionId,
            runId: this.defaultRunId,
        };
        const stmt = this.db.prepare(`
      INSERT INTO subagent_events (id, job_id, type, payload_json, created_at, session_id, run_id)
      VALUES (@id, @job_id, @type, @payload_json, @created_at, @session_id, @run_id)
    `);
        stmt.run({
            id: record.id,
            job_id: record.jobId,
            type: record.type,
            payload_json: record.payloadJson,
            created_at: record.createdAt,
            session_id: record.sessionId,
            run_id: record.runId || null,
        });
        return record;
    }
    logModelRoute(model, reason) {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
      INSERT INTO model_routes (id, model, reason, created_at, session_id, run_id)
      VALUES (@id, @model, @reason, @created_at, @session_id, @run_id)
    `);
        stmt.run({
            id: generateId('route'),
            model,
            reason,
            created_at: now,
            session_id: this.defaultSessionId,
            run_id: this.defaultRunId || null,
        });
    }
    fromJobRow(row) {
        return {
            id: row.id,
            status: this.normalizeStatus(row.status),
            task: row.task,
            agentId: row.agent_id ?? null,
            commandId: row.command_id ?? null,
            payloadJson: row.payload_json ?? null,
            resultJson: row.result_json ?? null,
            error: row.error ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            sessionId: row.session_id,
            runId: row.run_id || '',
        };
    }
    normalizeStatus(value) {
        const v = String(value || '').toLowerCase();
        if (v === 'queued' || v === 'running' || v === 'done' || v === 'error' || v === 'cancelled') {
            return v;
        }
        return 'queued';
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
}
