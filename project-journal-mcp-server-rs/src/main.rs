mod dedupe;
mod mcp;
mod state;
mod utils;

use crate::dedupe::{
    create_dedupe_store, flush_dedupe_store, read_dedupe_entry, remove_dedupe_entry,
    write_dedupe_entry, DedupeStore,
};
use crate::mcp::McpServer;
use crate::state::{resolve_app_state_dir, resolve_session_root, PROJECT_EXEC_LOG_FILE, PROJECT_INFO_FILE};
use crate::utils::{
    atomic_write_json, clamp_number, ensure_dir_required, ensure_file_exists, normalize_string_array, normalize_tags,
    now_iso, parse_args, resolve_path, safe_trim,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use uuid::Uuid;

const DEDUPE_MAX_ENTRIES: usize = 5000;
const DEDUPE_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const DEDUPE_MAX_IDS: usize = 20;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct ExecLogEntry {
    id: String,
    ts: String,
    title: String,
    tags: Vec<String>,
    summary: String,
    details: String,
    files: Vec<String>,
    highlights: Vec<String>,
    #[serde(rename = "nextSteps")]
    next_steps: Vec<String>,
    #[serde(rename = "runId")]
    run_id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct ProjectIteration {
    #[serde(default)]
    id: String,
    #[serde(default)]
    ts: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    details: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct ProjectInfo {
    #[serde(default)]
    version: i64,
    #[serde(default, rename = "createdAt")]
    created_at: String,
    #[serde(default, rename = "updatedAt")]
    updated_at: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    background: String,
    #[serde(default, rename = "gitUrl")]
    git_url: String,
    #[serde(default, rename = "mainConfig")]
    main_config: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    iterations: Vec<ProjectIteration>,
    #[serde(flatten)]
    extra: std::collections::HashMap<String, Value>,
}

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let args = parse_args(&argv);
    if args.flags.contains("help") || args.flags.contains("h") {
        print_help();
        return;
    }

    let env_workspace_root = env::var("MODEL_CLI_WORKSPACE_ROOT")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let env_session_root = env::var("MODEL_CLI_SESSION_ROOT")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let arg_session_root = args
        .values
        .get("root")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let explicit_session_root =
        env_workspace_root.is_some() || env_session_root.is_some() || arg_session_root.is_some();
    let session_root = env_workspace_root
        .clone()
        .or(env_session_root.clone())
        .or(arg_session_root)
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_session_root(true));
    let root = resolve_app_state_dir(&session_root, explicit_session_root, env_workspace_root.as_deref());

    if let Err(err) = ensure_dir_required(&root) {
        eprintln!("[project_journal] failed to create state dir: {err}");
        std::process::exit(1);
    }

    let server_name = args
        .values
        .get("name")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "project_journal".to_string());

    let exec_log_path = resolve_store_path(
        first_arg_value(&args, &["exec-log", "exec_log", "execLog"]).as_deref(),
        PROJECT_EXEC_LOG_FILE,
        &root,
    )
    .unwrap_or_else(|err| {
        eprintln!("[{server_name}] {err}");
        std::process::exit(1);
    });

    let project_info_path = resolve_store_path(
        first_arg_value(&args, &["project-info", "project_info", "projectInfo"]).as_deref(),
        PROJECT_INFO_FILE,
        &root,
    )
    .unwrap_or_else(|err| {
        eprintln!("[{server_name}] {err}");
        std::process::exit(1);
    });

    let dedupe_path = env::var("MODEL_CLI_PROJECT_JOURNAL_DEDUPE")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            exec_log_path
                .parent()
                .unwrap_or(&root)
                .join("project-journal-dedupe.json")
        });

    ensure_file_exists(&exec_log_path, "");
    ensure_json_file_exists(&project_info_path, &default_project_info());

    let dedupe_store = Rc::new(RefCell::new(create_dedupe_store(
        &dedupe_path,
        Some(DEDUPE_MAX_ENTRIES),
        Some(DEDUPE_TTL_MS),
        Some(DEDUPE_MAX_IDS),
    )));

    let mut server = McpServer::new(server_name.clone(), "0.1.0");

    register_tools(
        &mut server,
        &server_name,
        exec_log_path.clone(),
        project_info_path.clone(),
        dedupe_store.clone(),
    );

    eprintln!(
        "[{server_name}] MCP project journal server ready (logs={}, info={}).",
        relative_path(&root, &exec_log_path),
        relative_path(&root, &project_info_path)
    );

    if let Err(err) = server.run_stdio() {
        eprintln!("[{server_name}] MCP project journal server crashed: {err}");
        std::process::exit(1);
    }
}

