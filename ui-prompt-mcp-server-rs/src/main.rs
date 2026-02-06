mod admin_server;
mod db;
mod mcp;
mod prompt;
mod state;
mod tty;
mod utils;

use crate::admin_server::{run_admin_server, AdminServerOptions};
use crate::db::UiPromptDb;
use crate::mcp::McpServer;
use crate::prompt::{
    collect_secret_keys, kv_fields_to_value, normalize_choice_limits, normalize_choice_options,
    normalize_choice_selection, normalize_default_selection, normalize_kv_fields, normalize_kv_values,
    redact_kv_fields_for_log, redact_prompt_entry, ChoiceLimits, ChoiceOption, KvField, LimitMode,
};
use crate::state::{ensure_dir, normalize_name, resolve_state_dir};
use crate::tty::{create_tty_prompt, PromptBackend, TtyPrompt};
use crate::utils::{now_iso, parse_args, safe_trim};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::env;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const MAX_WAIT_MS: i64 = 2_147_483_647;
const SECRET_MASK: &str = "******";

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let args = parse_args(&argv);
    if args.flags.contains("help") || args.flags.contains("h") {
        print_help();
        return;
    }

    let server_name = args
        .values
        .get("name")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "ui_prompter".to_string());

    let run_id = env::var("MODEL_CLI_RUN_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let state_dir = resolve_state_dir(&server_name);
    ensure_dir(&state_dir).expect("failed to create state dir");
    let db_file = format!("{}.db.sqlite", normalize_name(&server_name));
    let db_path = state_dir.join(db_file);
    let db = UiPromptDb::open(&db_path).expect("failed to open ui prompt db");
    let db = Rc::new(RefCell::new(db));

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
            db_path: db_path.to_string_lossy().to_string(),
            host: admin_host,
            port,
            admin_ui_root,
        };
        std::thread::spawn(move || {
            if let Err(err) = run_admin_server(options) {
                eprintln!("[ui-prompt-admin] {err}");
            }
        });
    }

    let mut server = McpServer::new(server_name.clone(), "0.1.0");

    {
        let server_name = server_name.clone();
        let run_id = run_id.clone();
        let db = db.clone();
        server.register_tool(
            "prompt_key_values",
            "Prompt user for key/value inputs.",
            kv_schema(),
            Box::new(move |args| {
                handle_prompt_kv(
                    &server_name,
                    run_id.as_deref(),
                    &db,
                    &args,
                )
            }),
        );
    }

    {
        let server_name = server_name.clone();
        let run_id = run_id.clone();
        let db = db.clone();
        server.register_tool(
            "prompt_choices",
            "Prompt user for single or multiple choice selection.",
            choice_schema(),
            Box::new(move |args| {
                handle_prompt_choice(
                    &server_name,
                    run_id.as_deref(),
                    &db,
                    &args,
                )
            }),
        );
    }

    if let Err(err) = server.run_stdio() {
        eprintln!("[{server_name}] ui-prompt MCP server crashed: {err}");
        std::process::exit(1);
    }
}

