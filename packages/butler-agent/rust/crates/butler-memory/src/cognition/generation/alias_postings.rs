//! Online alias storage stage, independent of startup and generation readiness.
use crate::cognition::{
    CognitionCode, CognitionPathEnvironment, CognitionResult, MemoryGenerationTarget,
    assert_mutation_authority, ensure_data_authority, graph::GraphRepository, resolve_generation,
};
use crate::coordination::CognitionWriteCoordinator;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

/// Kept only while copying; no transaction or snapshot spans leases.
#[derive(Default)]
pub(in crate::cognition) struct Session {
    graph: parking_lot::Mutex<Option<(PathBuf, GraphRepository)>>,
}

pub(in crate::cognition) async fn advance(
    data: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    stop: &CancellationToken,
    session: Arc<Session>,
) -> CognitionResult<bool> {
    let data = data.to_owned();
    let environment = environment.clone();
    let target = target.clone();
    let stop = stop.clone();
    let lock = environment.consolidation_lock(&data);
    let lease =
        super::stage::acquire_abortable(&coordinator, &lock, "alias_postings_v2", &stop).await?;
    let started = std::time::Instant::now();
    let result = super::stage::leased(lease, CognitionCode::MemoryGraphUnavailable, move |lease| {
        let handle = resolve_generation(&data, &environment, &target)?;
        ensure_data_authority(&data, &[&lock, &handle.graph_path])?;
        lease
            .assert_for_path(&lock)
            .map_err(crate::cognition::CognitionError::from)?;
        assert_mutation_authority(&data, &environment, &target, &handle)?;
        let mut graph = session.graph.lock();
        if graph
            .as_ref()
            .is_some_and(|(path, _)| path != &handle.graph_path)
            && let Some((_, graph)) = graph.take()
        {
            graph.close()?;
        }
        if graph.is_none() {
            *graph = Some((
                handle.graph_path.clone(),
                GraphRepository::open_alias_copy(&handle.graph_path)?,
            ));
        }
        let advanced = graph
            .as_mut()
            .ok_or_else(|| {
                crate::cognition::CognitionError::new(
                    CognitionCode::MemoryGraphUnavailable,
                    "alias connection unavailable",
                )
            })?
            .1
            .advance_alias_postings(&stop)?;
        if !advanced && let Some((_, graph)) = graph.take() {
            graph.close()?;
        }
        Ok(advanced)
    })
    .await;
    butler_core::diagnostic!(
        "[alias-postings] copy_lease_ms={}",
        started.elapsed().as_millis()
    );
    result
}

/// Closing an idle cached connection is file I/O too. The consumer awaits it.
pub(in crate::cognition) async fn close(session: Arc<Session>) -> CognitionResult<()> {
    tokio::task::spawn_blocking(move || {
        if let Some((_, graph)) = session.graph.lock().take() {
            graph.close()?;
        }
        Ok(())
    })
    .await
    .map_err(|source| {
        crate::cognition::CognitionError::new(
            CognitionCode::MemoryGraphUnavailable,
            "alias close failed",
        )
        .with_source(source)
    })?
}