fn register_tools(
    server: &mut McpServer,
    server_name: &str,
    exec_log_path: PathBuf,
    project_info_path: PathBuf,
    dedupe_store: Rc<RefCell<DedupeStore>>,
) {
    let server_name = server_name.to_string();
    {
        let exec_log_path = exec_log_path.clone();
        let dedupe_store = dedupe_store.clone();
        let server_name = server_name.clone();
        server.register_tool(
            "add_exec_log",
            "Record a per-project execution log entry (what was done, changed files, key changes).",
            json!({
                "type": "object",
                "properties": {
                    "tag": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "title": { "type": "string" },
                    "summary": { "type": "string" },
                    "details": { "type": "string" },
                    "files": { "type": "array", "items": { "type": "string" } },
                    "highlights": { "type": "array", "items": { "type": "string" } },
                    "next_steps": { "type": "array", "items": { "type": "string" } },
                    "dedupe_key": { "type": "string" },
                    "runId": { "type": "string" },
                    "sessionId": { "type": "string" }
                },
                "required": ["summary"]
            }),
            Box::new(move |args| {
                let summary = safe_trim(args.get("summary").and_then(|v| v.as_str()));
                if summary.is_empty() {
                    return Err("summary is required".to_string());
                }

                let run_id = pick_run_id(args.get("runId"));
                let session_id = pick_session_id(args.get("sessionId"));
                let dedupe_key = build_dedupe_key(
                    args.get("dedupe_key").and_then(|v| v.as_str()),
                    Some("exec_log"),
                    Some(&run_id),
                    Some(&session_id),
                );

                if !dedupe_key.is_empty() {
                    let mut store = dedupe_store.borrow_mut();
                    if let Some(existing_ids) = read_dedupe_entry(&mut store, &dedupe_key) {
                        if let Some(existing) = resolve_exec_log_from_ids(&exec_log_path, &existing_ids) {
                            write_dedupe_entry(&mut store, &dedupe_key, &[existing.id.clone()]);
                            flush_dedupe_store(&mut store);
                            let text = render_exec_log_summary(&existing, "Execution log already recorded (deduped)");
                            let payload = json!({
                                "status": "noop",
                                "entry": existing,
                                "deduped": true
                            });
                            return Ok(structured_response(&server_name, "add_exec_log", text, payload, None));
                        }
                        remove_dedupe_entry(&mut store, &dedupe_key);
                    }
                }

                let ts = now_iso();
                let tags = normalize_tags(args.get("tags"), args.get("tag"));
                let mut entry = ExecLogEntry {
                    id: Uuid::new_v4().to_string(),
                    ts: ts.clone(),
                    title: String::new(),
                    tags,
                    summary,
                    details: safe_trim(args.get("details").and_then(|v| v.as_str())),
                    files: normalize_string_array(args.get("files")),
                    highlights: normalize_string_array(args.get("highlights")),
                    next_steps: normalize_string_array(args.get("next_steps")),
                    run_id,
                    session_id,
                };

                let custom_title = safe_trim(args.get("title").and_then(|v| v.as_str()));
                entry.title = if custom_title.is_empty() {
                    build_default_title(&entry.ts, &entry.tags)
                } else {
                    custom_title
                };

                append_jsonl(&exec_log_path, &entry)?;

                if !dedupe_key.is_empty() {
                    let mut store = dedupe_store.borrow_mut();
                    write_dedupe_entry(&mut store, &dedupe_key, &[entry.id.clone()]);
                    flush_dedupe_store(&mut store);
                }

                let text = render_exec_log_summary(&entry, "Execution log recorded");
                let payload = json!({
                    "status": "ok",
                    "entry": entry,
                    "deduped": false
                });
                Ok(structured_response(&server_name, "add_exec_log", text, payload, None))
            }),
        );
    }

    {
        let exec_log_path = exec_log_path.clone();
        let server_name = server_name.clone();
        server.register_tool(
            "list_exec_logs",
            "List the most recent execution logs (newest first).",
            json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                    "tag": { "type": "string" },
                    "query": { "type": "string" }
                }
            }),
            Box::new(move |args| {
                let limit = args.get("limit");
                let tag = args.get("tag").and_then(|v| v.as_str());
                let query = args.get("query").and_then(|v| v.as_str());
                let capped = clamp_number(limit, 1, 200, 10) as usize;
                let logs = list_exec_logs(&exec_log_path, capped, tag, query);
                let text = format_exec_log_list(&logs);
                let payload = json!({
                    "status": "ok",
                    "logs": logs.iter().map(|e| json!({
                        "id": e.id.clone(),
                        "ts": e.ts.clone(),
                        "title": e.title.clone(),
                        "tags": e.tags.clone(),
                        "summary": e.summary.clone()
                    })).collect::<Vec<Value>>()
                });
                Ok(structured_response(&server_name, "list_exec_logs", text, payload, None))
            }),
        );
    }

    {
        let exec_log_path = exec_log_path.clone();
        let server_name = server_name.clone();
        server.register_tool(
            "get_exec_log",
            "Get a specific execution log entry by id.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
            Box::new(move |args| {
                let id = args
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default();
                if id.is_empty() {
                    return Err("id is required".to_string());
                }
                let entry = find_exec_log_by_id(&exec_log_path, &id);
                if let Some(entry) = entry {
                    let text = render_exec_log_detail(&entry);
                    let payload = json!({ "status": "ok", "entry": entry });
                    Ok(structured_response(&server_name, "get_exec_log", text, payload, None))
                } else {
                    let text = format!("Execution log not found (id={id}).");
                    let payload = json!({ "status": "not_found", "id": id });
                    Ok(structured_response(&server_name, "get_exec_log", text, payload, None))
                }
            }),
        );
    }

    {
        let exec_log_path = exec_log_path.clone();
        let server_name = server_name.clone();
        server.register_tool(
            "search_exec_logs",
            "Search execution logs by substring (title/summary/details/highlights).",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "tag": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                },
                "required": ["query"]
            }),
            Box::new(move |args| {
                let query = args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .map(|v| v.trim().to_string())
                    .unwrap_or_default();
                if query.is_empty() {
                    return Err("query is required".to_string());
                }
                let tag = args.get("tag").and_then(|v| v.as_str());
                let limit = args.get("limit");
                let capped = clamp_number(limit, 1, 200, 20) as usize;
                let logs = list_exec_logs(&exec_log_path, capped, tag, Some(&query));
                let text = format_exec_log_list(&logs);
                let payload = json!({
                    "status": "ok",
                    "logs": logs.iter().map(|e| json!({
                        "id": e.id.clone(),
                        "ts": e.ts.clone(),
                        "title": e.title.clone(),
                        "tags": e.tags.clone(),
                        "summary": e.summary.clone()
                    })).collect::<Vec<Value>>()
                });
                Ok(structured_response(&server_name, "search_exec_logs", text, payload, None))
            }),
        );
    }

    {
        let project_info_path = project_info_path.clone();
        let server_name = server_name.clone();
        server.register_tool(
            "get_project_info",
            "Read per-project notes (background, summary, git URL, key configs, iteration notes).",
            json!({
                "type": "object",
                "properties": {
                    "include_iterations": { "type": "boolean" },
                    "iterations_limit": { "type": "integer", "minimum": 0, "maximum": 50 }
                }
            }),
            Box::new(move |args| {
                let info = read_project_info(&project_info_path);
                let include_iterations = args
                    .get("include_iterations")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let limit = args.get("iterations_limit");
                let payload = project_info_for_output(&info, include_iterations, limit);
                let text = render_project_info_text(&payload);
                let payload_value = json!({ "status": "ok", "info": payload });
                Ok(structured_response(&server_name, "get_project_info", text, payload_value, None))
            }),
        );
    }

    {
        let project_info_path = project_info_path.clone();
        let server_name = server_name.clone();
        server.register_tool(
            "set_project_info",
            "Create or update the per-project info note (rarely-changing notes).",
            json!({
                "type": "object",
                "properties": {
                    "summary": { "type": "string" },
                    "background": { "type": "string" },
                    "git_url": { "type": "string" },
                    "main_config": { "type": "string" },
                    "notes": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "overwrite": { "type": "boolean" }
                }
            }),
            Box::new(move |args| {
                let overwrite = args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
                let updated = write_project_info(&project_info_path, args, overwrite)?;
                let limit_value = Value::from(10);
                let payload = project_info_for_output(&updated, true, Some(&limit_value));
                let payload_value = json!({ "status": "ok", "info": payload });
                Ok(structured_response(
                    &server_name,
                    "set_project_info",
                    "Project info saved.".to_string(),
                    payload_value,
                    None,
                ))
            }),
        );
    }

    {
        let project_info_path = project_info_path.clone();
        let dedupe_store = dedupe_store.clone();
        let server_name = server_name.clone();
        server.register_tool(
            "add_project_iteration",
            "Append a lightweight iteration/changelog entry into project info.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "summary": { "type": "string" },
                    "details": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "dedupe_key": { "type": "string" }
                },
                "required": ["title"]
            }),
            Box::new(move |args| {
                let title = safe_trim(args.get("title").and_then(|v| v.as_str()));
                if title.is_empty() {
                    return Err("title is required".to_string());
                }

                let dedupe_key = build_dedupe_key(args.get("dedupe_key").and_then(|v| v.as_str()), Some("iteration"), None, None);
                if !dedupe_key.is_empty() {
                    let mut store = dedupe_store.borrow_mut();
                    if let Some(existing_ids) = read_dedupe_entry(&mut store, &dedupe_key) {
                        if let Some(existing) = resolve_iteration_from_ids(&project_info_path, &existing_ids) {
                            write_dedupe_entry(&mut store, &dedupe_key, &[existing.id.clone()]);
                            flush_dedupe_store(&mut store);
                            let info = read_project_info(&project_info_path);
                            let limit_value = Value::from(10);
                            let payload = project_info_for_output(&info, true, Some(&limit_value));
                            let payload_value = json!({
                                "status": "noop",
                                "iteration": existing,
                                "info": payload,
                                "deduped": true
                            });
                            return Ok(structured_response(
                                &server_name,
                                "add_project_iteration",
                                "Project iteration already saved (deduped).".to_string(),
                                payload_value,
                                None,
                            ));
                        }
                        remove_dedupe_entry(&mut store, &dedupe_key);
                    }
                }

                let mut info = read_project_info(&project_info_path);
                let now = now_iso();
                let entry = ProjectIteration {
                    id: Uuid::new_v4().to_string(),
                    ts: now.clone(),
                    title,
                    summary: safe_trim(args.get("summary").and_then(|v| v.as_str())),
                    details: safe_trim(args.get("details").and_then(|v| v.as_str())),
                    tags: normalize_tags(args.get("tags"), None),
                };

                let mut iterations = info.iterations.clone();
                iterations.insert(0, entry.clone());
                info.iterations = iterations;
                info.updated_at = now.clone();
                if info.created_at.trim().is_empty() {
                    info.created_at = now.clone();
                }
                info.version = 1;
                atomic_write_json(&project_info_path, &info)
                    .map_err(|err| format!("failed to save project info: {err}"))?;

                if !dedupe_key.is_empty() {
                    let mut store = dedupe_store.borrow_mut();
                    write_dedupe_entry(&mut store, &dedupe_key, &[entry.id.clone()]);
                    flush_dedupe_store(&mut store);
                }

                let limit_value = Value::from(10);
                let payload = project_info_for_output(&info, true, Some(&limit_value));
                let payload_value = json!({
                    "status": "ok",
                    "iteration": entry,
                    "info": payload,
                    "deduped": false
                });
                Ok(structured_response(
                    &server_name,
                    "add_project_iteration",
                    "Project iteration saved.".to_string(),
                    payload_value,
                    None,
                ))
            }),
        );
    }
}