fn handle_prompt_kv(
    server_name: &str,
    run_id: Option<&str>,
    db: &Rc<RefCell<UiPromptDb>>,
    args: &Value,
) -> Result<Value, String> {
    let allow_cancel = args
        .get("allow_cancel")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let timeout_ms = normalize_timeout_ms(args.get("timeout_ms"));
    let fields = normalize_kv_fields(args.get("fields"), 50)?;
    let title = safe_trim(args.get("title").and_then(|v| v.as_str()));
    let message = safe_trim(args.get("message").and_then(|v| v.as_str()));

    let request_id = Uuid::new_v4().to_string();
    let secret_keys = collect_secret_keys(&fields);
    let redacted_fields = if secret_keys.is_empty() {
        kv_fields_to_value(&fields)
    } else {
        redact_kv_fields_for_log(&fields, &secret_keys)
    };

    let prompt_obj = json!({
        "kind": "kv",
        "title": title,
        "message": message,
        "allowCancel": allow_cancel,
        "fields": redacted_fields,
    });

    let mut entry = json!({
        "ts": now_iso(),
        "type": "ui_prompt",
        "action": "request",
        "requestId": request_id,
        "prompt": prompt_obj,
    });
    if let Some(run_id) = run_id {
        entry["runId"] = Value::String(run_id.to_string());
    }

    let prompt_for_db = entry
        .get("prompt")
        .cloned()
        .unwrap_or_else(|| json!({}));
    db.borrow()
        .upsert_request(&request_id, &prompt_for_db, "pending")?;

    let response_entry = if let Some(tty) = create_tty_prompt() {
        match tty.backend() {
            PromptBackend::Tty => {
                let mut tty = tty;
                let cancel = AtomicBool::new(false);
                let tty_result = run_tty_kv(
                    &mut tty,
                    server_name,
                    &title,
                    &message,
                    &fields,
                    allow_cancel,
                    &cancel,
                );
                let response_entry = build_kv_response_entry(&request_id, run_id, tty_result.as_ref());
                response_entry
            }
            PromptBackend::Auto => {
                wait_for_kv_with_auto(
                    tty,
                    server_name,
                    &title,
                    &message,
                    &fields,
                    allow_cancel,
                    &request_id,
                    run_id,
                    timeout_ms,
                    db,
                )?
            }
        }
    } else {
        wait_for_prompt_response(
            &request_id,
            run_id,
            timeout_ms,
            db,
        )?
    };

    let status = normalize_response_status(&response_entry);
    let response_for_db = if secret_keys.is_empty() {
        response_entry
            .get("response")
            .cloned()
            .unwrap_or_else(|| json!({}))
    } else {
        let redacted_entry = redact_prompt_entry(&response_entry, &secret_keys, SECRET_MASK);
        redacted_entry
            .get("response")
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    db.borrow()
        .upsert_response(&request_id, &response_for_db, &status)?;
    let values = if status == "ok" {
        let response_values = response_entry
            .get("response")
            .and_then(|v| v.get("values"));
        normalize_kv_values(response_values, &fields)
    } else {
        HashMap::new()
    };

    let text = build_kv_text(&request_id, &status, &values);
    let mut structured = json!({
        "status": status,
        "request_id": request_id,
        "values": values,
    });
    if let Some(run_id) = run_id {
        structured["run_id"] = Value::String(run_id.to_string());
    }

    Ok(text_result(text, structured))
}

fn handle_prompt_choice(
    server_name: &str,
    run_id: Option<&str>,
    db: &Rc<RefCell<UiPromptDb>>,
    args: &Value,
) -> Result<Value, String> {
    let allow_cancel = args
        .get("allow_cancel")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let timeout_ms = normalize_timeout_ms(args.get("timeout_ms"));
    let multiple = args.get("multiple").and_then(|v| v.as_bool()).unwrap_or(false);
    let options = normalize_choice_options(args.get("options"), 60)?;
    let limits = normalize_choice_limits(
        multiple,
        parse_i64(args.get("min_selections")),
        parse_i64(args.get("max_selections")),
        options.len(),
        LimitMode::Clamp,
        Some(1),
        Some(1),
    )?;
    let default_selection = normalize_default_selection(args.get("default"), multiple, &options);
    let title = safe_trim(args.get("title").and_then(|v| v.as_str()));
    let message = safe_trim(args.get("message").and_then(|v| v.as_str()));

    let request_id = Uuid::new_v4().to_string();

    let prompt_obj = json!({
        "kind": "choice",
        "title": title,
        "message": message,
        "allowCancel": allow_cancel,
        "multiple": multiple,
        "options": choice_options_to_value(&options),
        "default": default_selection,
        "minSelections": limits.min_selections,
        "maxSelections": limits.max_selections,
    });

    let mut entry = json!({
        "ts": now_iso(),
        "type": "ui_prompt",
        "action": "request",
        "requestId": request_id,
        "prompt": prompt_obj,
    });
    if let Some(run_id) = run_id {
        entry["runId"] = Value::String(run_id.to_string());
    }

    let prompt_for_db = entry
        .get("prompt")
        .cloned()
        .unwrap_or_else(|| json!({}));
    db.borrow()
        .upsert_request(&request_id, &prompt_for_db, "pending")?;

    let response_entry = if let Some(tty) = create_tty_prompt() {
        match tty.backend() {
            PromptBackend::Tty => {
                let mut tty = tty;
                let cancel = AtomicBool::new(false);
                let tty_result = run_tty_choice(
                    &mut tty,
                    server_name,
                    &title,
                    &message,
                    &options,
                    &limits,
                    &default_selection,
                    multiple,
                    allow_cancel,
                    &cancel,
                );
                let response_entry = build_choice_response_entry(&request_id, run_id, tty_result.as_ref());
                response_entry
            }
            PromptBackend::Auto => {
                wait_for_choice_with_auto(
                    tty,
                    server_name,
                    &title,
                    &message,
                    &options,
                    &limits,
                    &default_selection,
                    multiple,
                    allow_cancel,
                    &request_id,
                    run_id,
                    timeout_ms,
                    db,
                )?
            }
        }
    } else {
        wait_for_prompt_response(
            &request_id,
            run_id,
            timeout_ms,
            db,
        )?
    };

    let status = normalize_response_status(&response_entry);
    let response_for_db = response_entry
        .get("response")
        .cloned()
        .unwrap_or_else(|| json!({}));
    db.borrow()
        .upsert_response(&request_id, &response_for_db, &status)?;
    let selection = if status == "ok" {
        let response_selection = response_entry
            .get("response")
            .and_then(|v| v.get("selection"));
        normalize_choice_selection(response_selection, multiple, &options)
    } else if multiple {
        Value::Array(Vec::new())
    } else {
        Value::String(String::new())
    };

    let text = build_choice_text(&request_id, &status, &selection, multiple);
    let mut structured = json!({
        "status": status,
        "request_id": request_id,
        "multiple": multiple,
        "selection": selection,
    });
    if let Some(run_id) = run_id {
        structured["run_id"] = Value::String(run_id.to_string());
    }

    Ok(text_result(text, structured))
}

fn run_tty_kv(
    tty: &mut TtyPrompt,
    server_name: &str,
    title: &str,
    message: &str,
    fields: &[KvField],
    allow_cancel: bool,
    cancel: &AtomicBool,
) -> Option<KvResult> {
    let _ = tty.writeln("");
    let title_text = if title.is_empty() { "需要你补充信息" } else { title };
    let _ = tty.writeln(&format!("[{server_name}] {title_text}"));
    let _ = tty.writeln("可在 UI 或本终端填写；输入 c/cancel 取消。");
    if !message.is_empty() {
        let _ = tty.writeln(message);
    }
    let _ = tty.writeln("");

    let mut values: HashMap<String, String> = HashMap::new();
    for field in fields {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        let label = if field.label.is_empty() {
            field.key.clone()
        } else {
            field.label.clone()
        };
        if !field.description.is_empty() {
            let _ = tty.writeln(&format!("{label}: {}", field.description));
        }
        if !field.placeholder.is_empty() {
            let _ = tty.writeln(&format!("  提示: {}", field.placeholder));
        }

        loop {
            if field.multiline {
                let suffix = if field.required { " (必填)" } else { "" };
                let _ = tty.writeln(&format!("{label}{suffix}：多行输入，单独一行输入 \".\" 结束"));
                let mut lines: Vec<String> = Vec::new();
                loop {
                    let line = tty.ask("> ", cancel).ok().flatten()?;
                    let trimmed = line.trim().to_lowercase();
                    if allow_cancel && (trimmed == "c" || trimmed == "cancel") {
                        return Some(KvResult::canceled());
                    }
                    if line == "." {
                        break;
                    }
                    lines.push(line);
                }
                let combined = lines.join("\n");
                let final_value = if !combined.is_empty() { combined } else { field.default_value.clone() };
                if field.required && final_value.trim().is_empty() {
                    let _ = tty.writeln("该项为必填，请重新输入。");
                    continue;
                }
                values.insert(field.key.clone(), final_value);
                break;
            }

            let suffix = if field.default_value.is_empty() {
                String::new()
            } else {
                format!(" [默认: {}]", field.default_value)
            };
            let prompt = format!(
                "{label}{}{}: ",
                if field.required { " (必填)" } else { "" },
                suffix
            );
            let answer = tty.ask(&prompt, cancel).ok().flatten()?;
            let trimmed_lower = answer.trim().to_lowercase();
            if allow_cancel && (trimmed_lower == "c" || trimmed_lower == "cancel") {
                return Some(KvResult::canceled());
            }
            let final_value = if answer.trim().is_empty() {
                field.default_value.clone()
            } else {
                answer
            };
            if field.required && final_value.trim().is_empty() {
                let _ = tty.writeln("该项为必填，请重新输入。");
                continue;
            }
            values.insert(field.key.clone(), final_value);
            break;
        }
        let _ = tty.writeln("");
    }

    Some(KvResult {
        status: "ok".to_string(),
        values,
    })
}

fn run_tty_choice(
    tty: &mut TtyPrompt,
    server_name: &str,
    title: &str,
    message: &str,
    options: &[ChoiceOption],
    limits: &ChoiceLimits,
    default_selection: &Value,
    multiple: bool,
    allow_cancel: bool,
    cancel: &AtomicBool,
) -> Option<ChoiceResult> {
    let _ = tty.writeln("");
    let header = if !title.is_empty() {
        title.to_string()
    } else if multiple {
        "需要你做出选择（多选）".to_string()
    } else {
        "需要你做出选择".to_string()
    };
    let _ = tty.writeln(&format!("[{server_name}] {header}"));
    let _ = tty.writeln("可在 UI 或本终端选择；输入 c/cancel 取消。");
    if !message.is_empty() {
        let _ = tty.writeln(message);
    }
    let _ = tty.writeln("");

    let mut index_map = HashMap::new();
    let mut allowed = HashSet::new();
    for (idx, opt) in options.iter().enumerate() {
        let label = if opt.label.is_empty() {
            opt.value.clone()
        } else {
            opt.label.clone()
        };
        let extra = if opt.description.is_empty() {
            String::new()
        } else {
            format!(" — {}", opt.description)
        };
        let line = format!("[{}] {} ({}){}", idx + 1, label, opt.value, extra);
        let _ = tty.writeln(&line);
        index_map.insert((idx + 1).to_string(), opt.value.clone());
        allowed.insert(opt.value.clone());
    }
    let _ = tty.writeln("");

    let parse_tokens = |raw: &str| -> Vec<String> {
        let text = raw.trim();
        if text.is_empty() {
            return Vec::new();
        }
        let parts: Vec<&str> = text
            .split(|c: char| c.is_whitespace() || c == ',' || c == '，')
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect();
        let mut out = Vec::new();
        for part in parts {
            let mapped = index_map.get(part).cloned().unwrap_or_else(|| part.to_string());
            if allowed.contains(&mapped) {
                out.push(mapped);
            }
        }
        out
    };

    loop {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        let hint = if multiple {
            let default_text = if let Some(arr) = default_selection.as_array() {
                if arr.is_empty() {
                    String::new()
                } else {
                    format!(" [默认: {}]", serde_json::to_string(arr).unwrap_or_default())
                }
            } else {
                String::new()
            };
            format!("选择项（序号或 value，逗号分隔）{}: ", default_text)
        } else {
            let default_text = if let Some(text) = default_selection.as_str() {
                if text.is_empty() {
                    String::new()
                } else {
                    format!(" [默认: {}]", text)
                }
            } else {
                String::new()
            };
            format!("选择项（序号或 value）{}: ", default_text)
        };
        let answer = tty.ask(&hint, cancel).ok().flatten()?;
        let trimmed = answer.trim();
        let lowered = trimmed.to_lowercase();
        if allow_cancel && (lowered == "c" || lowered == "cancel") {
            return Some(ChoiceResult::canceled());
        }

        if trimmed.is_empty() {
            if multiple {
                let selection = default_selection.as_array().cloned().unwrap_or_default();
                if selection.len() < limits.min_selections as usize {
                    let _ = tty.writeln(&format!("至少选择 {} 项。", limits.min_selections));
                    continue;
                }
                if selection.len() > limits.max_selections as usize {
                    let _ = tty.writeln(&format!("最多选择 {} 项。", limits.max_selections));
                    continue;
                }
                return Some(ChoiceResult::ok(Value::Array(selection)));
            }
            if let Some(text) = default_selection.as_str() {
                if !text.is_empty() {
                    return Some(ChoiceResult::ok(Value::String(text.to_string())));
                }
            }
            let _ = tty.writeln("请选择一项。");
            continue;
        }

        let picked = parse_tokens(trimmed);
        let mut unique = Vec::new();
        let mut seen = HashSet::new();
        for value in picked {
            if seen.contains(&value) {
                continue;
            }
            seen.insert(value.clone());
            unique.push(value);
        }
        if multiple {
            if unique.len() < limits.min_selections as usize {
                let _ = tty.writeln(&format!("至少选择 {} 项。", limits.min_selections));
                continue;
            }
            if unique.len() > limits.max_selections as usize {
                let _ = tty.writeln(&format!("最多选择 {} 项。", limits.max_selections));
                continue;
            }
            return Some(ChoiceResult::ok(Value::Array(unique.into_iter().map(Value::String).collect())));
        }
        let first = unique.get(0).cloned().unwrap_or_default();
        if first.is_empty() {
            let _ = tty.writeln("选择项无效，请重新输入。");
            continue;
        }
        return Some(ChoiceResult::ok(Value::String(first)));
    }
}

fn wait_for_kv_with_auto(
    mut tty: TtyPrompt,
    server_name: &str,
    title: &str,
    message: &str,
    fields: &[KvField],
    allow_cancel: bool,
    request_id: &str,
    run_id: Option<&str>,
    timeout_ms: Option<i64>,
    db: &Rc<RefCell<UiPromptDb>>,
) -> Result<Value, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_thread = cancel.clone();
    let (tx, rx) = mpsc::channel();
    let server_name = server_name.to_string();
    let title = title.to_string();
    let message = message.to_string();
    let fields = fields.to_vec();

    let handle = thread::spawn(move || {
        let result = run_tty_kv(
            &mut tty,
            &server_name,
            &title,
            &message,
            &fields,
            allow_cancel,
            &cancel_thread,
        );
        let _ = tx.send(result);
    });

    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms as u64));
    let mut response_entry: Option<Value> = None;

    loop {
        if let Ok(tty_result) = rx.try_recv() {
            let entry = build_kv_response_entry(request_id, run_id, tty_result.as_ref());
            response_entry = Some(entry);
            break;
        }
        if let Some(entry) = db.borrow().get_response_entry(request_id)? {
            response_entry = Some(entry);
            break;
        }
        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                let entry = build_timeout_entry(request_id, run_id);
                response_entry = Some(entry);
                break;
            }
        }
        thread::sleep(Duration::from_millis(200));
    }

    cancel.store(true, Ordering::SeqCst);
    let _ = handle.join();
    Ok(response_entry.unwrap_or_else(|| build_timeout_entry(request_id, run_id)))
}

