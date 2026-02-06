use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub details: String,
    pub status: String,
    pub priority: String,
    pub tags: Vec<String>,
    pub run_id: String,
    pub session_id: String,
    pub user_message_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInput {
    pub title: String,
    pub details: Option<String>,
    pub priority: Option<String>,
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    pub user_message_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ListTasksOptions {
    pub status: Option<String>,
    pub tag: Option<String>,
    pub include_done: bool,
    pub limit: Option<i64>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub all_sessions: bool,
    pub all_runs: bool,
}

#[derive(Debug, Clone)]
pub struct ClearTasksOptions {
    pub mode: Option<String>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub all_sessions: bool,
    pub all_runs: bool,
}
