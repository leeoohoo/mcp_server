use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const STATE_ROOT_DIRNAME: &str = ".deepseek_cli";
pub const COMPAT_STATE_ROOT_DIRNAME: &str = ".chatos";
pub const UI_PROMPTS_FILE: &str = "ui-prompts.jsonl";

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
        "ui_prompter".to_string()
    } else {
        trimmed
    }
}

pub fn resolve_state_dir(server_name: &str) -> PathBuf {
    if let Ok(root) = env::var("MCP_STATE_ROOT") {
        if !root.trim().is_empty() {
            return PathBuf::from(root.trim()).join(normalize_name(server_name));
        }
    }
    let home = get_home_dir();
    let base = if home.as_os_str().is_empty() {
        PathBuf::from(".mcp-servers")
    } else {
        home.join(".mcp-servers")
    };
    base.join(normalize_name(server_name))
}

pub fn resolve_session_root() -> PathBuf {
    if let Ok(raw) = env::var("MODEL_CLI_SESSION_ROOT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(trimmed));
        }
    }

    let home = get_home_dir();
    let host_app = resolve_host_app(None, Some("chatos"));
    let marker_path = get_marker_path(&home, &host_app, STATE_ROOT_DIRNAME);
    let compat_marker_path = get_marker_path(&home, &host_app, COMPAT_STATE_ROOT_DIRNAME);
    let legacy_marker_path = get_legacy_marker_path(&home, STATE_ROOT_DIRNAME);
    let legacy_compat_marker_path = get_legacy_marker_path(&home, COMPAT_STATE_ROOT_DIRNAME);

    let read_marker = |path: &Path| -> Option<String> {
        if path.as_os_str().is_empty() {
            return None;
        }
        let content = fs::read_to_string(path).ok()?;
        let trimmed = content.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };

    let candidates = [
        marker_path.as_ref(),
        compat_marker_path.as_ref(),
        legacy_marker_path.as_ref(),
        legacy_compat_marker_path.as_ref(),
    ];

    for candidate in candidates {
        if let Some(raw) = candidate.and_then(|p| read_marker(p)) {
            let resolved = PathBuf::from(&raw);
            let mut valid = true;
            if resolved.exists() {
                valid = resolved.is_dir();
            }
            if valid {
                if let Some(marker_path) = marker_path.as_ref() {
                    if !marker_path.exists() {
                        let _ = ensure_dir(marker_path.parent().unwrap_or_else(|| Path::new("")));
                        let _ = fs::write(marker_path, &raw);
                    }
                }
                return resolved;
            }
        }
    }

    if !home.as_os_str().is_empty() {
        return home;
    }
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn resolve_ui_prompts_path(session_root: &Path) -> PathBuf {
    resolve_app_state_dir(session_root).join(UI_PROMPTS_FILE)
}

pub fn resolve_app_state_dir(session_root: &Path) -> PathBuf {
    let host_app = resolve_host_app(None, Some("chatos"));
    let home = get_home_dir();
    let env_session_root = env::var("MODEL_CLI_SESSION_ROOT")
        .ok()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let prefer_session_root = !env_session_root.is_empty();
    let base_root = if !env_session_root.is_empty() {
        Some(PathBuf::from(env_session_root))
    } else if !session_root.as_os_str().is_empty() {
        Some(session_root.to_path_buf())
    } else {
        None
    };

    if prefer_session_root {
        if let Some(base) = base_root {
            let legacy = resolve_legacy_state_dir(&base);
            return if host_app.is_empty() {
                legacy
            } else {
                legacy.join(host_app)
            };
        }
    }

    if !home.as_os_str().is_empty() && !host_app.is_empty() {
        return home.join(STATE_ROOT_DIRNAME).join(host_app);
    }

    let legacy = resolve_legacy_state_dir(if session_root.as_os_str().is_empty() {
        &env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        session_root
    });
    if host_app.is_empty() {
        legacy
    } else {
        legacy.join(host_app)
    }
}

fn resolve_legacy_state_dir(base: &Path) -> PathBuf {
    let resolved = if base.as_os_str().is_empty() {
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        base.to_path_buf()
    };
    resolved.join(STATE_ROOT_DIRNAME)
}

fn get_marker_path(home: &Path, host_app: &str, base_dir: &str) -> Option<PathBuf> {
    if home.as_os_str().is_empty() || host_app.trim().is_empty() {
        return None;
    }
    Some(home.join(base_dir).join(host_app).join("last-session-root.txt"))
}

fn get_legacy_marker_path(home: &Path, base_dir: &str) -> Option<PathBuf> {
    if home.as_os_str().is_empty() {
        return None;
    }
    Some(home.join(base_dir).join("last-session-root.txt"))
}

fn resolve_host_app(explicit: Option<&str>, fallback: Option<&str>) -> String {
    let explicit_value = explicit.unwrap_or("").trim();
    let env_value = env::var("MODEL_CLI_HOST_APP").unwrap_or_default();
    let raw = if !explicit_value.is_empty() {
        explicit_value.to_string()
    } else if !env_value.trim().is_empty() {
        env_value
    } else {
        fallback.unwrap_or("").to_string()
    };
    normalize_host_app(&raw)
}

fn normalize_host_app(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' { ch } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn get_home_dir() -> PathBuf {
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
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(""))
}

pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    fs::create_dir_all(path)
}