fn wait_for_choice_with_auto(
    mut tty: TtyPrompt,
    server_name: &str,
    title: &str,
    message: &str,
    options: &[ChoiceOption],
    limits: &ChoiceLimits,
    default_selection: &Value,
    multiple: bool,
    allow_cancel: bool,
    request_id: &str,
    run_id: Option<&str>,
    timeout_ms: Option<i64>,
    db: &Rc<RefCell<UiPromptDb>>,
) -> Result<Value, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_thread = cancel.clone();
    let (tx, rx) = mpsc::channel();
    let server_name = server_name.to_string();
    let title = title.to_string();
    let message = message.to_string();
    let options = options.to_vec();
    let limits = limits.clone();
    let default_selection = default_selection.clone();

    let handle = thread::spawn(move || {
        let result = run_tty_choice(
            &mut tty,
            &server_name,
            &title,
            &message,
            &options,
            &limits,
            &default_selection,
            multiple,
            allow_cancel,
            &cancel_thread,
        );
        let _ = tx.send(result);
    });

    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms as u64));
    let mut response_entry: Option<Value> = None;

    loop {
        if let Ok(tty_result) = rx.try_recv() {
            let entry = build_choice_response_entry(request_id, run_id, tty_result.as_ref());
            response_entry = Some(entry);
            break;
        }
        if let Some(entry) = db.borrow().get_response_entry(request_id)? {
            response_entry = Some(entry);
            break;
        }
        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                let entry = build_timeout_entry(request_id, run_id);
                response_entry = Some(entry);
                break;
            }
        }
        thread::sleep(Duration::from_millis(200));
    }

    cancel.store(true, Ordering::SeqCst);
    let _ = handle.join();
    Ok(response_entry.unwrap_or_else(|| build_timeout_entry(request_id, run_id)))
}

