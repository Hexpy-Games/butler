//! Query-string parameters, parsed as the Bun gateway did (JavaScript
//! number rules).

use std::collections::HashMap;

use axum::extract::Query;
use axum::http::Uri;

use super::DEFAULT_PAGE_LIMIT;

/// The first value of every query parameter.
pub(super) fn query(uri: &Uri) -> HashMap<String, String> {
    Query::<Vec<(String, String)>>::try_from_uri(uri)
        .map(|query| {
            query
                .0
                .into_iter()
                .fold(HashMap::new(), |mut values, (key, value)| {
                    values.entry(key).or_insert(value);
                    values
                })
        })
        .unwrap_or_default()
}

pub(super) fn cursor_param(value: Option<&String>) -> f64 {
    value
        .and_then(|value| javascript_number(value))
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

pub(super) fn limit_param(value: Option<&String>) -> usize {
    value
        .and_then(|value| javascript_number(value))
        .filter(|value| value.is_finite())
        .map_or(DEFAULT_PAGE_LIMIT, |value| {
            butler_core::json::saturating_usize(value.floor().clamp(1.0, DEFAULT_PAGE_LIMIT as f64))
        })
}

fn javascript_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let integer = if let Some(digits) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        u64::from_str_radix(digits, 16).ok()
    } else if let Some(digits) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        u64::from_str_radix(digits, 2).ok()
    } else if let Some(digits) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        u64::from_str_radix(digits, 8).ok()
    } else {
        return trimmed.parse::<f64>().ok().or_else(|| {
            matches!(trimmed, "Infinity" | "+Infinity")
                .then_some(f64::INFINITY)
                .or_else(|| (trimmed == "-Infinity").then_some(f64::NEG_INFINITY))
        });
    };
    integer.map(|number| number as f64)
}