fn structured_response(
    server_name: &str,
    tool: &str,
    text: String,
    payload: Value,
    trace: Option<Value>,
) -> Value {
    let mut content = payload.as_object().cloned().unwrap_or_default();
    let status_from_payload = content
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("ok")
        .to_string();

    let mut chatos = content
        .get("chatos")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    chatos.insert("status".to_string(), Value::String(status_from_payload));
    chatos.insert("server".to_string(), Value::String(server_name.to_string()));
    chatos.insert("tool".to_string(), Value::String(tool.to_string()));
    if let Some(code) = content.get("code").and_then(|v| v.as_str()) {
        if !code.trim().is_empty() {
            chatos.insert("code".to_string(), Value::String(code.to_string()));
        }
    }
    if let Some(error) = content.get("error") {
        chatos.insert("error".to_string(), error.clone());
    }
    if let Some(trace) = trace {
        chatos.insert("trace".to_string(), trace);
    }
    chatos.insert("ts".to_string(), Value::String(now_iso()));

    content.insert("chatos".to_string(), Value::Object(chatos));

    json!({
        "content": [
            { "type": "text", "text": text }
        ],
        "structuredContent": Value::Object(content)
    })
}

fn default_project_info() -> ProjectInfo {
    let now = now_iso();
    ProjectInfo {
        version: 1,
        created_at: now.clone(),
        updated_at: now,
        summary: String::new(),
        background: String::new(),
        git_url: String::new(),
        main_config: String::new(),
        notes: String::new(),
        tags: Vec::new(),
        iterations: Vec::new(),
        extra: std::collections::HashMap::new(),
    }
}