fn wait_for_prompt_response(
    request_id: &str,
    run_id: Option<&str>,
    timeout_ms: Option<i64>,
    db: &Rc<RefCell<UiPromptDb>>,
) -> Result<Value, String> {
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms as u64));
    loop {
        if let Some(entry) = db.borrow().get_response_entry(request_id)? {
            return Ok(entry);
        }
        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                let entry = build_timeout_entry(request_id, run_id);
                return Ok(entry);
            }
        }
        thread::sleep(Duration::from_millis(800));
    }
}

fn build_kv_response_entry(request_id: &str, run_id: Option<&str>, result: Option<&KvResult>) -> Value {
    let response = match result {
        Some(res) => {
            if res.status == "ok" {
                json!({ "status": res.status, "values": res.values })
            } else {
                json!({ "status": res.status })
            }
        }
        None => json!({ "status": "canceled" }),
    };
    let mut entry = json!({
        "ts": now_iso(),
        "type": "ui_prompt",
        "action": "response",
        "requestId": request_id,
        "response": response,
    });
    if let Some(run_id) = run_id {
        entry["runId"] = Value::String(run_id.to_string());
    }
    entry
}

fn build_choice_response_entry(request_id: &str, run_id: Option<&str>, result: Option<&ChoiceResult>) -> Value {
    let response = match result {
        Some(res) => {
            if res.status == "ok" {
                json!({ "status": res.status, "selection": res.selection })
            } else {
                json!({ "status": res.status })
            }
        }
        None => json!({ "status": "canceled" }),
    };
    let mut entry = json!({
        "ts": now_iso(),
        "type": "ui_prompt",
        "action": "response",
        "requestId": request_id,
        "response": response,
    });
    if let Some(run_id) = run_id {
        entry["runId"] = Value::String(run_id.to_string());
    }
    entry
}

