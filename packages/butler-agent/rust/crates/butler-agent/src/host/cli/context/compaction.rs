//! One-shot canonical Conversation compaction command.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};

use crate::context::compact_transcript;
use crate::context::compaction_snapshot_path;
use crate::operations::MetricFiles;
use butler_core::locale::LocaleCollation;
use butler_turn::conversation::AgentConversationStore;
use butler_turn::conversation::ConversationStoreConfig;
use butler_turn::conversation::conversation_session_id_for_durable_session;
use butler_turn::conversation::conversation_store_path;

use super::{
    CliError, ResolvedInstallation, context_budget_owner, open_status_models, unavailable,
    validate_write_destination,
};

pub(super) async fn run(
    data_root: &Path,
    installation: &ResolvedInstallation,
    session_id: Option<&str>,
) -> Result<(Value, String), CliError> {
    let Some(session_id) = session_id else {
        return Err(CliError::invalid("context compact requires a session"));
    };
    validate_compaction_destinations(data_root, installation, session_id)?;
    let models = open_status_models(data_root).await?;
    let budget_owner = context_budget_owner(&models);
    let collation = Arc::new(LocaleCollation::new("en-US").map_err(|source| {
        unavailable(
            "native_context_collation_unavailable",
            "Conversation collation is unavailable.",
        )
        .with_source(source)
    })?);
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: conversation_store_path(data_root),
        identity_clock: Arc::new(crate::host::SystemIdentity),
        collation,
    })
    .await
    .map_err(|error| {
        unavailable("native_context_conversation_unavailable", error.to_string()).with_source(error)
    })?;

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
    let snapshot = result.map_err(|error| {
        unavailable("native_context_compaction_failed", error.to_string()).with_source(error)
    })?;
    close_result.map_err(|error| {
        unavailable(
            "native_context_conversation_close_failed",
            error.to_string(),
        )
        .with_source(error)
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

    let trimmed_session_id = butler_core::public_text::trim_js_whitespace(session_id);
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