fn ensure_json_file_exists(path: &Path, default_info: &ProjectInfo) {
    if path.exists() {
        return;
    }
    let _ = atomic_write_json(path, default_info);
}

fn read_project_info(path: &Path) -> ProjectInfo {
    let fallback = default_project_info();
    if !path.exists() {
        return fallback;
    }
    let raw = fs::read_to_string(path).unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback;
    }
    let mut info: ProjectInfo = serde_json::from_str(trimmed).unwrap_or_else(|_| fallback.clone());
    info.version = 1;
    info.tags = unique_strings(&info.tags);
    info
}

fn write_project_info(path: &Path, input: Value, overwrite: bool) -> Result<ProjectInfo, String> {
    let now = now_iso();
    let prev = read_project_info(path);
    let mut base = if overwrite { default_project_info() } else { prev.clone() };

    if let Some(summary) = input.get("summary").and_then(|v| v.as_str()) {
        base.summary = summary.to_string();
    }
    if let Some(background) = input.get("background").and_then(|v| v.as_str()) {
        base.background = background.to_string();
    }
    if let Some(git_url) = input.get("git_url").and_then(|v| v.as_str()) {
        base.git_url = git_url.to_string();
    }
    if let Some(main_config) = input.get("main_config").and_then(|v| v.as_str()) {
        base.main_config = main_config.to_string();
    }
    if let Some(notes) = input.get("notes").and_then(|v| v.as_str()) {
        base.notes = notes.to_string();
    }
    if let Some(tags) = input.get("tags") {
        base.tags = normalize_tags(Some(tags), None);
    }

    if base.created_at.trim().is_empty() {
        base.created_at = prev.created_at.clone();
    }
    if base.created_at.trim().is_empty() {
        base.created_at = now.clone();
    }
    base.updated_at = now;
    base.version = 1;
    if base.iterations.is_empty() {
        base.iterations = Vec::new();
    }
    base.tags = unique_strings(&base.tags);

    atomic_write_json(path, &base).map_err(|err| format!("failed to write project info: {err}"))?;
    Ok(base)
}

