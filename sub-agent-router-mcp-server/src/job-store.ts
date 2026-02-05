import Database from 'better-sqlite3';
import { generateId, normalizeId } from './utils.js';
import { JobRecord, JobStatus, JobEvent } from './types.js';

type DbJobRow = {
  id: string;
  status: string;
  task: string;
  agent_id: string | null;
  command_id: string | null;
  payload_json: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  session_id: string;
  run_id: string | null;
};

type DbEventRow = {
  id: string;
  job_id: string;
  type: string;
  payload_json: string | null;
  created_at: string;
  session_id: string;
  run_id: string | null;
};

export interface JobStoreOptions {
  defaultSessionId: string;
  defaultRunId?: string;
}

export class JobStore {
  private db: Database.Database;
  private defaultSessionId: string;
  private defaultRunId: string;

  constructor(dbPath: string, options: JobStoreOptions) {
    this.db = new Database(dbPath);
    this.defaultSessionId = options.defaultSessionId;
    this.defaultRunId = options.defaultRunId || '';
    this.init();
  }

  private init() {
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

  createJob(input: {
    task: string;
    agentId?: string | null;
    commandId?: string | null;
    payload?: unknown;
    sessionId?: string;
    runId?: string;
  }): JobRecord {
    const now = new Date().toISOString();
    const record: JobRecord = {
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

  updateJobStatus(
    jobId: string,
    status: JobStatus,
    resultJson?: string | null,
    error?: string | null
  ): JobRecord | null {
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

  updateJobFields(jobId: string, fields: Partial<JobRecord>): JobRecord | null {
    const now = new Date().toISOString();
    const current = this.getJob(jobId);
    if (!current) return null;
    const next: JobRecord = { ...current, ...fields, updatedAt: now };
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

  getJob(jobId: string): JobRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM subagent_jobs WHERE id = ?`);
    const row = stmt.get(jobId) as DbJobRow | undefined;
    if (!row) return null;
    return this.fromJobRow(row);
  }

  appendEvent(jobId: string, type: string, payload?: unknown): JobEvent {
    const now = new Date().toISOString();
    const record: JobEvent = {
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

  logModelRoute(model: string | null, reason: string | null) {
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

  listJobs(options: {
    sessionId?: string;
    status?: JobStatus;
    limit?: number;
    allSessions?: boolean;
  } = {}): JobRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    const status = typeof options.status === 'string' ? options.status.trim().toLowerCase() : '';
    if (status) {
      where.push('status = @status');
      params.status = status;
    }
    if (!options.allSessions) {
      const sessionId = normalizeId(options.sessionId) || this.defaultSessionId;
      if (sessionId) {
        where.push('session_id = @session_id');
        params.session_id = sessionId;
      }
    }
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
        ? Math.trunc(options.limit)
        : 200;
    params.limit = limit;

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const stmt = this.db.prepare(
      `SELECT * FROM subagent_jobs ${whereSql} ORDER BY created_at DESC LIMIT @limit`
    );
    const rows = stmt.all(params) as DbJobRow[];
    return rows.map((row) => this.fromJobRow(row));
  }

  listSessions(limit = 50): Array<{ sessionId: string; count: number; lastCreatedAt: string }> {
    const max = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 50;
    const stmt = this.db.prepare(`
      SELECT session_id as session_id, COUNT(*) as count, MAX(created_at) as last_created_at
      FROM subagent_jobs
      GROUP BY session_id
      ORDER BY last_created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(max) as Array<{ session_id: string; count: number; last_created_at: string }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      count: row.count,
      lastCreatedAt: row.last_created_at,
    }));
  }

  private fromJobRow(row: DbJobRow): JobRecord {
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

  private normalizeStatus(value: string): JobStatus {
    const v = String(value || '').toLowerCase();
    if (v === 'queued' || v === 'running' || v === 'done' || v === 'error' || v === 'cancelled') {
      return v as JobStatus;
    }
    return 'queued';
  }

  private resolveSessionId(sessionId?: string): string {
    const normalized = normalizeId(sessionId);
    if (normalized) return normalized;
    return this.defaultSessionId;
  }

  private resolveRunId(runId?: string): string {
    const normalized = normalizeId(runId);
    if (normalized) return normalized;
    return this.defaultRunId || '';
  }
}
