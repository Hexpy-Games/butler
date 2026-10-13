//! Authenticated App asset lookup for structured-answer validation.
use super::super::GuidedTools;
use serde_json::{Value, json};
use std::collections::HashSet;
use tokio_util::sync::CancellationToken;
pub(in crate::host::guided::tools) async fn lookup_assets(
    owner: &GuidedTools,
    ids: Vec<String>,
) -> HashSet<String> {
    let Some(client) = super::client::Client::new(owner).await else {
        return HashSet::new();
    };
    let result = client
        .call(
            "assets.lookup",
            &Value::Null,
            &json!({"ids":ids}),
            &CancellationToken::new(),
        )
        .await;
    result["ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Asset ids are durable; HTTP capability URLs belong only to App responses.
pub(super) fn model_result(name: &str, result: &mut Value) {
    if name != "image_collect" {
        return;
    }
    if let Some(object) = result.as_object_mut() {
        for key in ["url", "signed_url", "image_url"] {
            object.remove(key);
        }
    }
    if result["status"] != "ok" && result["recovery"].is_null() {
        result["recovery"] = json!(collect_recovery(result["reason"].as_str().unwrap_or("")));
    }
}

/// A refused collection names a different source to try, so the same
/// refused source is not retried; an image is optional for the answer.
fn collect_recovery(reason: &str) -> String {
    let cause = match reason {
        "stale_ref" | "control_changed" => {
            return "The page changed; observe again and use the new observation's refs.".into();
        }
        "blocked_by" => "Another element covers this image.",
        "invalid_image" | "image_fetch_failed" => "That source gave no usable image.",
        "timeout" | "image_timeout" => "Collection timed out.",
        _ => "This source was not collected.",
    };
    format!(
        "{cause} Do not retry the same source. Try one other source once: the image element's own ref, its image URL from the page, or a region around it. If that also fails, continue without this image."
    )
}