fn project_info_for_output(info: &ProjectInfo, include_iterations: bool, limit_value: Option<&Value>) -> Value {
    let limit = clamp_number(limit_value, 0, 50, 10) as usize;
    let iterations = if include_iterations {
        info.iterations.iter().take(limit).cloned().collect::<Vec<ProjectIteration>>()
    } else {
        Vec::new()
    };
    json!({
        "version": 1,
        "createdAt": info.created_at.clone(),
        "updatedAt": info.updated_at.clone(),
        "summary": info.summary.clone(),
        "background": info.background.clone(),
        "gitUrl": info.git_url.clone(),
        "mainConfig": info.main_config.clone(),
        "notes": info.notes.clone(),
        "tags": info.tags.clone(),
        "iterations": iterations
    })
}

fn render_project_info_text(payload: &Value) -> String {
    let updated = payload.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("");
    let git_url = payload.get("gitUrl").and_then(|v| v.as_str()).unwrap_or("");
    let summary = payload.get("summary").and_then(|v| v.as_str()).unwrap_or("");
    let background = payload.get("background").and_then(|v| v.as_str()).unwrap_or("");
    let main_config = payload.get("mainConfig").and_then(|v| v.as_str()).unwrap_or("");
    let notes = payload.get("notes").and_then(|v| v.as_str()).unwrap_or("");

    let tags = payload
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    let mut lines = Vec::new();
    lines.push("Project info".to_string());
    lines.push(format!(
        "Updated: {}",
        if updated.is_empty() { "<unknown>" } else { updated }
    ));
    lines.push(if git_url.is_empty() {
        "Git: <empty>".to_string()
    } else {
        format!("Git: {git_url}")
    });
    lines.push(if tags.is_empty() {
        "Tags: <empty>".to_string()
    } else {
        format!("Tags: #{}", tags.join(" #"))
    });
    lines.push("".to_string());
    lines.push(if summary.is_empty() {
        "Summary: <empty>".to_string()
    } else {
        format!("Summary:\n{summary}")
    });
    lines.push("".to_string());
    lines.push(if background.is_empty() {
        "Background: <empty>".to_string()
    } else {
        format!("Background:\n{background}")
    });
    lines.push("".to_string());
    lines.push(if main_config.is_empty() {
        "Main config: <empty>".to_string()
    } else {
        format!("Main config:\n{main_config}")
    });
    lines.push("".to_string());
    lines.push(if notes.is_empty() {
        "Notes: <empty>".to_string()
    } else {
        format!("Notes:\n{notes}")
    });

    if let Some(iterations) = payload.get("iterations").and_then(|v| v.as_array()) {
        if !iterations.is_empty() {
            lines.push("".to_string());
            lines.push("Iterations (latest first):".to_string());
            for it in iterations {
                let ts = it.get("ts").and_then(|v| v.as_str()).unwrap_or("<unknown>");
                let title = it.get("title").and_then(|v| v.as_str()).unwrap_or("<untitled>");
                let summary = it.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                let id = it.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let tags = it
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .map(|s| s.to_string())
                            .collect::<Vec<String>>()
                    })
                    .unwrap_or_default();
                let tag_text = if tags.is_empty() {
                    "".to_string()
                } else {
                    format!(" #{}", tags.join(" #"))
                };
                let summary_text = if summary.is_empty() {
                    "".to_string()
                } else {
                    format!(" - {summary}")
                };
                lines.push(format!("- {ts} {title}{summary_text}{tag_text} (id={id})"));
            }
        }
    }

    lines.join("\n")
}

