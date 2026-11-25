//! Reapply the current extraction rules through the normal shadow consumer.
use super::*;
use crate::cognition::{MEMORY_EXTRACTION_RULES_VERSION, MemorySyncConsumer, MemorySyncPoll};
use std::time::Duration;

type Clock = Arc<dyn Fn() -> String + Send + Sync>;
type Binding = (PathBuf, CognitionPathEnvironment, ResetResult);

/// Whether recovery finished or needs a consumer with fresh graph/cursor caches.
pub enum ReextractOutcome {
    /// The receipt needs no further shadow work.
    Done,
    /// Typed survivors changed; discard the consumer before staging again.
    Restage,
}

pub(crate) fn preparing(root: &Path, paths: &CognitionPathEnvironment) -> io::Result<bool> {
    let pending = paths
        .memory_root(root)
        .join("management/reset-pending.json");
    crate::coordination::ensure_data_authority(root, &[&pending])?;
    let bytes = match fs::read(pending) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let id: String = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    Ok(receipt(root, paths, &id)?.is_some_and(|r| r.kind == "reextract" && r.phase == "preparing"))
}

pub(crate) fn progress(
    root: &Path,
    paths: &CognitionPathEnvironment,
    id: &str,
) -> io::Result<(u64, u64)> {
    let graph = graph(root, paths, id)?;
    graph.query_row("SELECT COUNT(*), COALESCE(SUM(NOT EXISTS(SELECT 1 FROM memory_projection_windows w WHERE w.job_id=j.job_id AND w.state IN ('pending','planned','running'))),0) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision", [], |row| Ok((row.get(0)?, row.get(1)?))).map_err(io::Error::other)
}

pub(crate) async fn run(
    (root, paths): (PathBuf, CognitionPathEnvironment),
    coordinator: Arc<CognitionWriteCoordinator>,
    id: String,
    shadow: &MemorySyncConsumer,
    now: Clock,
    token: CancellationToken,
    stop: CancellationToken,
) -> io::Result<ReextractOutcome> {
    let result = load_receipt(root.clone(), paths.clone(), id).await?;
    if result.kind != "reextract" {
        return Err(io::Error::other("Operation ID conflicts"));
    }
    if result.phase == "complete" {
        hold_retirement(root, paths, coordinator, result, &now, token)?;
        return Ok(ReextractOutcome::Done);
    }
    if result.phase != "preparing" {
        return Ok(ReextractOutcome::Done);
    }
    let binding = (root, paths, result);
    loop {
        let outcome = drive(&binding, &coordinator, shadow, &token).await;
        match outcome {
            Ok(Some(ReextractOutcome::Restage)) => return Ok(ReextractOutcome::Restage),
            Ok(Some(ReextractOutcome::Done)) => {
                return match settle(binding.clone(), coordinator.clone(), &now, token.clone()).await
                {
                    Ok(completed) => hold_retirement(
                        binding.0.clone(),
                        binding.1.clone(),
                        coordinator.clone(),
                        completed,
                        &now,
                        token.clone(),
                    )
                    .map(|()| ReextractOutcome::Done),
                    Err(error) => fail(binding, coordinator, &token, stop, error).await,
                };
            }
            Ok(None) => {}
            Err(error) if error.to_string() == "Memory is in use" && !token.is_cancelled() => {
                tracing::warn!(%error, "Memory re-extraction is waiting for its lease");
                sleep(&token, 5).await?;
            }
            Err(error) => return fail(binding, coordinator, &token, stop, error).await,
        }
    }
}

async fn load_receipt(
    root: PathBuf,
    paths: CognitionPathEnvironment,
    id: String,
) -> io::Result<ResetResult> {
    tokio::task::spawn_blocking(move || {
        receipt(&root, &paths, &id)?.ok_or_else(|| io::Error::other("Reset receipt is missing"))
    })
    .await
    .map_err(io::Error::other)?
}

/// Time left before the held generation may be reclaimed; `None` without a hold.
fn retirement_delay(at: Option<&str>, now: &Clock) -> io::Result<Option<Duration>> {
    let Some(at) = at else {
        return Ok(None);
    };
    let at = chrono::DateTime::parse_from_rfc3339(at).map_err(io::Error::other)?;
    let now = chrono::DateTime::parse_from_rfc3339(&now()).map_err(io::Error::other)?;
    Ok(Some((at - now).to_std().unwrap_or(Duration::ZERO)))
}

/// Reclaims a due hold now, or schedules one in-process timer for its end.
fn hold_retirement(
    root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    result: ResetResult,
    now: &Clock,
    token: CancellationToken,
) -> io::Result<()> {
    if !result.removal_pending {
        return Ok(());
    }
    match retirement_delay(result.retire_after.as_deref(), now)? {
        None => {}
        Some(delay) if delay.is_zero() => {
            retirement::retire(root, paths, coordinator, result, token);
        }
        Some(delay) => schedule_retirement(root, paths, coordinator, result, delay, token),
    }
    Ok(())
}

