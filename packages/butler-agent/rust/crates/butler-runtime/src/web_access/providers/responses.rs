use std::collections::HashMap;

use serde_json::Value;
use url::Url;

use super::contracts::SearchResult;

pub(super) fn results_from_response(payload: &Value) -> Vec<SearchResult> {
    let mut indexes = HashMap::<String, usize>::new();
    let mut results = Vec::<SearchResult>::new();
    for item in payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for source in item
            .pointer("/action/sources")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(url) = source.get("url").and_then(Value::as_str).map(str::trim) else {
                continue;
            };
            if url.is_empty() || !valid_url(url) {
                continue;
            }
            let index = *indexes.entry(url.to_owned()).or_insert_with(|| {
                results.push(SearchResult {
                    title: url.to_owned(),
                    url: url.to_owned(),
                    snippet: String::new(),
                    source: super::contracts::compact_domain(url),
                    published_at: None,
                });
                results.len() - 1
            });
            let current = &mut results[index];
            current.title = field(source, "title").unwrap_or_else(|| current.title.clone());
            current.snippet = field(source, "snippet").unwrap_or_else(|| current.snippet.clone());
        }
    }
    for item in payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for content in item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            for annotation in content
                .get("annotations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if annotation.get("type").and_then(Value::as_str) != Some("url_citation") {
                    continue;
                }
                let Some(url) = annotation.get("url").and_then(Value::as_str).map(str::trim) else {
                    continue;
                };
                if url.is_empty() || !valid_url(url) || indexes.contains_key(url) {
                    continue;
                }
                indexes.insert(url.to_owned(), results.len());
                results.push(SearchResult {
                    title: field(annotation, "title").unwrap_or_else(|| url.to_owned()),
                    url: url.to_owned(),
                    snippet: String::new(),
                    source: super::contracts::compact_domain(url),
                    published_at: None,
                });
            }
        }
    }
    results
}

pub(super) fn overview_from_response(payload: &Value) -> Option<String> {
    let output_text = payload.get("output_text").and_then(Value::as_str);
    if let Some(text) = output_text.and_then(bounded_overview) {
        return Some(text);
    }
    payload
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .find_map(|content| {
            content
                .get("text")
                .and_then(Value::as_str)
                .and_then(bounded_overview)
        })
}

pub(super) fn bounded_overview(text: &str) -> Option<String> {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        None
    } else if compact.chars().count() <= 1_600 {
        Some(compact)
    } else {
        Some(format!(
            "{}…",
            compact.chars().take(1_599).collect::<String>().trim_end()
        ))
    }
}

pub(super) fn field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn valid_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
    })
}
