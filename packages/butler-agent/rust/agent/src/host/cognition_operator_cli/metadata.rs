use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    cognition::{
        BoxStoreService, CognitionPathEnvironment, FeedbackBufferService,
        LegacyMetadataIntegrityService,
    },
    coordination::CognitionWriteCoordinator,
};

use super::CliError;

pub(super) async fn run(
    command: super::Command,
    data_root: std::path::PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    memory_chunk_id: Option<&str>,
    yes: bool,
    non_interactive: bool,
) -> Result<(Value, String), CliError> {
    let feedback = Arc::new(FeedbackBufferService::new(
        data_root.clone(),
        paths.clone(),
        coordinator.clone(),
    ));
    let box_store = Arc::new(BoxStoreService::new(
        data_root.clone(),
        paths.clone(),
        coordinator.clone(),
    ));
    let service = LegacyMetadataIntegrityService::new(&data_root, paths, box_store, feedback);
    match command {
        super::Command::MetadataInspect => {
            let id = memory_chunk_id.unwrap_or_default();
            let chunk = service
                .inspect(id)
                .await
                .map_err(|error| CliError::failed(error.code, error.message))?
                .ok_or_else(|| {
                    CliError::failed("not_found", format!("memory chunk not found: {id}"))
                })?;
            let human = format!(
                "{}: {} {}",
                chunk.memory_chunk_id, chunk.status, chunk.summary
            );
            Ok((json!({ "chunk": chunk }), human))
        }
        super::Command::MetadataRepairLinks => {
            if !yes && !non_interactive {
                return Err(CliError::invalid(
                    "memory metadata repair-links requires --yes",
                ));
            }
            let report = service
                .repair_links(coordinator)
                .await
                .map_err(|error| CliError::failed(error.code, error.message))?;
            let data = integrity_data(
                report.integrity.chunk_count,
                &report.integrity.missing_box_refs,
                &report.integrity.missing_feedback_refs,
            );
            let mut data = data;
            let fields = crate::json::object_mut(&mut data);
            fields.insert("repaired_box_refs".into(), json!(report.repaired_box_refs));
            fields.insert(
                "repaired_feedback_refs".into(),
                json!(report.repaired_feedback_refs),
            );
            let human = format!(
                "metadata links repaired: box={} feedback={}",
                report.repaired_box_refs, report.repaired_feedback_refs
            );
            Ok((data, human))
        }
        super::Command::MetadataCheck => {
            let report = service
                .check_with_references()
                .await
                .map_err(|error| CliError::failed(error.code, error.message))?;
            let human = format!(
                "metadata integrity: missingBox={} missingFeedback={}",
                report.missing_box_refs.len(),
                report.missing_feedback_refs.len(),
            );
            Ok((
                integrity_data(
                    report.chunk_count,
                    &report.missing_box_refs,
                    &report.missing_feedback_refs,
                ),
                human,
            ))
        }
        _ => Err(CliError::invalid("unsupported metadata operation")),
    }
}

fn integrity_data(
    chunk_count: usize,
    missing_box_refs: &[crate::cognition::MissingBoxRef],
    missing_feedback_refs: &[crate::cognition::MissingFeedbackRef],
) -> Value {
    let checked_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    json!({
        "schema": "butler.cognition.memory-metadata.integrity.v1",
        "checked_at": checked_at,
        "chunk_count": chunk_count,
        "missing_box_refs": missing_box_refs.iter().map(|reference| json!({
            "memory_chunk_id": reference.memory_chunk_id,
            "box_item_id": reference.box_item_id,
        })).collect::<Vec<_>>(),
        "missing_feedback_refs": missing_feedback_refs.iter().map(|reference| json!({
            "memory_chunk_id": reference.memory_chunk_id,
            "feedback_id": reference.feedback_id,
        })).collect::<Vec<_>>(),
    })
}