fn build_timeout_entry(request_id: &str, run_id: Option<&str>) -> Value {
    let mut entry = json!({
        "ts": now_iso(),
        "type": "ui_prompt",
        "action": "response",
        "requestId": request_id,
        "response": { "status": "timeout" },
    });
    if let Some(run_id) = run_id {
        entry["runId"] = Value::String(run_id.to_string());
    }
    entry
}

fn normalize_response_status(entry: &Value) -> String {
    let status = entry
        .get("response")
        .and_then(|v| v.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    match status.as_str() {
        "ok" | "canceled" | "timeout" => status,
        _ => "canceled".to_string(),
    }
}

fn build_kv_text(request_id: &str, status: &str, values: &HashMap<String, String>) -> String {
    if status == "ok" {
        if values.is_empty() {
            return format!("requestId={request_id}\nstatus=ok\nvalues=<empty>");
        }
        let mut lines = Vec::new();
        for (key, value) in values {
            lines.push(format!("- {key}: {value}"));
        }
        return format!("requestId={request_id}\nstatus=ok\nvalues:\n{}", lines.join("\n"));
    }
    format!("requestId={request_id}\nstatus={status}")
}

fn build_choice_text(request_id: &str, status: &str, selection: &Value, multiple: bool) -> String {
    if status == "ok" {
        if multiple {
            return format!(
                "requestId={request_id}\nstatus=ok\nselection={}",
                serde_json::to_string(selection).unwrap_or_else(|_| "[]".to_string())
            );
        }
        let text = selection.as_str().unwrap_or("");
        return format!("requestId={request_id}\nstatus=ok\nselection={text}");
    }
    format!("requestId={request_id}\nstatus={status}")
}

fn text_result(text: String, structured: Value) -> Value {
    json!({
        "content": [
            { "type": "text", "text": text }
        ],
        "structuredContent": structured,
    })
}

fn parse_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

fn normalize_timeout_ms(value: Option<&Value>) -> Option<i64> {
    let parsed = value
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))?;
    if parsed <= 0 {
        return None;
    }
    Some(parsed.clamp(1_000, MAX_WAIT_MS))
}

