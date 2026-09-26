//! Borrowed native catalog projection for one progressive discovery call.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::json;

#[derive(Clone, Copy)]
pub(crate) struct BridgeCatalogTool<'a> {
    pub name: &'a str,
    pub definition: &'a Value,
    pub category: &'a str,
    pub tags: &'a [String],
    pub safety_notes: &'a [String],
    pub enabled: bool,
    pub disabled_reason: Option<&'a str>,
    pub recovery_hint: Option<&'a str>,
}

impl BridgeCatalogTool<'_> {
    fn schema(&self) -> Value {
        sanitize(self.definition.get("parameters").unwrap_or(&Value::Null))
    }

    fn digest(&self, schema: &Value) -> Result<String, json::JsonError> {
        // Source stableJson sorts keys by UTF-16 and does not normalize text.
        let body = json::stringify_sorted(schema, &|a, b| a.encode_utf16().cmp(b.encode_utf16()))?;
        Ok(format!("sha256:{:x}", Sha256::digest(body.as_bytes())))
    }
}

pub(crate) fn describe_native(tool: BridgeCatalogTool<'_>) -> Result<Value, json::JsonError> {
    let schema = tool.schema();
    let digest = tool.digest(&schema)?;
    let affordance = if tool.enabled {
        json!({"type":"native_tool","tool_name":tool.name})
    } else {
        json!({"type":"disabled","reason":tool.disabled_reason})
    };
    Ok(json!({
        "id":format!("native:{}",tool.name), "name":tool.name,
        "namespace":null, "provider":"native", "category":tool.category,
        "enabled":tool.enabled, "disabled_reason":tool.disabled_reason,
        "recovery_hint":if tool.enabled { None } else { tool.recovery_hint },
        "safety_notes":tool.safety_notes, "schema":schema, "schema_digest":digest,
        "call_affordance":affordance,
    }))
}

pub(crate) fn search_native<'a>(
    tools: impl Iterator<Item = BridgeCatalogTool<'a>>,
    args: &serde_json::Map<String, Value>,
) -> Result<Value, json::JsonError> {
    let query = terms(args.get("query").and_then(Value::as_str));
    let capability = terms(args.get("capability").and_then(Value::as_str));
    let category = args.get("category").and_then(Value::as_str);
    let include_disabled = args.get("include_disabled") != Some(&Value::Bool(false));
    let limit = args
        .get("limit")
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .map_or(20, |number| (number.floor() as usize).clamp(1, 50));
    let mut ranked = Vec::new();
    for tool in tools {
        if !include_disabled && !tool.enabled || category.is_some_and(|c| c != tool.category) {
            continue;
        }
        let name = tool.name.to_lowercase();
        let summary = summary(
            tool.definition
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        let mut score = 0;
        for (words, exact, tag, cat, provider, description) in
            [(&query, 80, 20, 16, 10, 4), (&capability, 24, 28, 20, 8, 5)]
        {
            let mut subtotal = 0;
            for term in words {
                if name == *term {
                    subtotal += exact;
                }
                if name.contains(term) {
                    subtotal += exact / 2;
                }
                if tool.category == term {
                    subtotal += cat;
                }
                if "native" == term {
                    subtotal += provider;
                }
                if tool.tags.iter().any(|value| {
                    let tag = value.to_lowercase();
                    tag == *term || tag.contains(term)
                }) {
                    subtotal += tag;
                }
                if summary.to_lowercase().contains(term) {
                    subtotal += description;
                }
            }
            if !words.is_empty() && subtotal == 0 {
                score = -1;
                break;
            }
            score += subtotal;
        }
        if score < 0 {
            continue;
        }
        let schema = tool.schema();
        let mut tags = tool.tags.to_vec();
        tags.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        tags.dedup();
        let risk = if tool.definition.get("concurrencySafe") != Some(&Value::Bool(true))
            || tool.category == "file"
                && !matches!(tool.name, "read_file" | "grep_files" | "list_files")
            || matches!(
                tool.category,
                "command" | "automation" | "dispatch" | "mcp" | "work"
            ) {
            "high"
        } else if matches!(tool.category, "monitoring" | "todo" | "control") {
            "low"
        } else {
            "medium"
        };
        let result = json!({
            "id":format!("native:{}",tool.name), "name":tool.name,
            "namespace":null, "provider":"native", "category":tool.category,
            "summary":summary, "tags":tags, "risk_level":risk,
            "enabled":tool.enabled, "disabled_reason":tool.disabled_reason,
            "recovery_hint":tool.recovery_hint, "schema_digest":tool.digest(&schema)?,
        });
        ranked.push((score, format!("native:{}", tool.name), result));
    }
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.encode_utf16().cmp(b.1.encode_utf16()))
    });
    Ok(
        json!({"ok":true,"results":ranked.into_iter().take(limit).map(|(_,_,item)|item).collect::<Vec<_>>()}),
    )
}

fn terms(value: Option<&str>) -> Vec<String> {
    let mut found = Vec::new();
    for word in value
        .unwrap_or("")
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
    {
        let word = word.trim().to_lowercase();
        if !word.is_empty() && !found.contains(&word) {
            found.push(word);
        }
    }
    found
}

fn summary(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.encode_utf16().count() <= 220 {
        return normalized;
    }
    let head: String = normalized
        .encode_utf16()
        .take(217)
        .map(|unit| char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}'))
        .collect();
    format!("{}...", head.trim_end())
}

fn sanitize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sanitize).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| {
                    let normalized = key
                        .to_ascii_lowercase()
                        .chars()
                        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
                        .collect::<String>();
                    let sensitive = matches!(
                        normalized.as_str(),
                        "default"
                            | "example"
                            | "examples"
                            | "secret"
                            | "token"
                            | "api_key"
                            | "apikey"
                            | "password"
                            | "authorization"
                    );
                    (
                        key.clone(),
                        if sensitive {
                            Value::String("[redacted]".into())
                        } else {
                            sanitize(value)
                        },
                    )
                })
                .collect(),
        ),
        scalar => scalar.clone(),
    }
}
