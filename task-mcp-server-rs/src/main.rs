mod admin_server;
mod mcp;
mod task_store;
mod types;
mod utils;

use crate::admin_server::{run_admin_server, AdminServerOptions};
use crate::mcp::McpServer;
use crate::task_store::{ClearResult, TaskStore, TaskUpdate};
use crate::types::{ClearTasksOptions, ListTasksOptions, TaskInput};
use crate::utils::{ensure_dir, generate_id, normalize_id, normalize_name, parse_args, resolve_state_dir};
use serde_json::json;
use std::cell::RefCell;
use std::env;
use std::path::PathBuf;
use std::rc::Rc;

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let args = parse_args(&argv);
    if args.flags.contains("help") || args.flags.contains("h") {
        print_help();
        return;
    }

    let server_name = normalize_name(
        args.values
            .get("name")
            .map(String::as_str)
            .unwrap_or("task_manager"),
    );
    let session_id_arg = normalize_id(args.values.get("session-id").or_else(|| args.values.get("session")));
    let run_id_arg = normalize_id(args.values.get("run-id").or_else(|| args.values.get("run")));

    let session_id = if !session_id_arg.is_empty() {
        session_id_arg
    } else if let Ok(val) = env::var("MODEL_CLI_SESSION_ID") {
        val
    } else {
        generate_id("session")
    };
    let run_id = if !run_id_arg.is_empty() {
        run_id_arg
    } else {
        env::var("MODEL_CLI_RUN_ID").unwrap_or_default()
    };

    env::set_var("MODEL_CLI_SESSION_ID", &session_id);
    if !run_id.is_empty() {
        env::set_var("MODEL_CLI_RUN_ID", &run_id);
    }

    let state_dir = resolve_state_dir(&server_name);
    ensure_dir(&state_dir).expect("failed to create state directory");

    let db_path = args
        .values
        .get("db")
        .cloned()
        .unwrap_or_else(|| state_dir.join(format!("{server_name}.db.sqlite")).to_string_lossy().to_string());

    let store = TaskStore::new(&db_path, session_id.clone(), run_id.clone())
        .expect("failed to open task db");
    let store = Rc::new(RefCell::new(store));

    let admin_port = args
        .values
        .get("admin-port")
        .and_then(|v| v.parse::<u16>().ok());
    if let Some(port) = admin_port {
        let admin_host = args
            .values
            .get("admin-host")
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let admin_ui_root = resolve_admin_ui_root(args.values.get("admin-ui-root"));
        let options = AdminServerOptions {
            server_name: server_name.clone(),
            db_path: db_path.clone(),
            default_session_id: session_id.clone(),
            default_run_id: run_id.clone(),
            host: admin_host,
            port,
            admin_ui_root,
        };
        std::thread::spawn(move || {
            if let Err(err) = run_admin_server(options) {
                eprintln!("[task-admin] {err}");
            }
        });
    }

    let mut server = McpServer::new(server_name.clone(), "0.1.0");

    {
        let store = store.clone();
        let session_id = session_id.clone();
        let run_id = run_id.clone();
        server.register_tool(
            "add_task",
            "Create one or more tasks.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "details": { "type": "string" },
                    "priority": { "type": "string", "enum": ["high","medium","low"] },
                    "status": { "type": "string", "enum": ["todo","doing","blocked","done"] },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "runId": { "type": "string" },
                    "sessionId": { "type": "string" },
                    "userMessageId": { "type": "string" },
                    "tasks": { "oneOf": [ { "type": "array" }, { "type": "string" } ] }
                }
            }),
            Box::new(move |args| {
                let inputs = normalize_batch(&args)?;
                let created = if inputs.len() == 1 {
                    vec![store.borrow().add_task(inputs[0].clone())?]
                } else {
                    store.borrow_mut().add_tasks(inputs)?
                };
                Ok(text_result(json!({
                    "created": created.len(),
                    "defaultSessionId": session_id,
                    "defaultRunId": run_id,
                    "tasks": created
                })))
            }),
        );
    }

    {
        let store = store.clone();
        let session_id = session_id.clone();
        let run_id = run_id.clone();
        server.register_tool(
            "list_tasks",
            "List tasks with optional filters.",
            json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["todo","doing","blocked","done"] },
                    "tag": { "type": "string" },
                    "include_done": { "type": "boolean" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                    "sessionId": { "type": "string" },
                    "runId": { "type": "string" },
                    "all_sessions": { "type": "boolean" },
                    "all_runs": { "type": "boolean" }
                }
            }),
            Box::new(move |args| {
                let options = ListTasksOptions {
                    status: args.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    tag: args.get("tag").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    include_done: args.get("include_done").and_then(|v| v.as_bool()).unwrap_or(true),
                    limit: args.get("limit").and_then(|v| v.as_i64()),
                    session_id: args.get("sessionId").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    run_id: args.get("runId").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    all_sessions: args.get("all_sessions").and_then(|v| v.as_bool()).unwrap_or(false),
                    all_runs: args.get("all_runs").and_then(|v| v.as_bool()).unwrap_or(false),
                };
                let tasks = store.borrow().list_tasks(options)?;
                Ok(text_result(json!({
                    "count": tasks.len(),
                    "defaultSessionId": session_id,
                    "defaultRunId": run_id,
                    "tasks": tasks
                })))
            }),
        );
    }

    {
        let store = store.clone();
        server.register_tool(
            "update_task",
            "Update an existing task.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "title": { "type": "string" },
                    "details": { "type": "string" },
                    "append_note": { "type": "string" },
                    "priority": { "type": "string", "enum": ["high","medium","low"] },
                    "status": { "type": "string", "enum": ["todo","doing","blocked","done"] },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["id"]
            }),
            Box::new(move |args| {
                let id = args
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or("id is required".to_string())?;
                let patch = TaskUpdate {
                    title: args.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    details: args.get("details").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    append_note: args.get("append_note").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    priority: args.get("priority").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    status: args.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    tags: args.get("tags").and_then(|v| v.as_array()).map(|arr| {
                        arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
                    }),
                };
                let updated = store.borrow().update_task(id, patch)?;
                Ok(text_result(json!({ "updated": updated })))
            }),
        );
    }

    {
        let store = store.clone();
        server.register_tool(
            "complete_task",
            "Mark a task as completed and append a completion note.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "note": { "type": "string", "minLength": 5 }
                },
                "required": ["id", "note"]
            }),
            Box::new(move |args| {
                let id = args
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or("id is required".to_string())?;
                let note = args
                    .get("note")
                    .and_then(|v| v.as_str())
                    .ok_or("note is required".to_string())?;
                let updated = store.borrow().complete_task(id, note)?;
                Ok(text_result(json!({ "updated": updated })))
            }),
        );
    }

    {
        let store = store.clone();
        server.register_tool(
            "clear_tasks",
            "Clear completed tasks or all tasks within the current session scope.",
            json!({
                "type": "object",
                "properties": {
                    "mode": { "type": "string", "enum": ["done","all"] },
                    "sessionId": { "type": "string" },
                    "runId": { "type": "string" },
                    "all_sessions": { "type": "boolean" },
                    "all_runs": { "type": "boolean" }
                }
            }),
            Box::new(move |args| {
                let options = ClearTasksOptions {
                    mode: args.get("mode").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    session_id: args.get("sessionId").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    run_id: args.get("runId").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    all_sessions: args.get("all_sessions").and_then(|v| v.as_bool()).unwrap_or(false),
                    all_runs: args.get("all_runs").and_then(|v| v.as_bool()).unwrap_or(false),
                };
                let result: ClearResult = store.borrow().clear_tasks(options)?;
                Ok(text_result(json!(result)))
            }),
        );
    }

    if let Err(err) = server.run_stdio() {
        eprintln!("[{server_name}] Task MCP server crashed: {err}");
        std::process::exit(1);
    }
}

