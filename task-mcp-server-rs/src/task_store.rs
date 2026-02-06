use crate::types::{ClearTasksOptions, ListTasksOptions, Task, TaskInput};
use crate::utils::{generate_id, normalize_id, now_iso};
use rusqlite::{params, Connection, Row};
use rusqlite::types::Value as SqlValue;

pub struct TaskStore {
    conn: Connection,
    default_session_id: String,
    default_run_id: String,
}

impl TaskStore {
    pub fn new(db_path: &str, default_session_id: String, default_run_id: String) -> Result<Self, String> {
        let conn = Connection::open(db_path).map_err(|err| err.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|err| err.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|err| err.to_string())?;
        conn.execute_batch(
            r#"
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
      "#,
        )
        .map_err(|err| err.to_string())?;
        Ok(Self {
            conn,
            default_session_id,
            default_run_id,
        })
    }

    pub fn add_task(&self, input: TaskInput) -> Result<Task, String> {
        let task = self.build_task(input)?;
        self.conn
            .execute(
                r#"
        INSERT INTO tasks (
          id, title, details, status, priority, tags_json,
          run_id, session_id, user_message_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
                params![
                    task.id,
                    task.title,
                    task.details,
                    task.status,
                    task.priority,
                    serde_json::to_string(&task.tags).unwrap_or_else(|_| "[]".to_string()),
                    task.run_id,
                    task.session_id,
                    task.user_message_id,
                    task.created_at,
                    task.updated_at
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(task)
    }

    pub fn add_tasks(&mut self, inputs: Vec<TaskInput>) -> Result<Vec<Task>, String> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let mut tasks = Vec::new();
        for input in inputs {
            tasks.push(self.build_task(input)?);
        }
        let tx = self.conn.transaction().map_err(|err| err.to_string())?;
        for task in &tasks {
            tx.execute(
                r#"
        INSERT INTO tasks (
          id, title, details, status, priority, tags_json,
          run_id, session_id, user_message_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
                params![
                    task.id,
                    task.title,
                    task.details,
                    task.status,
                    task.priority,
                    serde_json::to_string(&task.tags).unwrap_or_else(|_| "[]".to_string()),
                    task.run_id,
                    task.session_id,
                    task.user_message_id,
                    task.created_at,
                    task.updated_at
                ],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(tasks)
    }

    pub fn list_tasks(&self, options: ListTasksOptions) -> Result<Vec<Task>, String> {
        let include_done = options.include_done;
        let limit = options.limit.unwrap_or(50).max(1);
        let (mut conditions, mut params) = self.build_scope_conditions(
            options.session_id.as_deref(),
            options.run_id.as_deref(),
            options.all_sessions,
            options.all_runs,
        );

        if let Some(status) = options.status {
            conditions.push("status = ?".to_string());
            params.push(SqlValue::from(status.to_lowercase()));
        } else if !include_done {
            conditions.push("status != 'done'".to_string());
        }

        let where_clause = if conditions.is_empty() {
            "".to_string()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let sql = format!(
            "SELECT * FROM tasks {} ORDER BY created_at DESC LIMIT ?",
            where_clause
        );
        params.push(SqlValue::from(limit));

        let mut stmt = self.conn.prepare(&sql).map_err(|err| err.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params))
            .map_err(|err| err.to_string())?;
        let mut tasks = Vec::new();
        while let Some(row) = rows.next().map_err(|err| err.to_string())? {
            tasks.push(self.from_row(row)?);
        }
        if let Some(tag) = options.tag {
            let needle = tag.trim().to_lowercase();
            tasks.retain(|task| task.tags.iter().any(|t| t.to_lowercase() == needle));
        }
        Ok(tasks)
    }

    pub fn update_task(
        &self,
        id: &str,
        patch: TaskUpdate,
    ) -> Result<Task, String> {
        let mut existing = self.get_task(id)?.ok_or_else(|| format!("Task not found: {id}"))?;
        if let Some(title) = patch.title {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err("title cannot be empty".to_string());
            }
            existing.title = trimmed.to_string();
        }
        if let Some(details) = patch.details {
            existing.details = details.trim().to_string();
        }
        if let Some(append_note) = patch.append_note {
            let note = append_note.trim();
            if !note.is_empty() {
                existing.details = if existing.details.is_empty() {
                    format!("Note: {}", note)
                } else {
                    format!("{}\nNote: {}", existing.details, note)
                };
            }
        }
        if let Some(priority) = patch.priority {
            existing.priority = normalize_priority(&priority);
        }
        if let Some(status) = patch.status {
            existing.status = normalize_status(&status);
        }
        if let Some(tags) = patch.tags {
            existing.tags = normalize_tags(&tags);
        }
        existing.updated_at = now_iso();

        self.conn
            .execute(
                r#"
        UPDATE tasks SET
          title = ?1,
          details = ?2,
          status = ?3,
          priority = ?4,
          tags_json = ?5,
          run_id = ?6,
          session_id = ?7,
          user_message_id = ?8,
          created_at = ?9,
          updated_at = ?10
        WHERE id = ?11
        "#,
                params![
                    existing.title,
                    existing.details,
                    existing.status,
                    existing.priority,
                    serde_json::to_string(&existing.tags).unwrap_or_else(|_| "[]".to_string()),
                    existing.run_id,
                    existing.session_id,
                    existing.user_message_id,
                    existing.created_at,
                    existing.updated_at,
                    existing.id
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(existing)
    }

    pub fn complete_task(&self, id: &str, note: &str) -> Result<Task, String> {
        let trimmed = note.trim();
        if trimmed.len() < 5 {
            return Err("complete_task requires note (at least 5 characters).".to_string());
        }
        let note_text = format!("Completion({}): {}", now_iso(), trimmed);
        self.update_task(
            id,
            TaskUpdate {
                title: None,
                details: None,
                append_note: Some(note_text),
                priority: None,
                status: Some("done".to_string()),
                tags: None,
            },
        )
    }

    pub fn clear_tasks(&self, options: ClearTasksOptions) -> Result<ClearResult, String> {
        let mode = options.mode.unwrap_or_else(|| "done".to_string()).to_lowercase();
        if mode != "done" && mode != "all" {
            return Err("mode must be done or all".to_string());
        }
        let (mut conditions, params) = self.build_scope_conditions(
            options.session_id.as_deref(),
            options.run_id.as_deref(),
            options.all_sessions,
            options.all_runs,
        );
        if mode == "done" {
            conditions.push("status = 'done'".to_string());
        }
        let where_clause = if conditions.is_empty() {
            "".to_string()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let sql = format!("DELETE FROM tasks {}", where_clause);
        let mut stmt = self.conn.prepare(&sql).map_err(|err| err.to_string())?;
        let changes = stmt
            .execute(rusqlite::params_from_iter(params.clone()))
            .map_err(|err| err.to_string())?;

        let remaining_sql = if mode == "done" {
            where_clause.replace("status = 'done'", "1=1")
        } else {
            where_clause
        };
        let remaining_query = format!("SELECT COUNT(*) as count FROM tasks {}", remaining_sql);
        let mut stmt = self
            .conn
            .prepare(&remaining_query)
            .map_err(|err| err.to_string())?;
        let count: i64 = stmt
            .query_row(rusqlite::params_from_iter(params), |row| row.get(0))
            .unwrap_or(0);

        Ok(ClearResult {
            removed: changes as i64,
            remaining: count,
        })
    }

    fn get_task(&self, id: &str) -> Result<Option<Task>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM tasks WHERE id = ?1")
            .map_err(|err| err.to_string())?;
        let mut rows = stmt.query(params![id]).map_err(|err| err.to_string())?;
        if let Some(row) = rows.next().map_err(|err| err.to_string())? {
            Ok(Some(self.from_row(row)?))
        } else {
            Ok(None)
        }
    }

    fn build_task(&self, input: TaskInput) -> Result<Task, String> {
        let title = input.title.trim().to_string();
        if title.is_empty() {
            return Err("title is required".to_string());
        }
        let details = build_details(input.details.as_deref(), &title);
        let now = now_iso();
        let tags_vec = input.tags.unwrap_or_default();
        Ok(Task {
            id: generate_id("task"),
            title,
            details,
            status: normalize_status(input.status.as_deref().unwrap_or("todo")),
            priority: normalize_priority(input.priority.as_deref().unwrap_or("medium")),
            tags: normalize_tags(&tags_vec),
            run_id: resolve_run_id(self.default_run_id.clone(), input.run_id.as_deref()),
            session_id: resolve_session_id(self.default_session_id.clone(), input.session_id.as_deref()),
            user_message_id: normalize_id(input.user_message_id.as_ref()),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    fn from_row(&self, row: &Row) -> Result<Task, String> {
        let tags_json: String = row.get("tags_json").map_err(|err| err.to_string())?;
        Ok(Task {
            id: row.get("id").map_err(|err| err.to_string())?,
            title: row.get("title").map_err(|err| err.to_string())?,
            details: row.get("details").map_err(|err| err.to_string())?,
            status: normalize_status(&row.get::<_, String>("status").map_err(|err| err.to_string())?),
            priority: normalize_priority(&row.get::<_, String>("priority").map_err(|err| err.to_string())?),
            tags: parse_tags(&tags_json),
            run_id: row.get("run_id").map_err(|err| err.to_string())?,
            session_id: row.get("session_id").map_err(|err| err.to_string())?,
            user_message_id: row.get("user_message_id").map_err(|err| err.to_string())?,
            created_at: row.get("created_at").map_err(|err| err.to_string())?,
            updated_at: row.get("updated_at").map_err(|err| err.to_string())?,
        })
    }

    fn build_scope_conditions(
        &self,
        session_id: Option<&str>,
        run_id: Option<&str>,
        all_sessions: bool,
        all_runs: bool,
    ) -> (Vec<String>, Vec<SqlValue>) {
        let mut conditions = Vec::new();
        let mut params = Vec::new();
        if !all_sessions {
            let sid = resolve_session_id(self.default_session_id.clone(), session_id);
            if !sid.is_empty() {
                conditions.push("session_id = ?".to_string());
                params.push(SqlValue::from(sid));
            }
        }
        if !all_runs {
            let rid = resolve_run_id(self.default_run_id.clone(), run_id);
            if !rid.is_empty() {
                conditions.push("run_id = ?".to_string());
                params.push(SqlValue::from(rid));
            }
        }
        (conditions, params)
    }
}

#[derive(Debug)]
pub struct TaskUpdate {
    pub title: Option<String>,
    pub details: Option<String>,
    pub append_note: Option<String>,
    pub priority: Option<String>,
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize)]
pub struct ClearResult {
    pub removed: i64,
    pub remaining: i64,
}

fn normalize_priority(value: &str) -> String {
    let v = value.to_lowercase();
    if v == "high" || v == "low" || v == "medium" {
        v
    } else {
        "medium".to_string()
    }
}

fn normalize_status(value: &str) -> String {
    let v = value.to_lowercase();
    if v == "todo" || v == "doing" || v == "blocked" || v == "done" {
        v
    } else {
        "todo".to_string()
    }
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    tags.iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

fn parse_tags(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn build_details(details: Option<&str>, title: &str) -> String {
    let text = details.unwrap_or("").trim().to_string();
    if text.len() >= 15 {
        return text;
    }
    let base = if text.is_empty() { title } else { &text };
    let compact = base.split_whitespace().collect::<Vec<_>>().join(" ");
    let context = if compact.len() > 180 {
        format!("{}...", &compact[..177])
    } else {
        compact
    };
    format!("Context: {}\nAcceptance: TBD", context)
}

fn resolve_session_id(default_id: String, session_id: Option<&str>) -> String {
    let normalized = session_id.unwrap_or("").trim().to_string();
    if normalized.is_empty() {
        default_id
    } else {
        normalized
    }
}

fn resolve_run_id(default_id: String, run_id: Option<&str>) -> String {
    let normalized = run_id.unwrap_or("").trim().to_string();
    if normalized.is_empty() {
        default_id
    } else {
        normalized
    }
}
