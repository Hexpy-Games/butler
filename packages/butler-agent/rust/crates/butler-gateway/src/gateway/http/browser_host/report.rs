//! Compact untrusted page diagnostics; totals survive pagination.
use serde_json::{Value, json};
fn text(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_control() || c == '"' || c == '\\' {
                ' '
            } else {
                c
            }
        })
        .scan(0, |bytes, c| {
            *bytes += c.len_utf8();
            (*bytes <= 120).then_some(c)
        })
        .collect()
}
pub(super) fn shape(value: &Value) -> Value {
    if value["status"] == "budget_exhausted" {
        let shown: Vec<_> = value["errors"]["shown"]
            .as_array()
            .into_iter()
            .flatten()
            .take(5)
            .map(text)
            .collect();
        return json!({"status":"budget_exhausted","reason":"diagnostics_limit","errors":{"total":value["errors"]["total"].as_u64().unwrap_or(0),"shown":shown}});
    }
    if value["status"] == "unknown" || value["status"] == "navigation_denied" {
        return json!({"status":value["status"],"reason":text(&value["reason"])});
    }
    if value["status"] != "ok"
        || value["errors"]["total"].as_u64().is_none()
        || !value["errors"]["shown"].is_array()
        || value["layout"]["blank"].as_bool().is_none()
    {
        return json!({"status":"unknown","reason":"invalid_result"});
    }
    let shown: Vec<String> = value["errors"]["shown"]
        .as_array()
        .into_iter()
        .flatten()
        .take(5)
        .map(text)
        .collect();
    let total = value["errors"]["total"]
        .as_u64()
        .unwrap_or(shown.len() as u64);
    let desktop = value["layout"]["overflow_px"]["desktop"]
        .as_u64()
        .unwrap_or(0);
    let mobile = value["layout"]["overflow_px"]["mobile"]
        .as_u64()
        .unwrap_or(0);
    let blank = value["layout"]["blank"].as_bool().unwrap_or(true);
    let warnings: Vec<&str> = if value["warnings"]
        .as_array()
        .is_some_and(|w| w.iter().any(|v| v == "root_absolute_paths"))
    {
        vec!["root_absolute_paths"]
    } else {
        vec![]
    };
    let mut result = json!({"status":if total > 0 || blank || desktop > 0 || mobile > 0 || !warnings.is_empty() {"issues"} else {"ok"},"load_ms":value["load_ms"].as_u64().unwrap_or(0),"title":text(&value["title"]),"errors":{"total":total,"shown":shown},"layout":{"blank":blank,"overflow_px":{"desktop":desktop,"mobile":mobile}},"warnings":warnings});
    if let Some(cursor) = value["next_cursor"]
        .as_u64()
        .filter(|c| *c > 0 && *c < total)
    {
        result["next_cursor"] = json!(cursor);
    }
    if let Some(data) = value["image"]["data"].as_str() {
        use base64::Engine;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
            let dimensions = image::ImageReader::new(std::io::Cursor::new(&bytes))
                .with_guessed_format()
                .ok()
                .and_then(|r| r.into_dimensions().ok());
            if bytes.len() <= 150 * 1024
                && bytes.starts_with(&[0xff, 0xd8])
                && dimensions.is_some_and(|(w, h)| w <= 1024 && h <= 1024)
            {
                result["image"] = json!({"mime_type":"image/jpeg","data":data});
            }
        }
    }
    result
}