fn normalize_batch(payload: &serde_json::Value) -> Result<Vec<TaskInput>, String> {
    let tasks_value = payload.get("tasks");
    if let Some(tasks) = tasks_value {
        if tasks.is_string() {
            let raw = tasks.as_str().unwrap_or("").trim();
            if raw.is_empty() {
                return Err("tasks cannot be empty; omit the field or provide JSON array.".to_string());
            }
            let parsed: serde_json::Value = serde_json::from_str(raw)
                .map_err(|_| "tasks must be a JSON array string.".to_string())?;
            return parse_tasks_array(&parsed);
        }
        if tasks.is_array() {
            return parse_tasks_array(tasks);
        }
    }

    let title = payload.get("title").and_then(|v| v.as_str());
    if title.is_none() {
        return Err("add_task requires title or tasks.".to_string());
    }
    let input = build_task_input(payload)?;
    Ok(vec![input])
}

fn parse_tasks_array(value: &serde_json::Value) -> Result<Vec<TaskInput>, String> {
    let arr = value.as_array().ok_or("tasks must be an array".to_string())?;
    let mut inputs = Vec::new();
    for item in arr {
        let input = build_task_input(item)?;
        inputs.push(input);
    }
    Ok(inputs)
}

fn build_task_input(value: &serde_json::Value) -> Result<TaskInput, String> {
    let title = value
        .get("title")
        .and_then(|v| v.as_str())
        .ok_or("title is required".to_string())?;
    Ok(TaskInput {
        title: title.to_string(),
        details: value.get("details").and_then(|v| v.as_str()).map(|s| s.to_string()),
        priority: value.get("priority").and_then(|v| v.as_str()).map(|s| s.to_string()),
        status: value.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
        tags: value.get("tags").and_then(|v| v.as_array()).map(|arr| {
            arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
        }),
        run_id: value.get("runId").and_then(|v| v.as_str()).map(|s| s.to_string()),
        session_id: value.get("sessionId").and_then(|v| v.as_str()).map(|s| s.to_string()),
        user_message_id: value.get("userMessageId").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

fn text_result(data: serde_json::Value) -> serde_json::Value {
    let text = if data.is_string() {
        data.as_str().unwrap_or("").to_string()
    } else {
        serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".to_string())
    };
    json!({
        "content": [
            { "type": "text", "text": text }
        ]
    })
}

fn print_help() {
    println!(
        "Usage: task-mcp-server-rs [--name <id>] [--db <path>] [--session-id <id>] [--run-id <id>]\n\nOptions:\n  --name <id>        MCP server name (default task_manager)\n  --db <path>        SQLite file path\n  --session-id <id>  Session ID override\n  --run-id <id>      Run ID override\n  --admin-port <p>   Start admin HTTP server on port p\n  --admin-host <h>   Admin HTTP bind host (default 127.0.0.1)\n  --admin-ui-root <path>  Admin UI dist directory\n  --help             Show help"
    );
}

fn resolve_admin_ui_root(value: Option<&String>) -> Option<PathBuf> {
    if let Some(path) = value {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return None;
        }
        return Some(PathBuf::from(trimmed));
    }
    let candidate = PathBuf::from("admin-ui").join("dist");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}
