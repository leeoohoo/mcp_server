use crate::task_store::{ClearResult, TaskStore, TaskUpdate};
use crate::types::{ClearTasksOptions, ListTasksOptions, TaskInput};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct AdminServerOptions {
    pub server_name: String,
    pub db_path: String,
    pub default_session_id: String,
    pub default_run_id: String,
    pub host: String,
    pub port: u16,
    pub admin_ui_root: Option<PathBuf>,
}

pub fn run_admin_server(options: AdminServerOptions) -> Result<(), String> {
    let addr = format!("{}:{}", options.host, options.port);
    let listener = TcpListener::bind(&addr).map_err(|err| err.to_string())?;
    eprintln!("[{}] Admin UI listening on http://{}", options.server_name, addr);
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let opts = options.clone();
                std::thread::spawn(move || {
                    let _ = handle_client(stream, &opts);
                });
            }
            Err(err) => {
                eprintln!("[{}] admin accept error: {}", options.server_name, err);
            }
        }
    }
    Ok(())
}

fn handle_client(mut stream: TcpStream, options: &AdminServerOptions) -> Result<(), String> {
    let mut reader = BufReader::new(&mut stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).map_err(|err| err.to_string())? == 0 {
        return Ok(());
    }
    let request_line = request_line.trim_end_matches(['\r', '\n']);
    if request_line.is_empty() {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let (path, query) = split_path_query(target);

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line).map_err(|err| err.to_string())?;
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }

    if method == "OPTIONS" {
        send_empty(&mut stream, 204)?;
        return Ok(());
    }

    let mut body = Vec::new();
    if let Some(len) = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        let mut buf = vec![0u8; len];
        reader.read_exact(&mut buf).map_err(|err| err.to_string())?;
        body = buf;
    }

    if path.starts_with("/api/") {
        return handle_api(&mut stream, method, path, query, body, options);
    }

    if method != "GET" && method != "HEAD" {
        send_text(&mut stream, 405, "Method Not Allowed")?;
        return Ok(());
    }

    if let Some(root) = &options.admin_ui_root {
        serve_static(&mut stream, root, path, method == "HEAD")?;
        return Ok(());
    }

    send_text(&mut stream, 404, "Not Found")?;
    Ok(())
}

fn handle_api(
    stream: &mut TcpStream,
    method: &str,
    path: &str,
    query: HashMap<String, String>,
    body: Vec<u8>,
    options: &AdminServerOptions,
) -> Result<(), String> {
    if method == "GET" && path == "/api/status" {
        return send_json(
            stream,
            200,
            json!({
                "ok": true,
                "server_name": options.server_name,
                "db_path": options.db_path,
                "session_id": options.default_session_id,
                "run_id": options.default_run_id
            }),
        );
    }

    if method == "GET" && path == "/api/tasks" {
        let store = TaskStore::new(
            &options.db_path,
            options.default_session_id.clone(),
            options.default_run_id.clone(),
        )?;
        let opts = ListTasksOptions {
            status: query.get("status").cloned().filter(|v| !v.is_empty()),
            tag: query.get("tag").cloned().filter(|v| !v.is_empty()),
            include_done: parse_bool(query.get("include_done"), true),
            limit: query.get("limit").and_then(|v| v.parse::<i64>().ok()),
            session_id: query.get("session_id").cloned().filter(|v| !v.is_empty()),
            run_id: query.get("run_id").cloned().filter(|v| !v.is_empty()),
            all_sessions: parse_bool(query.get("all_sessions"), false),
            all_runs: parse_bool(query.get("all_runs"), false),
        };
        let tasks = store.list_tasks(opts)?;
        return send_json(
            stream,
            200,
            json!({
                "ok": true,
                "count": tasks.len(),
                "tasks": tasks
            }),
        );
    }

    let payload = if !body.is_empty() {
        serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    if method == "POST" && path == "/api/tasks" {
        let mut store = TaskStore::new(
            &options.db_path,
            options.default_session_id.clone(),
            options.default_run_id.clone(),
        )?;
        let created = if let Some(list) = payload.get("tasks").and_then(|v| v.as_array()) {
            let inputs = list
                .iter()
                .map(|item| parse_task_input(item))
                .collect::<Result<Vec<_>, String>>()?;
            store.add_tasks(inputs)?
        } else {
            let input = parse_task_input(&payload)?;
            vec![store.add_task(input)?]
        };
        return send_json(
            stream,
            200,
            json!({ "ok": true, "created": created.len(), "tasks": created }),
        );
    }

    if method == "POST" && path == "/api/tasks/update" {
        let id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("id is required".to_string())?;
        let patch = TaskUpdate {
            title: payload.get("title").and_then(|v| v.as_str()).map(|v| v.to_string()),
            details: payload.get("details").and_then(|v| v.as_str()).map(|v| v.to_string()),
            append_note: payload
                .get("append_note")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            priority: payload
                .get("priority")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            status: payload
                .get("status")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            tags: payload.get("tags").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            }),
        };
        let store = TaskStore::new(
            &options.db_path,
            options.default_session_id.clone(),
            options.default_run_id.clone(),
        )?;
        let updated = store.update_task(id, patch)?;
        return send_json(stream, 200, json!({ "ok": true, "task": updated }));
    }

    if method == "POST" && path == "/api/tasks/complete" {
        let id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("id is required".to_string())?;
        let note = payload
            .get("note")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let store = TaskStore::new(
            &options.db_path,
            options.default_session_id.clone(),
            options.default_run_id.clone(),
        )?;
        let updated = store.complete_task(id, note)?;
        return send_json(stream, 200, json!({ "ok": true, "task": updated }));
    }

    if method == "POST" && path == "/api/tasks/clear" {
        let opts = ClearTasksOptions {
            mode: payload.get("mode").and_then(|v| v.as_str()).map(|v| v.to_string()),
            session_id: payload.get("session_id").and_then(|v| v.as_str()).map(|v| v.to_string()),
            run_id: payload.get("run_id").and_then(|v| v.as_str()).map(|v| v.to_string()),
            all_sessions: payload.get("all_sessions").and_then(|v| v.as_bool()).unwrap_or(false),
            all_runs: payload.get("all_runs").and_then(|v| v.as_bool()).unwrap_or(false),
        };
        let store = TaskStore::new(
            &options.db_path,
            options.default_session_id.clone(),
            options.default_run_id.clone(),
        )?;
        let result: ClearResult = store.clear_tasks(opts)?;
        return send_json(stream, 200, json!({ "ok": true, "result": result }));
    }

    send_text(stream, 404, "Not Found")?;
    Ok(())
}

