use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

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

pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    fs::create_dir_all(path)
}

pub fn get_home_dir() -> PathBuf {
    if let Ok(value) = env::var("HOME") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    if let Ok(value) = env::var("USERPROFILE") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn resolve_state_dir(server_name: &str) -> PathBuf {
    if let Ok(root) = env::var("MCP_STATE_ROOT") {
        if !root.trim().is_empty() {
            return PathBuf::from(root.trim()).join(normalize_name(server_name));
        }
    }
    get_home_dir().join(".mcp-servers").join(normalize_name(server_name))
}

pub fn normalize_name(value: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in value.trim().to_lowercase().chars() {
        let valid = ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-';
        if valid {
            out.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "task_manager".to_string()
    } else {
        trimmed
    }
}

pub fn generate_id(prefix: &str) -> String {
    let safe_prefix = normalize_name(prefix);
    format!("{safe_prefix}_{}", Uuid::new_v4())
}

pub fn normalize_id(value: Option<&String>) -> String {
    value.map(|v| v.trim().to_string()).unwrap_or_default()
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
