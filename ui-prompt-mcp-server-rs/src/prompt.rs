use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

use crate::utils::safe_trim;

#[derive(Clone, Debug)]
pub struct KvField {
    pub key: String,
    pub label: String,
    pub description: String,
    pub placeholder: String,
    pub default_value: String,
    pub required: bool,
    pub multiline: bool,
    pub secret: bool,
}

#[derive(Clone, Debug)]
pub struct ChoiceOption {
    pub value: String,
    pub label: String,
    pub description: String,
}

#[derive(Clone, Copy, Debug)]
pub enum LimitMode {
    Clamp,
    Strict,
}

#[derive(Clone, Debug)]
pub struct ChoiceLimits {
    pub min_selections: i64,
    pub max_selections: i64,
}

pub fn normalize_kv_fields(value: Option<&Value>, max_fields: usize) -> Result<Vec<KvField>, String> {
    let fields = value.and_then(|v| v.as_array()).ok_or_else(|| "fields is required".to_string())?;
    if fields.is_empty() {
        return Err("fields is required".to_string());
    }
    if fields.len() > max_fields {
        return Err(format!("fields must be <= {max_fields}"));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for field in fields {
        let key = safe_trim(field.get("key").and_then(|v| v.as_str()));
        if key.is_empty() {
            return Err("field.key is required".to_string());
        }
        if seen.contains(&key) {
            return Err(format!("duplicate field key: {key}"));
        }
        seen.insert(key.clone());
        out.push(KvField {
            key,
            label: safe_trim(field.get("label").and_then(|v| v.as_str())),
            description: safe_trim(field.get("description").and_then(|v| v.as_str())),
            placeholder: safe_trim(field.get("placeholder").and_then(|v| v.as_str())),
            default_value: field
                .get("default")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_default(),
            required: field.get("required").and_then(|v| v.as_bool()).unwrap_or(false),
            multiline: field.get("multiline").and_then(|v| v.as_bool()).unwrap_or(false),
            secret: field.get("secret").and_then(|v| v.as_bool()).unwrap_or(false),
        });
    }
    Ok(out)
}

pub fn normalize_choice_options(value: Option<&Value>, max_options: usize) -> Result<Vec<ChoiceOption>, String> {
    let options = value.and_then(|v| v.as_array()).ok_or_else(|| "options is required".to_string())?;
    if options.is_empty() {
        return Err("options is required".to_string());
    }
    if options.len() > max_options {
        return Err(format!("options must be <= {max_options}"));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for opt in options {
        let value = safe_trim(opt.get("value").and_then(|v| v.as_str()));
        if value.is_empty() {
            return Err("options[].value is required".to_string());
        }
        if seen.contains(&value) {
            return Err(format!("duplicate option value: {value}"));
        }
        seen.insert(value.clone());
        out.push(ChoiceOption {
            value,
            label: safe_trim(opt.get("label").and_then(|v| v.as_str())),
            description: safe_trim(opt.get("description").and_then(|v| v.as_str())),
        });
    }
    Ok(out)
}

pub fn normalize_choice_limits(
    multiple: bool,
    min: Option<i64>,
    max: Option<i64>,
    option_count: usize,
    mode: LimitMode,
    single_min: Option<i64>,
    single_max: Option<i64>,
) -> Result<ChoiceLimits, String> {
    let count = option_count as i64;
    if !multiple {
        let resolved_min = single_min.unwrap_or_else(|| if matches!(mode, LimitMode::Clamp) { 1 } else { 0 });
        let resolved_max = single_max.unwrap_or(count);
        return Ok(ChoiceLimits {
            min_selections: resolved_min,
            max_selections: resolved_max,
        });
    }

    if matches!(mode, LimitMode::Clamp) {
        let min_raw = min.unwrap_or(0);
        let max_raw = max.unwrap_or(count);
        let min_value = if min_raw >= 0 {
            min_raw.clamp(0, count)
        } else {
            0
        };
        let max_value = if max_raw >= 1 {
            max_raw.clamp(1, count)
        } else {
            count
        };
        return Ok(ChoiceLimits {
            min_selections: min_value.min(max_value),
            max_selections: max_value,
        });
    }

    let min_raw = min.unwrap_or(0);
    let max_raw = max.unwrap_or(count);
    if min_raw < 0 || min_raw > count {
        return Err(format!("minSelections must be an int between 0 and {count}"));
    }
    if max_raw < 1 || max_raw > count {
        return Err(format!("maxSelections must be an int between 1 and {count}"));
    }
    if min_raw > max_raw {
        return Err("minSelections must be <= maxSelections".to_string());
    }
    Ok(ChoiceLimits {
        min_selections: min_raw,
        max_selections: max_raw,
    })
}

pub fn normalize_default_selection(input: Option<&Value>, multiple: bool, options: &[ChoiceOption]) -> Value {
    let allowed: HashSet<String> = options.iter().map(|o| o.value.clone()).collect();
    if multiple {
        let mut values: Vec<String> = Vec::new();
        if let Some(raw) = input {
            if let Some(arr) = raw.as_array() {
                for entry in arr {
                    if let Some(text) = entry.as_str() {
                        values.push(safe_trim(Some(text)));
                    }
                }
            } else if let Some(text) = raw.as_str() {
                values.push(safe_trim(Some(text)));
            }
        }
        let mut seen = HashSet::new();
        let mut filtered = Vec::new();
        for value in values {
            if value.is_empty() || !allowed.contains(&value) || seen.contains(&value) {
                continue;
            }
            seen.insert(value.clone());
            filtered.push(value);
        }
        Value::Array(filtered.into_iter().map(Value::String).collect())
    } else {
        let value = input
            .and_then(|v| v.as_str())
            .map(|v| safe_trim(Some(v)))
            .unwrap_or_default();
        if !value.is_empty() && allowed.contains(&value) {
            Value::String(value)
        } else {
            Value::String(String::new())
        }
    }
}

pub fn normalize_choice_selection(selection: Option<&Value>, multiple: bool, options: &[ChoiceOption]) -> Value {
    let allowed: HashSet<String> = options.iter().map(|o| o.value.clone()).collect();
    if multiple {
        let mut values: Vec<String> = Vec::new();
        if let Some(raw) = selection {
            if let Some(arr) = raw.as_array() {
                for entry in arr {
                    if let Some(text) = entry.as_str() {
                        values.push(safe_trim(Some(text)));
                    }
                }
            } else if let Some(text) = raw.as_str() {
                values.push(safe_trim(Some(text)));
            }
        }
        let mut seen = HashSet::new();
        let mut filtered = Vec::new();
        for value in values {
            if value.is_empty() || !allowed.contains(&value) || seen.contains(&value) {
                continue;
            }
            seen.insert(value.clone());
            filtered.push(value);
        }
        Value::Array(filtered.into_iter().map(Value::String).collect())
    } else {
        let value = selection
            .and_then(|v| v.as_str())
            .map(|v| safe_trim(Some(v)))
            .unwrap_or_default();
        if !value.is_empty() && allowed.contains(&value) {
            Value::String(value)
        } else {
            Value::String(String::new())
        }
    }
}

pub fn normalize_kv_values(values: Option<&Value>, fields: &[KvField]) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let field_map: HashMap<String, &KvField> = fields.iter().map(|f| (f.key.clone(), f)).collect();

    if let Some(Value::Object(obj)) = values {
        for (key, value) in obj {
            let k = safe_trim(Some(key.as_str()));
            if k.is_empty() || !field_map.contains_key(&k) {
                continue;
            }
            let v = if let Some(text) = value.as_str() {
                text.to_string()
            } else if value.is_null() {
                String::new()
            } else {
                value.to_string()
            };
            out.insert(k, v);
        }
    }

    for field in fields {
        if out.get(&field.key).map(|v| v.trim().is_empty()).unwrap_or(true) {
            if !field.default_value.is_empty() {
                out.insert(field.key.clone(), field.default_value.clone());
            }
        }
    }
    out
}

pub fn collect_secret_keys(fields: &[KvField]) -> HashSet<String> {
    fields
        .iter()
        .filter(|f| f.secret)
        .map(|f| f.key.clone())
        .collect()
}

pub fn kv_fields_to_value(fields: &[KvField]) -> Vec<Value> {
    fields
        .iter()
        .map(|field| {
            json!({
                "key": field.key,
                "label": field.label,
                "description": field.description,
                "placeholder": field.placeholder,
                "default": field.default_value,
                "required": field.required,
                "multiline": field.multiline,
                "secret": field.secret,
            })
        })
        .collect()
}

pub fn redact_kv_fields_for_log(fields: &[KvField], secret_keys: &HashSet<String>) -> Vec<Value> {
    fields
        .iter()
        .map(|field| {
            let mut map = Map::new();
            map.insert("key".to_string(), Value::String(field.key.clone()));
            map.insert("label".to_string(), Value::String(field.label.clone()));
            map.insert("description".to_string(), Value::String(field.description.clone()));
            map.insert("placeholder".to_string(), Value::String(field.placeholder.clone()));
            if !secret_keys.contains(&field.key) {
                map.insert("default".to_string(), Value::String(field.default_value.clone()));
            }
            map.insert("required".to_string(), Value::Bool(field.required));
            map.insert("multiline".to_string(), Value::Bool(field.multiline));
            map.insert("secret".to_string(), Value::Bool(field.secret));
            Value::Object(map)
        })
        .collect()
}

pub fn redact_kv_values(values: &Value, secret_keys: &HashSet<String>, mask: &str) -> Value {
    let obj = match values.as_object() {
        Some(obj) => obj,
        None => return values.clone(),
    };
    let mut out = Map::new();
    for (key, value) in obj {
        if secret_keys.contains(key) {
            out.insert(key.clone(), Value::String(mask.to_string()));
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

pub fn redact_prompt_entry(entry: &Value, secret_keys: &HashSet<String>, mask: &str) -> Value {
    let obj = match entry.as_object() {
        Some(obj) => obj,
        None => return entry.clone(),
    };
    let mut out = Map::new();
    for (key, value) in obj {
        if key == "prompt" {
            out.insert(key.clone(), redact_prompt_fields(value, secret_keys));
        } else if key == "response" {
            out.insert(key.clone(), redact_response_values(value, secret_keys, mask));
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

fn redact_prompt_fields(prompt: &Value, secret_keys: &HashSet<String>) -> Value {
    let obj = match prompt.as_object() {
        Some(obj) => obj,
        None => return prompt.clone(),
    };
    let mut out = Map::new();
    for (key, value) in obj {
        if key == "fields" {
            if let Some(arr) = value.as_array() {
                let mut redacted = Vec::new();
                for field in arr {
                    if let Some(field_obj) = field.as_object() {
                        let field_key = field_obj
                            .get("key")
                            .and_then(|v| v.as_str())
                            .map(|v| v.to_string())
                            .unwrap_or_default();
                        let mut field_map = field_obj.clone();
                        if !field_key.is_empty() && secret_keys.contains(&field_key) {
                            field_map.remove("default");
                        }
                        redacted.push(Value::Object(field_map));
                    } else {
                        redacted.push(field.clone());
                    }
                }
                out.insert(key.clone(), Value::Array(redacted));
            } else {
                out.insert(key.clone(), value.clone());
            }
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

fn redact_response_values(response: &Value, secret_keys: &HashSet<String>, mask: &str) -> Value {
    let obj = match response.as_object() {
        Some(obj) => obj,
        None => return response.clone(),
    };
    let mut out = Map::new();
    for (key, value) in obj {
        if key == "values" {
            out.insert(key.clone(), redact_kv_values(value, secret_keys, mask));
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}
