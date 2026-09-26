use std::collections::HashSet;

use serde_json::Value;

use super::{SearchBucket, SearchPlan, SearchQuery};

pub(super) fn parse_and_normalize(text: &str, default_depth: &str) -> Result<SearchPlan, String> {
    let body = text.trim();
    let body = if body.starts_with("```") && body.ends_with("```") {
        body.lines()
            .skip(1)
            .take_while(|line| !line.trim_start().starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_owned()
    } else {
        body.to_owned()
    };
    let raw: Value =
        serde_json::from_str(&body).map_err(|_| "planner returned invalid JSON".to_owned())?;
    let object = raw
        .as_object()
        .ok_or_else(|| "plan is not an object".to_owned())?;
    let depth = depth(object.get("depth"), default_depth);
    let queries = normalize_queries(object.get("queries"), &depth);
    if queries.is_empty() {
        return Err("plan has no queries".into());
    }
    let decomposition = normalize_buckets(object.get("decomposition"));
    let intent = object
        .get("intent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| utf16_slice(value, 160))
        .unwrap_or_else(|| "web_search".into());
    let scope = enum_value(
        object.get("scope"),
        &[
            "single_topic",
            "multi_domain",
            "comparison",
            "verification",
            "unknown",
        ],
    )
    .unwrap_or_else(|| "unknown".into());
    Ok(SearchPlan {
        verification_required: object.get("verificationRequired").and_then(Value::as_bool)
            == Some(true)
            || depth == "deep"
            || depth == "verification",
        depth,
        intent,
        scope,
        decomposition,
        queries,
        planner_attempts: 0,
    })
}

fn normalize_queries(value: Option<&Value>, depth: &str) -> Vec<SearchQuery> {
    let limit = match depth {
        "quick" => 4,
        "deep" => 8,
        "verification" => 6,
        _ => 6,
    };
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for item in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(raw) = item.as_object() else {
            continue;
        };
        let Some(query) = raw
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|query| query.encode_utf16().count() >= 2)
        else {
            continue;
        };
        if !seen.insert(query.to_lowercase()) {
            continue;
        }
        let bucket_id = raw
            .get("bucketId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(safe_id);
        output.push(SearchQuery {
            bucket_id,
            query: utf16_slice(query, 220),
            purpose: enum_value(
                raw.get("purpose"),
                &[
                    "scan",
                    "curation",
                    "validation",
                    "official",
                    "reaction",
                    "comparison",
                ],
            )
            .unwrap_or_else(|| "scan".into()),
            priority: priority(raw.get("priority")),
            expected_source_type: enum_value(
                raw.get("expectedSourceType"),
                &[
                    "official",
                    "news",
                    "curation",
                    "community",
                    "review",
                    "docs",
                ],
            ),
        });
        if output.len() >= limit {
            break;
        }
    }
    output
}

fn normalize_buckets(value: Option<&Value>) -> Vec<SearchBucket> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, item)| {
            let raw = item.as_object()?;
            let label = raw
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let id = raw
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(safe_id)
                .unwrap_or_else(|| format!("bucket_{}", index + 1));
            Some(SearchBucket {
                id,
                label: utf16_slice(label, 80),
                priority: priority(raw.get("priority")),
            })
        })
        .take(8)
        .collect()
}

fn depth(value: Option<&Value>, default: &str) -> String {
    enum_value(value, &["quick", "balanced", "deep", "verification"])
        .unwrap_or_else(|| default.to_owned())
}

fn priority(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some("low") => "low",
        Some("high") => "high",
        _ => "normal",
    }
    .into()
}

fn enum_value(value: Option<&Value>, allowed: &[&str]) -> Option<String> {
    let value = value.and_then(Value::as_str)?;
    allowed.contains(&value).then(|| value.to_owned())
}

fn safe_id(value: &str) -> String {
    let mut output = String::new();
    let mut underscore = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            output.push(character);
            underscore = false;
        } else if !underscore {
            output.push('_');
            underscore = true;
        }
        if output.len() >= 48 {
            break;
        }
    }
    let value = output.trim_matches('_');
    if value.is_empty() {
        "bucket".into()
    } else {
        value.into()
    }
}

fn utf16_slice(value: &str, limit: usize) -> String {
    crate::json::Utf16Slice::new(value, 0, limit)
        .utf8_lossy()
        .into_owned()
}
