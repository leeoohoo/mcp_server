use chrono::Utc;
use std::collections::{HashMap, HashSet};

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

pub fn clamp_number(value: Option<&str>, min: i64, max: i64, fallback: i64) -> i64 {
    let parsed = value.and_then(|v| v.parse::<i64>().ok()).unwrap_or(fallback);
    parsed.clamp(min, max)
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
