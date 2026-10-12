//! Conversation-scoped asset lookup for structured-answer validation.
use super::super::GuidedTools;
use serde_json::{Value, json};
use std::collections::HashSet;
use tokio_util::sync::CancellationToken;
#[allow(
    dead_code,
    reason = "Consumed by the parallel answer_blocks tool integration"
)]
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
}
