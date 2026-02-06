use std::collections::{HashMap, HashSet};
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

pub fn normalize_name(value: &str, fallback: &str) -> String {
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
        fallback.to_string()
    } else {
        trimmed
    }
}

pub fn normalize_id(value: Option<&String>) -> String {
    value.map(|v| v.trim().to_string()).unwrap_or_default()
}

pub fn parse_csv(value: Option<&String>) -> Vec<String> {
    if let Some(raw) = value {
        raw.split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect()
    } else {
        Vec::new()
    }
}

pub fn clamp_number(value: Option<&String>, min: i64, max: i64, fallback: i64) -> i64 {
    let parsed = value
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(fallback);
    parsed.clamp(min, max)
}

pub fn resolve_within_root(root: &Path, target: &str) -> PathBuf {
    root.join(target)
}

pub fn is_subpath(root: &Path, candidate: &Path) -> bool {
    let relative = pathdiff::diff_paths(candidate, root);
    if let Some(rel) = relative {
        let rel_str = rel.to_string_lossy();
        !rel_str.starts_with("..") && !rel.is_absolute()
    } else {
        false
    }
}

pub fn get_command_root(command: &str) -> String {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}

pub fn format_bytes(bytes: i64) -> String {
    if bytes <= 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut idx = 0usize;
    while value >= 1024.0 && idx < units.len() - 1 {
        value /= 1024.0;
        idx += 1;
    }
    if value >= 10.0 || idx == 0 {
        format!("{:.0} {}", value, units[idx])
    } else {
        format!("{:.1} {}", value, units[idx])
    }
}