/// Service stop cancels the timer; the next startup pass is the backstop. The
/// receipt is reread on waking so a hold another path settled is left alone.
fn schedule_retirement(
    root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    result: ResetResult,
    delay: Duration,
    token: CancellationToken,
) {
    tokio::spawn(async move {
        tokio::select! {
            () = token.cancelled() => return,
            () = tokio::time::sleep(delay) => {}
        }
        if let Ok(current) = load_receipt(root.clone(), paths.clone(), result.operation_id).await
            && current.phase == "complete"
            && current.removal_pending
        {
            retirement::retire(root, paths, coordinator, current, token);
        }
    });
}

async fn stage(
    binding: &Binding,
    coordinator: &Arc<CognitionWriteCoordinator>,
    token: &CancellationToken,
) -> io::Result<()> {
    let read = binding.clone();
    let building = tokio::task::spawn_blocking(move || {
        let path = generation(&read).join("manifest.json");
        crate::coordination::ensure_data_authority(&read.0, &[&path])?;
        match fs::read(path) {
            Ok(bytes) => Ok(serde_json::from_slice::<Value>(&bytes)
                .map_err(io::Error::other)?
                .get("state")
                .is_some_and(|state| state == "building")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(io::Error::other)??;
    if building {
        return Ok(());
    }
    let lease = acquire(&binding.0, &binding.1, coordinator, "cutover", token).await?;
    let new = generation(binding);
    tokio::task::spawn_blocking(move || {
        crate::cognition::registration::retire_idle_graphs(&new.join("graph.sqlite"));
        crate::cognition::lance_store::forget(&new.join("butler.lance"), "butler_memory");
    })
    .await
    .map_err(io::Error::other)?;
    let prepared = prepare(
        binding.0.clone(),
        binding.1.clone(),
        binding.2.clone(),
        token.clone(),
    )
    .await;
    let owned = binding.clone();
    tokio::task::spawn_blocking(move || {
        let result = prepared.and_then(|staged| {
            if staged.is_some() {
                rewrite_manifest(&generation(&owned), "building", true)?;
            }
            Ok(())
        });
        lease.release(false).map_err(io::Error::other)?;
        result
    })
    .await
    .map_err(io::Error::other)?
}

async fn drive(
    binding: &Binding,
    coordinator: &Arc<CognitionWriteCoordinator>,
    shadow: &MemorySyncConsumer,
    token: &CancellationToken,
) -> io::Result<Option<ReextractOutcome>> {
    check(token)?;
    let read = binding.clone();
    if tokio::task::spawn_blocking(move || active(&read))
        .await
        .map_err(io::Error::other)??
    {
        return Ok(Some(ReextractOutcome::Done));
    }
    stage(binding, coordinator, token).await?;
    // Provider failures retain the normal window retry policy, never failing the reset.
    match shadow.poll_once().await {
        Ok(MemorySyncPoll::Processed) => return Ok(None),
        Ok(MemorySyncPoll::Deferred) => {
            tracing::warn!("Memory re-extraction is deferred");
            sleep(token, 5).await?;
            return Ok(None);
        }
        Err(error) => {
            tracing::warn!(%error, "Memory re-extraction poll will retry");
            sleep(token, 5).await?;
            return Ok(None);
        }
        Ok(MemorySyncPoll::Idle) => {}
    }
    let read = binding.clone();
    let (total, done) =
        match tokio::task::spawn_blocking(move || progress(&read.0, &read.1, &read.2.operation_id))
            .await
            .map_err(io::Error::other)?
        {
            Ok(progress) => progress,
            Err(error) => {
                tracing::warn!(%error, "Memory re-extraction progress check will retry");
                sleep(token, 5).await?;
                return Ok(None);
            }
        };
    if done < total {
        sleep(token, 30).await?;
        return Ok(None);
    }
    cutover(binding, coordinator, shadow, token).await
}

async fn cutover(
    binding: &Binding,
    coordinator: &Arc<CognitionWriteCoordinator>,
    shadow: &MemorySyncConsumer,
    token: &CancellationToken,
) -> io::Result<Option<ReextractOutcome>> {
    let lease = acquire(&binding.0, &binding.1, coordinator, "cutover", token).await?;
    match shadow.rebuild_caught_up().await {
        Ok(true) => {}
        result => {
            lease.release(false).map_err(io::Error::other)?;
            if let Err(error) = result {
                tracing::warn!(%error, "Memory re-extraction catch-up check will retry");
            }
            sleep(token, 5).await?;
            return Ok(None);
        }
    }
    let owned = binding.clone();
    let cancellation = token.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        check(&cancellation)?;
        let (root, paths, result) = &owned;
        let db = graph(root, paths, &result.operation_id)?;
        let terminal: bool = db.query_row("SELECT NOT EXISTS(SELECT 1 FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE w.state IN ('pending','planned','running'))", [], |row| row.get(0)).map_err(io::Error::other)?;
        if !terminal {
            lease.release(false).map_err(io::Error::other)?;
            return Ok(None);
        }
        let old = resolve_active_generation(root, paths).map_err(io::Error::other)?;
        let serving = graph(root, paths, &old.generation_id)?;
        let matches = typed_rows(&serving)? == typed_rows(&db)?;
        drop(serving);
        drop(db);
        let new = generation(&owned);
        if !matches {
            lease.release(false).map_err(io::Error::other)?;
            fs::remove_file(new.join("manifest.json"))?;
            return Ok(Some(ReextractOutcome::Restage));
        }
        rewrite_manifest(&new, "active", false)?;
        commit(root, paths, lease, result, &old, &new, &cancellation)?;
        rewrite_manifest(&old.root, "retired", false)?;
        Ok::<_, io::Error>(Some(ReextractOutcome::Done))
    }).await.map_err(io::Error::other)??;
    if outcome.is_none() {
        sleep(token, 5).await?;
    }
    Ok(outcome)
}

async fn settle(
    mut binding: Binding,
    coordinator: Arc<CognitionWriteCoordinator>,
    now: &Clock,
    token: CancellationToken,
) -> io::Result<ResetResult> {
    let read = binding.clone();
    tokio::task::spawn_blocking(move || {
        let old = read
            .1
            .memory_root(&read.0)
            .join("generations")
            .join(&read.2.old_generation);
        if old.join("manifest.json").try_exists()? {
            rewrite_manifest(&old, "retired", false)?;
        }
        Ok::<_, io::Error>(())
    })
    .await
    .map_err(io::Error::other)??;
    if binding.2.retire_after.is_none() {
        let time = chrono::DateTime::parse_from_rfc3339(&now()).map_err(io::Error::other)?;
        binding.2.retire_after = Some(
            (time + chrono::Duration::days(7)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        );
    }
    binding.2.phase = "complete".into();
    binding.2.sequence += 1;
    binding.2.removal_pending = true;
    loop {
        match save_completion(binding.clone(), coordinator.clone(), token.clone()).await {
            Err(error) if error.to_string() == "Memory is in use" && !token.is_cancelled() => {
                tracing::warn!(%error, "Memory re-extraction settlement is waiting for its lease");
                sleep(&token, 5).await?;
            }
            result => return result.map(|()| binding.2),
        }
    }
}

async fn fail(
    binding: Binding,
    coordinator: Arc<CognitionWriteCoordinator>,
    token: &CancellationToken,
    stop: CancellationToken,
    error: io::Error,
) -> io::Result<ReextractOutcome> {
    // A stop or a committed pointer leaves settlement resumable; never delete live memory.
    if token.is_cancelled() || stop.is_cancelled() {
        return Err(error);
    }
    let owned = binding.clone();
    let token = token.clone();
    let committed = tokio::task::spawn_blocking(move || {
        if active(&owned)? {
            return Ok(true);
        }
        let new = generation(&owned);
        if new.try_exists()? {
            crate::cognition::registration::retire_idle_graphs(&new.join("graph.sqlite"));
            crate::cognition::lance_store::forget(&new.join("butler.lance"), "butler_memory");
            retirement::remove_tree(&owned.0, &new, &token)?;
        }
        Ok::<_, io::Error>(false)
    })
    .await
    .map_err(io::Error::other)??;
    if !committed {
        let (root, paths, mut result) = binding;
        result.phase = "failed".into();
        result.sequence += 1;
        save_leased(root, paths, coordinator, result, stop).await?;
    }
    Err(error)
}

fn generation(binding: &Binding) -> PathBuf {
    binding
        .1
        .memory_root(&binding.0)
        .join("generations")
        .join(&binding.2.operation_id)
}

fn active(binding: &Binding) -> io::Result<bool> {
    resolve_active_generation(&binding.0, &binding.1)
        .map(|handle| handle.generation_id == binding.2.operation_id)
        .map_err(io::Error::other)
}

fn graph(
    root: &Path,
    paths: &CognitionPathEnvironment,
    id: &str,
) -> io::Result<butler_platform::sqlite::Connection> {
    validate(root, paths, id)?;
    let path = paths
        .memory_root(root)
        .join("generations")
        .join(id)
        .join("graph.sqlite");
    crate::coordination::ensure_data_authority(root, &[&path])?;
    butler_platform::sqlite::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(io::Error::other)
}

fn typed_rows(db: &rusqlite::Connection) -> io::Result<Vec<(String, String)>> {
    let mut query = db.prepare("SELECT s.source_id, c.status FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id = s.episode_id WHERE s.source_kind <> 'conversation' ORDER BY 1").map_err(io::Error::other)?;
    query
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)
}

fn rewrite_manifest(root: &Path, state: &str, version: bool) -> io::Result<()> {
    let path = root.join("manifest.json");
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(&path)?).map_err(io::Error::other)?;
    if manifest.get("state") == Some(&json!(state)) && !version {
        return Ok(());
    }
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| io::Error::other("Generation manifest is unavailable"))?;
    object.insert("state".into(), json!(state));
    if version {
        object.insert(
            "extraction_rules_version".into(),
            json!(MEMORY_EXTRACTION_RULES_VERSION),
        );
    }
    write_json(&path, &manifest)
}

async fn sleep(token: &CancellationToken, seconds: u64) -> io::Result<()> {
    tokio::select! {
        () = token.cancelled() => check(token),
        () = tokio::time::sleep(Duration::from_secs(seconds)) => Ok(()),
    }
}