fn build_default_title(ts: &str, tags: &[String]) -> String {
    if tags.is_empty() {
        ts.to_string()
    } else {
        format!("{ts} #{}", tags.join(" #"))
    }
}

fn render_exec_log_summary(entry: &ExecLogEntry, header: &str) -> String {
    let mut parts = Vec::new();
    if !header.trim().is_empty() {
        parts.push(header.to_string());
    }
    parts.push(entry.title.clone());
    parts.push(format!("id={}", entry.id));
    if !entry.summary.is_empty() {
        parts.push(format!("summary: {}", entry.summary));
    }
    if !entry.files.is_empty() {
        parts.push(format!("files: {}", entry.files.join(", ")));
    }
    if !entry.highlights.is_empty() {
        parts.push(format!("highlights: {}", entry.highlights.join(" | ")));
    }
    if !entry.next_steps.is_empty() {
        parts.push(format!("next: {}", entry.next_steps.join(" | ")));
    }
    parts.join("\n")
}

fn render_exec_log_detail(entry: &ExecLogEntry) -> String {
    let tag_text = if entry.tags.is_empty() {
        "<none>".to_string()
    } else {
        format!("#{}", entry.tags.join(" #"))
    };

    let render_list = |items: &Vec<String>| -> String {
        if items.is_empty() {
            return " <empty>".to_string();
        }
        format!("\n  - {}", items.join("\n  - "))
    };

    let mut lines = Vec::new();
    lines.push(if entry.title.is_empty() {
        "<untitled>".to_string()
    } else {
        entry.title.clone()
    });
    lines.push(format!("id: {}", entry.id));
    lines.push(format!(
        "ts: {}",
        if entry.ts.is_empty() { "<unknown>" } else { entry.ts.as_str() }
    ));
    lines.push(format!("tags: {}", tag_text));
    lines.push(format!(
        "runId: {}",
        if entry.run_id.is_empty() { "<unspecified>" } else { entry.run_id.as_str() }
    ));
    lines.push(format!(
        "sessionId: {}",
        if entry.session_id.is_empty() { "<unspecified>" } else { entry.session_id.as_str() }
    ));
    lines.push(String::new());
    lines.push(format!(
        "summary: {}",
        if entry.summary.is_empty() { "<empty>" } else { entry.summary.as_str() }
    ));
    if entry.details.is_empty() {
        lines.push("details: <empty>".to_string());
    } else {
        lines.push(format!("details:\n{}", entry.details));
    }
    lines.push(String::new());
    lines.push(format!("files:{}", render_list(&entry.files)));
    lines.push(String::new());
    lines.push(format!("highlights:{}", render_list(&entry.highlights)));
    lines.push(String::new());
    lines.push(format!("next_steps:{}", render_list(&entry.next_steps)));
    lines.join("\n")
}

