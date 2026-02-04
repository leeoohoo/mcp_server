import Database from 'better-sqlite3';
import { ChangeAction, ChangeRecord } from './types.js';
import { generateId } from './utils.js';

export interface StorageOptions {
  dbPath: string;
}

export class ChangeLogStore {
  private db: Database.Database;

  constructor(options: StorageOptions) {
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.ensureSchema();
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_changes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        action TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS file_changes_path_idx ON file_changes(path);
      CREATE INDEX IF NOT EXISTS file_changes_session_idx ON file_changes(session_id);
      CREATE INDEX IF NOT EXISTS file_changes_created_idx ON file_changes(created_at);
    `);
  }

  logChange(input: {
    path: string;
    action: ChangeAction;
    bytes: number;
    sha256: string;
    sessionId: string;
    runId: string;
  }): ChangeRecord {
    const record: ChangeRecord = {
      id: generateId('change'),
      path: input.path,
      action: input.action,
      bytes: input.bytes,
      sha256: input.sha256,
      sessionId: input.sessionId,
      runId: input.runId,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO file_changes (id, path, action, bytes, sha256, session_id, run_id, created_at)
         VALUES (@id, @path, @action, @bytes, @sha256, @session_id, @run_id, @created_at)`
      )
      .run({
        id: record.id,
        path: record.path,
        action: record.action,
        bytes: record.bytes,
        sha256: record.sha256,
        session_id: record.sessionId,
        run_id: record.runId,
        created_at: record.createdAt,
      });
    return record;
  }
}
