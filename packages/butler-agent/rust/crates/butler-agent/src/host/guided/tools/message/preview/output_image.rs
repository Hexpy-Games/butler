//! Preserve the separately bounded visual carrier rather than summarize pixels.
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_turn::btcc::ToolResult;
use serde_json::Value;

pub(in crate::host::guided::tools::message) fn admitted(result: &ToolResult) -> bool {
    if !result.ok
        || !matches!(
            result.name.as_str(),
            "output_check" | "browser_observe" | "browser_screenshot" | "tool_call"
        )
    {
        return false;
    }
    let Some(raw) = result
        .output
        .as_ref()
        .filter(|v| v.as_str().len() <= 207 * 1024)
    else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(raw.as_str()) else {
        return false;
    };
    if !matches!(
        value["schema"].as_str(),
        Some(
            "butler.output-check.v1"
                | "butler.browser-observation.v1"
                | "butler.browser-capture.v1"
        )
    ) || value["image"]["mime_type"] != "image/jpeg"
    {
        return false;
    }
    value["image"]["data"].as_str().is_some_and(|data| {
        STANDARD
            .decode(data)
            .is_ok_and(|bytes| bytes.len() <= 150 * 1024 && bytes.starts_with(&[0xff, 0xd8]))
    })
}