fn kv_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "message": { "type": "string" },
            "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 50,
                "items": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string", "minLength": 1 },
                        "label": { "type": "string" },
                        "description": { "type": "string" },
                        "placeholder": { "type": "string" },
                        "default": { "type": "string" },
                        "required": { "type": "boolean" },
                        "multiline": { "type": "boolean" },
                        "secret": { "type": "boolean" }
                    },
                    "required": ["key"]
                }
            },
            "allow_cancel": { "type": "boolean" },
            "timeout_ms": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_MS }
        },
        "required": ["fields"]
    })
}

fn choice_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "message": { "type": "string" },
            "multiple": { "type": "boolean" },
            "options": {
                "type": "array",
                "minItems": 1,
                "maxItems": 60,
                "items": {
                    "type": "object",
                    "properties": {
                        "value": { "type": "string", "minLength": 1 },
                        "label": { "type": "string" },
                        "description": { "type": "string" }
                    },
                    "required": ["value"]
                }
            },
            "default": {
                "oneOf": [
                    { "type": "string" },
                    { "type": "array", "items": { "type": "string" } }
                ]
            },
            "min_selections": { "type": "integer", "minimum": 0, "maximum": 60 },
            "max_selections": { "type": "integer", "minimum": 1, "maximum": 60 },
            "allow_cancel": { "type": "boolean" },
            "timeout_ms": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_MS }
        },
        "required": ["options"]
    })
}

