//! One-shot canonical Conversation compaction command.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};

use crate::{
    context::{compact_transcript, compaction_snapshot_path},
    conversation::{
        AgentConversationStore, ConversationStoreConfig,
        conversation_session_id_for_durable_session, conversation_store_path,
    },
    locale::LocaleCollation,
    operations::MetricFiles,
};

use super::{
    CliError, ResolvedInstallation, context_budget_owner, open_status_models, unavailable,
    validate_write_destination,
};

pub(super) async fn run(
    data_root: &Path,
    installation: &ResolvedInstallation,
    session_id: Option<&str>,
) -> Result<(Value, String), CliError> {
    let session_id = session_id.expect("parser requires a context compact session");
    validate_compaction_destinations(data_root, installation, session_id)?;
    let models = open_status_models(data_root).await?;
    let budget_owner = context_budget_owner(&models);
    let collation = Arc::new(LocaleCollation::new("en-US").map_err(|_| {
        unavailable(
            "native_context_collation_unavailable",
            "Conversation collation is unavailable.",
        )
    })?);
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: conversation_store_path(data_root),
        identity_clock: Arc::new(super::super::SystemIdentity),
        collation,
    })
    .await
    .map_err(|error| unavailable("native_context_conversation_unavailable", error.to_string()))?;

    let metrics = Arc::new(MetricFiles::new(data_root.to_path_buf()));
    let result = compact_transcript(
        data_root,
        session_id,
        &store,
        &budget_owner,
        metrics.as_ref(),
    )
    .await;
    let close_result = store.close().await;
    let snapshot = result
        .map_err(|error| unavailable("native_context_compaction_failed", error.to_string()))?;
    close_result.map_err(|error| {
        unavailable(
            "native_context_conversation_close_failed",
            error.to_string(),
        )
    })?;
    let data = json!({
        "snapshotId": snapshot.snapshot_id,
        "sessionId": snapshot.session_id,
        "status": snapshot.status,
        "preEstimatedTokens": snapshot.pre_estimated_tokens,
        "postEstimatedTokens": snapshot.post_estimated_tokens,
        "diagnostics": snapshot.diagnostics,
    });
    let human = format!("Compaction {}: {}", snapshot.status, snapshot.snapshot_id);
    Ok((data, human))
}

fn validate_compaction_destinations(
    data_root: &Path,
    installation: &ResolvedInstallation,
    session_id: &str,
) -> Result<(), CliError> {
    let runtime_dir = data_root.join("runtime");
    let conversation_store = conversation_store_path(data_root);
    let context_dir = data_root.join("context");
    let compactions_dir = context_dir.join("compactions");
    let metrics_dir = data_root.join("metrics");
    let metric_file = metrics_dir.join("context-compaction.jsonl");
    for directory in [&runtime_dir, &context_dir, &compactions_dir, &metrics_dir] {
        validate_write_destination(installation, directory, false)?;
    }
    validate_write_destination(installation, &conversation_store, true)?;
    validate_write_destination(installation, &metric_file, true)?;

    let trimmed_session_id = crate::public_text::trim_js_whitespace(session_id);
    let hash_source = if trimmed_session_id.is_empty() {
        "butler/main"
    } else {
        trimmed_session_id
    };
    let hashed_session_id = conversation_session_id_for_durable_session(hash_source);
    let candidates = if trimmed_session_id.is_empty() {
        vec![hashed_session_id.as_str()]
    } else {
        vec![trimmed_session_id, hashed_session_id.as_str()]
    };
    for canonical_candidate in candidates {
        let snapshot = compaction_snapshot_path(data_root, canonical_candidate);
        validate_write_destination(installation, &snapshot, true)?;
    }
    Ok(())
}
