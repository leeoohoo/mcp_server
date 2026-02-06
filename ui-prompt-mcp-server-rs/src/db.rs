use rusqlite::{params, Connection, Error as RusqliteError};
use serde_json::{json, Value};
use std::path::Path;

use crate::utils::now_iso;

pub struct UiPromptDb {
    conn: Connection,
}

impl UiPromptDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("open db failed: {e}"))?;
        let db = Self { conn };
        db.init()?;
        Ok(db)
    }

    fn init(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS ui_prompts (
                    id TEXT PRIMARY KEY,
                    request_id TEXT NOT NULL UNIQUE,
                    prompt_json TEXT,
                    status TEXT,
                    response_json TEXT,
                    created_at TEXT,
                    updated_at TEXT
                );",
            )
            .map_err(|e| format!("init db failed: {e}"))?;
        Ok(())
    }

    pub fn upsert_request(
        &self,
        request_id: &str,
        prompt: &Value,
        status: &str,
    ) -> Result<(), String> {
        let now = now_iso();
        let prompt_json =
            serde_json::to_string(prompt).map_err(|e| format!("serialize prompt failed: {e}"))?;
        self.conn
            .execute(
                "INSERT INTO ui_prompts (id, request_id, prompt_json, status, response_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)
                 ON CONFLICT(request_id) DO UPDATE SET
                   prompt_json=excluded.prompt_json,
                   status=excluded.status,
                   updated_at=excluded.updated_at",
                params![request_id, request_id, prompt_json, status, now],
            )
            .map_err(|e| format!("upsert request failed: {e}"))?;
        Ok(())
    }

    pub fn upsert_response(
        &self,
        request_id: &str,
        response: &Value,
        status: &str,
    ) -> Result<(), String> {
        let now = now_iso();
        let response_json = serde_json::to_string(response)
            .map_err(|e| format!("serialize response failed: {e}"))?;
        self.conn
            .execute(
                "INSERT INTO ui_prompts (id, request_id, prompt_json, status, response_json, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?5)
                 ON CONFLICT(request_id) DO UPDATE SET
                   status=excluded.status,
                   response_json=excluded.response_json,
                   updated_at=excluded.updated_at",
                params![request_id, request_id, status, response_json, now],
            )
            .map_err(|e| format!("upsert response failed: {e}"))?;
        Ok(())
    }

    pub fn get_response_entry(&self, request_id: &str) -> Result<Option<Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT status, response_json, updated_at
                 FROM ui_prompts
                 WHERE request_id = ?1",
            )
            .map_err(|e| format!("prepare response query failed: {e}"))?;
        let row = stmt.query_row(params![request_id], |row| {
            let status: Option<String> = row.get(0)?;
            let response_json: Option<String> = row.get(1)?;
            let updated_at: Option<String> = row.get(2)?;
            Ok((status, response_json, updated_at))
        });
        match row {
            Ok((status, response_json, updated_at)) => {
                let status = status.unwrap_or_else(|| "pending".to_string());
                if response_json.is_none() && status == "pending" {
                    return Ok(None);
                }
                let response = if let Some(raw) = response_json {
                    serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "status": status }))
                } else {
                    json!({ "status": status })
                };
                let ts = updated_at.unwrap_or_else(now_iso);
                Ok(Some(json!({
                    "ts": ts,
                    "type": "ui_prompt",
                    "action": "response",
                    "requestId": request_id,
                    "response": response,
                })))
            }
            Err(RusqliteError::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(format!("query response failed: {err}")),
        }
    }

    pub fn list_prompts(
        &self,
        status_filter: Option<&str>,
        limit: Option<i64>,
    ) -> Result<Vec<Value>, String> {
        let limit = limit.unwrap_or(200).clamp(1, 1_000);
        let filter = status_filter.map(|s| s.trim().to_lowercase());

        let mut rows = Vec::new();
        let mut stmt;
        let mut query;

        match filter.as_deref() {
            Some("pending") => {
                stmt = self
                    .conn
                    .prepare(
                        "SELECT request_id, prompt_json, status, response_json, created_at, updated_at
                         FROM ui_prompts
                         WHERE status IS NULL OR status = 'pending'
                         ORDER BY updated_at DESC, created_at DESC
                         LIMIT ?1",
                    )
                    .map_err(|e| format!("prepare list query failed: {e}"))?;
                query = stmt
                    .query(params![limit])
                    .map_err(|e| format!("list query failed: {e}"))?;
            }
            Some("handled") => {
                stmt = self
                    .conn
                    .prepare(
                        "SELECT request_id, prompt_json, status, response_json, created_at, updated_at
                         FROM ui_prompts
                         WHERE status IS NOT NULL AND status != 'pending'
                         ORDER BY updated_at DESC, created_at DESC
                         LIMIT ?1",
                    )
                    .map_err(|e| format!("prepare list query failed: {e}"))?;
                query = stmt
                    .query(params![limit])
                    .map_err(|e| format!("list query failed: {e}"))?;
            }
            Some(value) if !value.is_empty() && value != "all" => {
                let filter_value = value.to_string();
                stmt = self
                    .conn
                    .prepare(
                        "SELECT request_id, prompt_json, status, response_json, created_at, updated_at
                         FROM ui_prompts
                         WHERE status = ?1
                         ORDER BY updated_at DESC, created_at DESC
                         LIMIT ?2",
                    )
                    .map_err(|e| format!("prepare list query failed: {e}"))?;
                query = stmt
                    .query(params![filter_value, limit])
                    .map_err(|e| format!("list query failed: {e}"))?;
            }
            _ => {
                stmt = self
                    .conn
                    .prepare(
                        "SELECT request_id, prompt_json, status, response_json, created_at, updated_at
                         FROM ui_prompts
                         ORDER BY updated_at DESC, created_at DESC
                         LIMIT ?1",
                    )
                    .map_err(|e| format!("prepare list query failed: {e}"))?;
                query = stmt
                    .query(params![limit])
                    .map_err(|e| format!("list query failed: {e}"))?;
            }
        }

        while let Some(row) = query.next().map_err(|e| format!("list row failed: {e}"))? {
            let request_id: String = row.get(0).map_err(|e| e.to_string())?;
            let prompt_json: Option<String> = row.get(1).map_err(|e| e.to_string())?;
            let status: Option<String> = row.get(2).map_err(|e| e.to_string())?;
            let response_json: Option<String> = row.get(3).map_err(|e| e.to_string())?;
            let created_at: Option<String> = row.get(4).map_err(|e| e.to_string())?;
            let updated_at: Option<String> = row.get(5).map_err(|e| e.to_string())?;

            let prompt_value = prompt_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or(Value::Null);
            let response_value = response_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or(Value::Null);
            let status_value = status.unwrap_or_else(|| "pending".to_string());

            rows.push(json!({
                "request_id": request_id,
                "status": status_value,
                "prompt": prompt_value,
                "response": response_value,
                "created_at": created_at,
                "updated_at": updated_at,
            }));
        }

        Ok(rows)
    }
}
