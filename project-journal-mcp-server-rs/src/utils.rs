use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
pub struct ParsedArgs {
    pub positional: Vec<String>,
    pub values: HashMap<String, String>,
    pub flags: HashSet<String>,
}

pub fn parse_args(argv: &[String]) -> ParsedArgs {
    let mut result = ParsedArgs::default();
    let mut i = 0;
    while i < argv.len() {
        let token = &argv[i];
        if !token.starts_with('-') {
            result.positional.push(token.to_string());
            i += 1;
            continue;
        }
        let key = token.trim_start_matches('-');
        if key.is_empty() {
            i += 1;
            continue;
        }
        if let Some((name, inline)) = key.split_once('=') {
            result.values.insert(name.to_string(), inline.to_string());
            i += 1;
            continue;
        }
        let next = argv.get(i + 1);
        if let Some(next_val) = next {
            if !next_val.starts_with('-') {
                result
                    .values
                    .insert(key.to_string(), next_val.to_string());
                i += 2;
                continue;
            }
        }
        result.flags.insert(key.to_string());
        i += 1;
    }
    result
}

pub fn safe_trim(value: Option<&str>) -> String {
    value.map(|v| v.trim().to_string()).unwrap_or_default()
}

pub fn clamp_number(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    let parsed = value
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(fallback);
    parsed.clamp(min, max)
}

pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    fs::create_dir_all(path)
}

pub fn ensure_dir_required(path: &Path) -> std::io::Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if path.exists() {
        if !path.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("{} is not a directory", path.display()),
            ));
        }
        return Ok(());
    }
    fs::create_dir_all(path)
}

pub fn ensure_file_exists(path: &Path, default_content: &str) {
    if path.as_os_str().is_empty() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !path.exists() {
        let _ = fs::write(path, default_content);
    }
}

pub fn atomic_write_json<T: Serialize>(path: &Path, payload: &T) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new(""));
    if !dir.as_os_str().is_empty() {
        fs::create_dir_all(dir)?;
    }
    let base = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("tmp");
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        base,
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    let content = format!("{}\n", serde_json::to_string_pretty(payload).unwrap_or_else(|_| "{}".to_string()));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.flush()?;
    }
    match fs::rename(&tmp, path) {
        Ok(_) => Ok(()),
        Err(_err) => {
            let _ = fs::remove_file(path);
            if let Err(err2) = fs::rename(&tmp, path) {
                let _ = fs::remove_file(&tmp);
                return Err(err2);
            }
            Ok(())
        }
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub fn normalize_tags(tags: Option<&Value>, extra_tag: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |value: &str| {
        let normalized = safe_trim(Some(value));
        if normalized.is_empty() {
            return;
        }
        if !out.contains(&normalized) {
            out.push(normalized);
        }
    };

    match tags {
        Some(Value::Array(arr)) => {
            for item in arr {
                if let Some(text) = item.as_str() {
                    push(text);
                }
            }
        }
        Some(Value::String(text)) => push(text),
        _ => {}
    }

    if let Some(extra) = extra_tag.and_then(|v| v.as_str()) {
        push(extra);
    }

    out
}

pub fn normalize_string_array(value: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |value: &str| {
        let normalized = safe_trim(Some(value));
        if normalized.is_empty() {
            return;
        }
        if !out.contains(&normalized) {
            out.push(normalized);
        }
    };

    if let Some(Value::Array(arr)) = value {
        for item in arr {
            if let Some(text) = item.as_str() {
                push(text);
            }
        }
    }

    out
}

pub fn resolve_path(base: &Path, raw: &str) -> PathBuf {
    let input = PathBuf::from(raw);
    let absolute = if input.is_absolute() {
        input
    } else {
        base.join(input)
    };
    clean_path(&absolute)
}

fn clean_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut stack: Vec<Component> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if let Some(last) = stack.last() {
                    match last {
                        Component::RootDir | Component::Prefix(_) => {}
                        _ => {
                            stack.pop();
                        }
                    }
                }
            }
            _ => stack.push(comp),
        }
    }
    let mut cleaned = PathBuf::new();
    for comp in stack {
        cleaned.push(comp.as_os_str());
    }
    cleaned
}
