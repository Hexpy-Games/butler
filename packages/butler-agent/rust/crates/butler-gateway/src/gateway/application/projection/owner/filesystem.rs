//! Change notifications for transcripts, settlement and durable handoff ownership.
use super::{Command, Pending, ProjectionContext};
use crate::gateway::GatewayApplicationError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::mpsc;

struct Roots {
    transcripts: PathBuf,
    processed: PathBuf,
    failed: PathBuf,
    handoffs: PathBuf,
}

pub(super) fn watch(
    context: &ProjectionContext,
    pending: &Arc<Mutex<Pending>>,
    sender: &mpsc::Sender<Command>,
) -> Result<RecommendedWatcher, GatewayApplicationError> {
    // Match canonical roots: native events may report resolved data paths.
    let root = |relative: &str| {
        let path = context.butler_data.join(relative);
        std::fs::create_dir_all(&path)
            .and_then(|()| butler_platform::secure_fs::canonicalize(path))
            .map_err(GatewayApplicationError::internal_from)
    };
    let roots = Roots {
        transcripts: root("transcripts")?,
        processed: root("runtime/inbound-events/processed")?,
        failed: root("runtime/inbound-events/failed")?,
        handoffs: root(butler_platform::data_paths::MESSAGE_HANDOFFS)?,
    };
    let watched = [
        roots.transcripts.clone(),
        roots.processed.clone(),
        roots.failed.clone(),
    ];
    let handoffs = roots.handoffs.clone();
    let pending = pending.clone();
    let sender = sender.clone();
    let observe = super::notifications::observe_filesystem();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event
            && observe
            && !matches!(event.kind, notify::EventKind::Access(_))
        {
            changed(event, &roots, &pending, &sender);
        }
    })
    .map_err(GatewayApplicationError::internal_from)?;
    for path in watched {
        watcher
            .watch(&path, RecursiveMode::NonRecursive)
            .map_err(GatewayApplicationError::internal_from)?;
    }
    watcher
        .watch(&handoffs, RecursiveMode::Recursive)
        .map_err(GatewayApplicationError::internal_from)?;
    Ok(watcher)
}

fn changed(
    event: notify::Event,
    roots: &Roots,
    pending: &Arc<Mutex<Pending>>,
    sender: &mpsc::Sender<Command>,
) {
    for path in event.paths {
        if let Ok(relative) = path.strip_prefix(&roots.handoffs)
            && let Some(name) = relative.components().next()
        {
            let mut pending = pending.lock();
            pending.handoff_paths.insert(roots.handoffs.join(name));
            pending.handoffs = true;
            let _ = sender.try_send(Command::Events);
        } else if path.parent() == Some(roots.transcripts.as_path()) {
            if path.extension().is_some_and(|value| value == "jsonl")
                && let Some(file) = path.file_name().and_then(|v| v.to_str())
            {
                super::notifications::transcript(pending, sender, file.to_owned());
            }
        } else if path.extension().is_none_or(|value| value != "tmp")
            && (path == roots.processed
                || path == roots.failed
                || path.parent() == Some(roots.processed.as_path())
                || path.parent() == Some(roots.failed.as_path()))
        {
            pending.lock().terminal = true;
            let _ = sender.try_send(Command::Events);
        }
    }
}