fn choice_options_to_value(options: &[ChoiceOption]) -> Vec<Value> {
    options
        .iter()
        .map(|opt| {
            json!({
                "value": opt.value,
                "label": opt.label,
                "description": opt.description,
            })
        })
        .collect()
}

fn print_help() {
    println!(
        "Usage: ui-prompt-server [--name <serverName>]\n\nStorage:\n  Default DB path: $HOME/.mcp-servers/<server_name>/<server_name>.db.sqlite\n  Override root with MCP_STATE_ROOT.\n\nAdmin UI:\n  --admin-port <p>     Start admin HTTP server on port p\n  --admin-host <host>  Bind host (default 127.0.0.1)\n  --admin-ui-root <p>  Static UI root (default ./admin-ui/dist if present)"
    );
}

fn resolve_admin_ui_root(arg: Option<&String>) -> Option<PathBuf> {
    if let Some(value) = arg {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    let candidate = PathBuf::from("admin-ui").join("dist");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

#[derive(Clone, Debug)]
struct KvResult {
    status: String,
    values: HashMap<String, String>,
}

impl KvResult {
    fn canceled() -> Self {
        Self {
            status: "canceled".to_string(),
            values: HashMap::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct ChoiceResult {
    status: String,
    selection: Value,
}

impl ChoiceResult {
    fn ok(selection: Value) -> Self {
        Self {
            status: "ok".to_string(),
            selection,
        }
    }

    fn canceled() -> Self {
        Self {
            status: "canceled".to_string(),
            selection: Value::Null,
        }
    }
}