fn format_exec_log_list(logs: &Vec<ExecLogEntry>) -> String {
    if logs.is_empty() {
        return "No execution logs yet. Use add_exec_log to record one.".to_string();
    }
    let mut lines = Vec::new();
    for (idx, entry) in logs.iter().enumerate() {
        let tag_text = if entry.tags.is_empty() {
            "".to_string()
        } else {
            format!(" #{}", entry.tags.join(" #"))
        };
        let title = if entry.title.is_empty() {
            if entry.ts.is_empty() {
                format!("<unknown>{tag_text}")
            } else {
                format!("{}{}", entry.ts, tag_text)
            }
        } else {
            format!("{}{}", entry.title, tag_text)
        };
        let summary = if entry.summary.is_empty() {
            "".to_string()
        } else {
            format!(" - {}", entry.summary)
        };
        lines.push(format!("{:>2}. {title}{summary} (id={})", idx + 1, entry.id));
    }
    lines.join("\n")
}

fn list_exec_logs(
    path: &Path,
    limit: usize,
    tag: Option<&str>,
    query: Option<&str>,
) -> Vec<ExecLogEntry> {
    let capped = if limit == 0 { 10 } else { limit };
    let q = safe_trim(query);
    let q_lower = q.to_lowercase();
    let tag_filter = safe_trim(tag);
    let all = read_exec_logs(path);
    let mut result = Vec::new();
    for entry in all.iter().rev() {
        if !tag_filter.is_empty() {
            if !entry.tags.contains(&tag_filter) {
                continue;
            }
        }
        if !q_lower.is_empty() && !matches_exec_log_query(entry, &q_lower) {
            continue;
        }
        result.push(entry.clone());
        if result.len() >= capped {
            break;
        }
    }
    result
}

fn matches_exec_log_query(entry: &ExecLogEntry, query_lower: &str) -> bool {
    let fields = [
        entry.title.clone(),
        entry.summary.clone(),
        entry.details.clone(),
        entry.highlights.join(" "),
        entry.files.join(" "),
    ];
    fields
        .iter()
        .any(|text| text.to_lowercase().contains(query_lower))
}

fn find_exec_log_by_id(path: &Path, id: &str) -> Option<ExecLogEntry> {
    let target = safe_trim(Some(id));
    if target.is_empty() {
        return None;
    }
    let all = read_exec_logs(path);
    for entry in all.iter().rev() {
        if entry.id == target {
            return Some(entry.clone());
        }
    }
    None
}

fn resolve_exec_log_from_ids(path: &Path, ids: &[String]) -> Option<ExecLogEntry> {
    for id in ids {
        if let Some(entry) = find_exec_log_by_id(path, id) {
            return Some(entry);
        }
    }
    None
}

fn resolve_iteration_from_ids(path: &Path, ids: &[String]) -> Option<ProjectIteration> {
    if ids.is_empty() {
        return None;
    }
    let info = read_project_info(path);
    for id in ids {
        if let Some(found) = info.iterations.iter().find(|entry| entry.id == *id) {
            return Some(found.clone());
        }
    }
    None
}

fn read_exec_logs(path: &Path) -> Vec<ExecLogEntry> {
    if !path.exists() {
        return Vec::new();
    }
    let raw = fs::read_to_string(path).unwrap_or_default();
    let mut entries = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let entry = exec_log_entry_from_value(&value);
        if let Some(entry) = entry {
            if !entry.id.is_empty() {
                entries.push(entry);
            }
        }
    }
    entries
}

