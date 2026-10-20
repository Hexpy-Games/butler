//! Resolve image-file durability before a result enters a persistent journal.
use super::{GuidedTools, client::Client};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{BtccError, ToolExecutionError};
use serde_json::Value;

pub(in crate::host::guided::tools) async fn wait(
    owner: &GuidedTools,
    result: &JsonDocument,
) -> Result<(), ToolExecutionError> {
    if !result.as_str().contains("\"file_id\"") {
        return Ok(());
    }
    let value: Value = serde_json::from_str(result.as_str()).map_err(|_| failure())?;
    if value.pointer("/image/file/file_id").is_none() {
        return Ok(());
    }
    let client = Client::new(owner).await.ok_or_else(failure)?;
    client.durable(&value).await
}

pub(super) fn failure() -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::relayed(
        "message_file_not_durable",
        "Image file publication did not complete.",
    ))
}
