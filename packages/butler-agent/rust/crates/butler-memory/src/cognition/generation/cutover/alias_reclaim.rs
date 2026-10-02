//! Explicit physical reclaim, with no projection or model work.
use super::super::{initialize::durable, rebuild::vacuum_snapshot_abortable};
use super::{descriptor, error, read_manifest};
use crate::cognition::{
    CognitionCode, CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget,
    assert_mutation_authority, ensure_data_authority, graph::GraphRepository, resolve_generation,
};
use crate::coordination::CognitionWriteCoordinator;
use std::{fs, path::Path, sync::Arc, time::Instant};
use tokio_util::sync::CancellationToken;

pub(in crate::cognition) async fn advance(
    data: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    stop: &CancellationToken,
) -> CognitionResult<bool> {
    if std::env::var("BUTLER_ALIAS_POSTINGS_READ_V1").as_deref() == Ok("1")
        || !matches!(target, MemoryGenerationTarget::Active { .. })
    {
        return Ok(false);
    }
    let (data, environment, target, stop) = (
        data.to_owned(),
        environment.clone(),
        target.clone(),
        stop.clone(),
    );
    let lock = environment.consolidation_lock(&data);
    let lease =
        super::super::stage::acquire_abortable(&coordinator, &lock, "cutover", &stop).await?;
    let started = Instant::now();
    let result =
        super::super::stage::leased(lease, CognitionCode::MemoryGraphUnavailable, move |lease| {
            let handle = resolve_generation(&data, &environment, &target)?;
            ensure_data_authority(&data, &[&lock, &handle.root, &handle.graph_path])?;
            assert_mutation_authority(&data, &environment, &target, &handle)?;
            let mut graph = GraphRepository::open(&handle.graph_path)?;
            let dropped = graph.drop_alias_legacy(&stop);
            let closed = graph.close();
            let dropped = dropped?;
            closed?;
            if let Some(advanced) = dropped {
                return Ok((advanced, "drop"));
            }
            rotate(&data, &environment, &handle.graph_path, lease, &stop)?;
            Ok((false, "vacuum_cutover"))
        })
        .await;
    if let Ok((_, phase)) = &result {
        butler_core::diagnostic!(
            "[alias-reclaim] {phase}_lease_ms={}",
            started.elapsed().as_millis()
        );
    }
    result.map(|(advanced, _)| advanced)
}

fn rotate(
    data: &Path,
    environment: &CognitionPathEnvironment,
    graph: &Path,
    lease: &crate::coordination::CognitionWriteLease,
    stop: &CancellationToken,
) -> CognitionResult<()> {
    let capture = descriptor::capture_active_descriptor(data, environment)?;
    let authority = environment
        .memory_root(data)
        .join("generations")
        .join(&capture.fields.generation_id)
        .join("manifest.json");
    let (_, manifest_sha) = read_manifest(&authority, &capture.fields.generation_id)?;
    let storage_id = uuid::Uuid::new_v4().to_string();
    let target = environment
        .memory_root(data)
        .join("generations")
        .join(format!(".storage-{storage_id}"));
    ensure_data_authority(data, &[&target, &authority])?;
    durable::create_dir(&target)?;
    let mut cleanup = Cleanup(Some(target.clone()));
    vacuum_snapshot_abortable(graph, &target.join("graph.sqlite"), stop)?;
    let compact = butler_platform::sqlite::open(target.join("graph.sqlite"))
        .map_err(crate::cognition::graph::db_error)?;
    compact
        .execute(
            "UPDATE memory_state SET value='fresh' WHERE key='alias_postings_v2'",
            [],
        )
        .map_err(crate::cognition::graph::db_error)?;
    compact
        .close()
        .map_err(|(_, e)| crate::cognition::graph::db_error(e))?;
    butler_platform::secure_fs::sync_path(target.join("graph.sqlite")).map_err(io_error)?;
    butler_platform::secure_fs::sync_path(&target).map_err(io_error)?;
    if stop.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let mut next = capture.fields.clone();
    next.storage_generation_id = Some(storage_id);
    descriptor::commit_descriptor_transition(
        data,
        environment,
        lease,
        &descriptor::TransitionGuard {
            expected: &capture,
            target_generation_id: &capture.fields.generation_id,
            target_manifest_sha256: &manifest_sha,
        },
        &next,
    )?;
    // Only graph.sqlite moves. Keep the old graph file until
    // all readers release their snapshots; no automatic file deletion.
    cleanup.0 = None;
    Ok(())
}

struct Cleanup(Option<std::path::PathBuf>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_dir_all(path);
        }
    }
}
fn io_error(e: std::io::Error) -> crate::cognition::CognitionError {
    error(CognitionCode::MemoryGraphUnavailable).with_source(e)
}