fn exec_log_entry_from_value(value: &Value) -> Option<ExecLogEntry> {
    let obj = value.as_object()?;
    let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        return None;
    }
    Some(ExecLogEntry {
        id,
        ts: obj.get("ts").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        title: obj.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        tags: obj
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.to_string())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default(),
        summary: obj.get("summary").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        details: obj.get("details").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        files: obj
            .get("files")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.to_string())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default(),
        highlights: obj
            .get("highlights")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.to_string())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default(),
        next_steps: obj
            .get("nextSteps")
            .or_else(|| obj.get("next_steps"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.to_string())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default(),
        run_id: obj
            .get("runId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        session_id: obj
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn append_jsonl(path: &Path, entry: &ExecLogEntry) -> Result<(), String> {
    ensure_file_exists(path, "");
    let serialized = serde_json::to_string(entry).map_err(|err| format!("failed to serialize entry: {err}"))?;
    let payload = format!("{serialized}\n");
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(payload.as_bytes()))
        .map_err(|err| format!("failed to append exec log: {err}"))?;
    Ok(())
}

fn build_dedupe_key(raw_key: Option<&str>, scope: Option<&str>, run_id: Option<&str>, session_id: Option<&str>) -> String {
    let key = safe_trim(raw_key);
    if key.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    if let Some(scope) = scope {
        let trimmed = safe_trim(Some(scope));
        if !trimmed.is_empty() {
            parts.push(trimmed);
        }
    }
    if let Some(run) = run_id {
        let trimmed = safe_trim(Some(run));
        if !trimmed.is_empty() {
            parts.push(format!("run={trimmed}"));
        }
    }
    if let Some(session) = session_id {
        let trimmed = safe_trim(Some(session));
        if !trimmed.is_empty() {
            parts.push(format!("session={trimmed}"));
        }
    }
    if parts.is_empty() {
        key
    } else {
        format!("{}::{key}", parts.join("|"))
    }
}

fn pick_session_id(candidate: Option<&Value>) -> String {
    let normalized = candidate
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if !normalized.is_empty() {
        return normalized;
    }
    env::var("MODEL_CLI_SESSION_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

fn pick_run_id(candidate: Option<&Value>) -> String {
    let normalized = candidate
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if !normalized.is_empty() {
        return normalized;
    }
    env::var("MODEL_CLI_RUN_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

fn resolve_store_path(raw_value: Option<&str>, default_rel: &str, root: &Path) -> Result<PathBuf, String> {
    let raw = safe_trim(raw_value);
    let candidate = if raw.is_empty() { default_rel } else { raw.as_str() };
    let resolved = if Path::new(candidate).is_absolute() {
        PathBuf::from(candidate)
    } else {
        resolve_path(root, candidate)
    };

    let rel = pathdiff::diff_paths(&resolved, root).ok_or_else(|| {
        format!("Store path must stay inside root: {candidate}")
    })?;
    let rel_str = rel.to_string_lossy();
    if rel_str.is_empty() || rel.is_absolute() || rel_str.starts_with("..") {
        return Err(format!("Store path must stay inside root: {candidate}"));
    }
    Ok(resolved)
}

fn relative_path(root: &Path, target: &Path) -> String {
    let rel = pathdiff::diff_paths(target, root).unwrap_or_else(|| PathBuf::from(""));
    let rel_str = rel.to_string_lossy();
    if rel_str.is_empty() || rel_str.starts_with("..") {
        target.display().to_string()
    } else {
        rel_str.to_string()
    }
}

fn first_arg_value(args: &crate::utils::ParsedArgs, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = args.values.get(*key) {
            return Some(value.clone());
        }
    }
    None
}

fn unique_strings(items: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }
        let text = trimmed.to_string();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

fn print_help() {
    println!(
        "Usage: project-journal-mcp-server-rs [--root <path>] [--name <id>] [--exec-log <path>] [--project-info <path>]\n\nOptions:\n  --root <path>          Legacy session root hint (fallback when MODEL_CLI_SESSION_ROOT is not set)\n  --name <id>            MCP server name (default project_journal)\n  --exec-log <path>      Exec log JSONL path (default project-exec-log.jsonl under per-app stateDir)\n  --project-info <path>  Project info JSON path (default project-info.json under per-app stateDir)\n  --help                 Show help"
    );
}
