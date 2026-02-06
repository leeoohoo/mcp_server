use serde_json::{Map, Value};
use std::env;
use std::fs;

use crate::log_utils::cap_jsonl_file;
use crate::utils::safe_trim;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptLogMode {
    Full,
    Minimal,
}

pub fn resolve_ui_prompt_log_mode() -> PromptLogMode {
    let raw = env::var("MODEL_CLI_UI_PROMPTS_LOG_MODE").unwrap_or_default();
    let normalized = raw.trim().to_lowercase();
    if normalized == "minimal" {
        PromptLogMode::Minimal
    } else {
        PromptLogMode::Full
    }
}

pub fn sanitize_ui_prompt_entry(entry: &Value, mode: PromptLogMode) -> Value {
    if mode != PromptLogMode::Minimal {
        return entry.clone();
    }
    let obj = match entry.as_object() {
        Some(obj) => obj,
        None => return entry.clone(),
    };

    let mut next = Map::new();
    for (key, value) in obj {
        if key == "prompt" || key == "response" {
            continue;
        }
        next.insert(key.clone(), value.clone());
    }

    if let Some(prompt) = obj.get("prompt") {
        if let Some(meta) = build_prompt_meta(prompt) {
            next.insert("prompt".to_string(), meta);
        }
    }
    if let Some(response) = obj.get("response") {
        if let Some(meta) = build_response_meta(response) {
            next.insert("response".to_string(), meta);
        }
    }

    Value::Object(next)
}

pub fn append_ui_prompt_entry(
    file_path: &str,
    entry: &Value,
    mode: PromptLogMode,
    max_bytes: i64,
    max_lines: i64,
) -> Option<Value> {
    let target = file_path.trim();
    if target.is_empty() {
        return None;
    }
    ensure_file_exists(target);
    let sanitized = sanitize_ui_prompt_entry(entry, mode);
    cap_jsonl_file(target, max_bytes, max_lines);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(target)
        .and_then(|mut file| {
            use std::io::Write;
            writeln!(file, "{}", sanitized).map(|_| ())
        });
    Some(sanitized)
}

fn build_prompt_meta(prompt: &Value) -> Option<Value> {
    let prompt_obj = prompt.as_object()?;
    let kind = safe_trim(prompt_obj.get("kind").and_then(|v| v.as_str()));
    let title = safe_trim(prompt_obj.get("title").and_then(|v| v.as_str()));
    let source = safe_trim(prompt_obj.get("source").and_then(|v| v.as_str()));
    let path_value = safe_trim(prompt_obj.get("path").and_then(|v| v.as_str()));
    let allow_cancel = prompt_obj.get("allowCancel").and_then(|v| v.as_bool());

    let mut meta = Map::new();
    if !kind.is_empty() {
        meta.insert("kind".to_string(), Value::String(kind.clone()));
    }
    if !title.is_empty() {
        meta.insert("title".to_string(), Value::String(title));
    }
    if !source.is_empty() {
        meta.insert("source".to_string(), Value::String(source));
    }
    if !path_value.is_empty() {
        meta.insert("path".to_string(), Value::String(path_value));
    }
    if let Some(allow) = allow_cancel {
        meta.insert("allowCancel".to_string(), Value::Bool(allow));
    }

    if kind == "kv" {
        let field_count = prompt_obj
            .get("fields")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len() as i64)
            .unwrap_or(0);
        meta.insert("fieldCount".to_string(), Value::Number(field_count.into()));
    }
    if kind == "choice" {
        let multiple = prompt_obj
            .get("multiple")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let option_count = prompt_obj
            .get("options")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len() as i64)
            .unwrap_or(0);
        meta.insert("multiple".to_string(), Value::Bool(multiple));
        meta.insert("optionCount".to_string(), Value::Number(option_count.into()));
        if let Some(min) = prompt_obj.get("minSelections").and_then(|v| v.as_i64()) {
            meta.insert("minSelections".to_string(), Value::Number(min.into()));
        }
        if let Some(max) = prompt_obj.get("maxSelections").and_then(|v| v.as_i64()) {
            meta.insert("maxSelections".to_string(), Value::Number(max.into()));
        }
    }
    if kind == "task_confirm" {
        let task_count = prompt_obj
            .get("tasks")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len() as i64)
            .unwrap_or(0);
        meta.insert("taskCount".to_string(), Value::Number(task_count.into()));
    }
    if kind == "file_change_confirm" {
        if !path_value.is_empty() {
            meta.insert("path".to_string(), Value::String(path_value));
        }
    }

    if meta.is_empty() {
        None
    } else {
        Some(Value::Object(meta))
    }
}

fn build_response_meta(response: &Value) -> Option<Value> {
    let response_obj = response.as_object()?;
    let status = safe_trim(response_obj.get("status").and_then(|v| v.as_str()));
    let mut meta = Map::new();
    if !status.is_empty() {
        meta.insert("status".to_string(), Value::String(status));
    }
    if let Some(tasks) = response_obj.get("tasks").and_then(|v| v.as_array()) {
        meta.insert("taskCount".to_string(), Value::Number((tasks.len() as i64).into()));
    }
    if let Some(values) = response_obj.get("values").and_then(|v| v.as_object()) {
        meta.insert("valueCount".to_string(), Value::Number((values.len() as i64).into()));
    }
    if let Some(selection) = response_obj.get("selection") {
        let selection_count = if let Some(arr) = selection.as_array() {
            arr.len() as i64
        } else if selection.is_null() {
            0
        } else {
            1
        };
        if selection_count > 0 {
            meta.insert("selectionCount".to_string(), Value::Number(selection_count.into()));
        }
    }
    if meta.is_empty() {
        None
    } else {
        Some(Value::Object(meta))
    }
}

fn ensure_file_exists(file_path: &str) {
    if file_path.trim().is_empty() {
        return;
    }
    if let Some(parent) = std::path::Path::new(file_path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !std::path::Path::new(file_path).exists() {
        let _ = fs::write(file_path, "");
    }
}
