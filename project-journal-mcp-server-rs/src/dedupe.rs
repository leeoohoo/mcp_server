use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};


use crate::utils::{atomic_write_json, ensure_dir, safe_trim};

const DEFAULT_MAX_ENTRIES: usize = 5000;
const DEFAULT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_IDS: usize = 20;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoreEntry {
    ids: Vec<String>,
    ts: String,
}

#[derive(Debug)]
pub struct DedupeStore {
    file_path: PathBuf,
    max_entries: usize,
    ttl_ms: i64,
    max_ids_per_key: usize,
    entries: HashMap<String, StoreEntry>,
    dirty: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedStore {
    version: i64,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    entries: HashMap<String, StoreEntry>,
}

fn parse_timestamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn normalize_ids(ids: &[String], max_ids: usize) -> Vec<String> {
    let limit = std::cmp::max(1, max_ids);
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let normalized = safe_trim(Some(id));
        if normalized.is_empty() || out.contains(&normalized) {
            continue;
        }
        out.push(normalized);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn prune_entries(store: &mut DedupeStore) {
    let ttl_ms = store.ttl_ms;
    let max_entries = store.max_entries;
    if ttl_ms > 0 {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut removed = Vec::new();
        for (key, entry) in store.entries.iter() {
            let ts = parse_timestamp(&entry.ts);
            if ts > 0 && now_ms - ts > ttl_ms {
                removed.push(key.clone());
            }
        }
        if !removed.is_empty() {
            for key in removed {
                store.entries.remove(&key);
            }
            store.dirty = true;
        }
    }

    if max_entries > 0 && store.entries.len() > max_entries {
        let mut pairs: Vec<(String, i64)> = store
            .entries
            .iter()
            .map(|(key, entry)| (key.clone(), parse_timestamp(&entry.ts)))
            .collect();
        pairs.sort_by_key(|pair| pair.1);
        let remove_count = pairs.len().saturating_sub(max_entries);
        if remove_count > 0 {
            for idx in 0..remove_count {
                if let Some((key, _)) = pairs.get(idx) {
                    store.entries.remove(key);
                }
            }
            store.dirty = true;
        }
    }
}

pub fn create_dedupe_store(file_path: &Path, max_entries: Option<usize>, ttl_ms: Option<i64>, max_ids: Option<usize>) -> DedupeStore {
    let target = file_path.to_path_buf();
    let mut store = DedupeStore {
        file_path: target.clone(),
        max_entries: max_entries.unwrap_or(DEFAULT_MAX_ENTRIES),
        ttl_ms: ttl_ms.unwrap_or(DEFAULT_TTL_MS),
        max_ids_per_key: max_ids.unwrap_or(DEFAULT_MAX_IDS),
        entries: HashMap::new(),
        dirty: false,
    };

    if !target.as_os_str().is_empty() && target.exists() {
        if let Ok(raw) = fs::read_to_string(&target) {
            if let Ok(parsed) = serde_json::from_str::<PersistedStore>(&raw) {
                for (key, entry) in parsed.entries.iter() {
                    let normalized_key = safe_trim(Some(key));
                    if normalized_key.is_empty() {
                        continue;
                    }
                    let ids = normalize_ids(&entry.ids, store.max_ids_per_key);
                    if ids.is_empty() {
                        continue;
                    }
                    store.entries.insert(
                        normalized_key,
                        StoreEntry {
                            ids,
                            ts: entry.ts.clone(),
                        },
                    );
                }
            }
        }
    }

    prune_entries(&mut store);
    store
}

pub fn read_dedupe_entry(store: &mut DedupeStore, key: &str) -> Option<Vec<String>> {
    let normalized = safe_trim(Some(key));
    if normalized.is_empty() {
        return None;
    }
    let ttl_ms = store.ttl_ms;
    if let Some(entry) = store.entries.get(&normalized) {
        if ttl_ms > 0 {
            let ts = parse_timestamp(&entry.ts);
            if ts > 0 && chrono::Utc::now().timestamp_millis() - ts > ttl_ms {
                store.entries.remove(&normalized);
                store.dirty = true;
                return None;
            }
        }
        return Some(entry.ids.clone());
    }
    None
}

pub fn write_dedupe_entry(store: &mut DedupeStore, key: &str, ids: &[String]) {
    let normalized = safe_trim(Some(key));
    if normalized.is_empty() {
        return;
    }
    let normalized_ids = normalize_ids(ids, store.max_ids_per_key);
    if normalized_ids.is_empty() {
        return;
    }
    store.entries.insert(
        normalized,
        StoreEntry {
            ids: normalized_ids,
            ts: chrono::Utc::now().to_rfc3339(),
        },
    );
    store.dirty = true;
    prune_entries(store);
}

pub fn remove_dedupe_entry(store: &mut DedupeStore, key: &str) {
    let normalized = safe_trim(Some(key));
    if normalized.is_empty() {
        return;
    }
    if store.entries.remove(&normalized).is_some() {
        store.dirty = true;
    }
}

pub fn flush_dedupe_store(store: &mut DedupeStore) {
    if store.file_path.as_os_str().is_empty() || !store.dirty {
        return;
    }
    let mut entries: HashMap<String, StoreEntry> = HashMap::new();
    for (key, entry) in store.entries.iter() {
        entries.insert(
            key.clone(),
            StoreEntry {
                ids: normalize_ids(&entry.ids, store.max_ids_per_key),
                ts: entry.ts.clone(),
            },
        );
    }
    let payload = PersistedStore {
        version: 1,
        updated_at: chrono::Utc::now().to_rfc3339(),
        entries,
    };
    if let Some(parent) = store.file_path.parent() {
        let _ = ensure_dir(parent);
    }
    if atomic_write_json(&store.file_path, &payload).is_ok() {
        store.dirty = false;
    }
}