fn parse_task_input(value: &Value) -> Result<TaskInput, String> {
    let title = value
        .get("title")
        .and_then(|v| v.as_str())
        .ok_or("title is required".to_string())?;
    Ok(TaskInput {
        title: title.to_string(),
        details: value.get("details").and_then(|v| v.as_str()).map(|v| v.to_string()),
        priority: value
            .get("priority")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        status: value.get("status").and_then(|v| v.as_str()).map(|v| v.to_string()),
        tags: value.get("tags").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        }),
        run_id: value.get("run_id").and_then(|v| v.as_str()).map(|v| v.to_string()),
        session_id: value.get("session_id").and_then(|v| v.as_str()).map(|v| v.to_string()),
        user_message_id: value
            .get("user_message_id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
    })
}

fn parse_bool(value: Option<&String>, default: bool) -> bool {
    value
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

fn split_path_query(target: &str) -> (&str, HashMap<String, String>) {
    if let Some((path, query)) = target.split_once('?') {
        let params = query
            .split('&')
            .filter_map(|pair| {
                if pair.is_empty() {
                    return None;
                }
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                Some((url_decode(k), url_decode(v)))
            })
            .collect::<HashMap<_, _>>();
        (path, params)
    } else {
        (target, HashMap::new())
    }
}

fn url_decode(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.as_bytes().iter().cloned();
    while let Some(ch) = chars.next() {
        match ch {
            b'+' => out.push(' '),
            b'%' => {
                let a = chars.next();
                let b = chars.next();
                if let (Some(a), Some(b)) = (a, b) {
                    if let Ok(hex) = u8::from_str_radix(&format!("{}{}", a as char, b as char), 16) {
                        out.push(hex as char);
                    }
                }
            }
            _ => out.push(ch as char),
        }
    }
    out
}

fn serve_static(stream: &mut TcpStream, root: &Path, path: &str, head_only: bool) -> Result<(), String> {
    let mut rel = path.trim_start_matches('/');
    if rel.is_empty() {
        rel = "index.html";
    }
    let rel_path = Path::new(rel);
    if rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return send_text(stream, 403, "Forbidden");
    }
    let mut full_path = root.join(rel_path);
    if full_path.is_dir() {
        full_path = full_path.join("index.html");
    }
    if !full_path.exists() {
        let fallback = root.join("index.html");
        if fallback.exists() {
            full_path = fallback;
        } else {
            return send_text(stream, 404, "Not Found");
        }
    }
    let contents = fs::read(&full_path).map_err(|err| err.to_string())?;
    let content_type = content_type_for(&full_path);
    send_bytes(stream, 200, &content_type, &contents, head_only)?;
    Ok(())
}

fn content_type_for(path: &Path) -> String {
    match path.extension().and_then(|v| v.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn send_json(stream: &mut TcpStream, code: u16, value: Value) -> Result<(), String> {
    let body = serde_json::to_string(&value).map_err(|err| err.to_string())?;
    send_response(stream, code, "application/json; charset=utf-8", body.as_bytes(), false)
}

fn send_text(stream: &mut TcpStream, code: u16, text: &str) -> Result<(), String> {
    send_response(stream, code, "text/plain; charset=utf-8", text.as_bytes(), false)
}

fn send_empty(stream: &mut TcpStream, code: u16) -> Result<(), String> {
    send_response(stream, code, "text/plain; charset=utf-8", &[], true)
}

fn send_bytes(
    stream: &mut TcpStream,
    code: u16,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> Result<(), String> {
    send_response(stream, code, content_type, body, head_only)
}

fn send_response(
    stream: &mut TcpStream,
    code: u16,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> Result<(), String> {
    let status_text = match code {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET,POST,OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n\r\n",
        code,
        status_text,
        content_type,
        body.len()
    );
    stream.write_all(header.as_bytes()).map_err(|err| err.to_string())?;
    if !head_only {
        stream.write_all(body).map_err(|err| err.to_string())?;
    }
    stream.flush().map_err(|err| err.to_string())?;
    Ok(())
}
