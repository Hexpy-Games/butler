//! Watches the user module folder (the workspace's `notify` watcher, as the
//! transcript projection uses) and reports which modules changed: once per
//! burst, because an agent or editor writes a module as several files. A
//! burst ends after [`QUIET`] without changes; steady changes still report
//! at least every [`LONGEST`]. Links are not followed, so a link to a large
//! tree cannot exhaust the watch limit, and at most [`PENDING`] changed ids
//! wait; past that the burst reports "everything changed" (no ids) instead.

use std::{
    collections::BTreeSet,
    future::Future,
    path::{Component, Path},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::{
    sync::mpsc::{Receiver, channel, error::TrySendError},
    task::JoinHandle,
    time::{Instant, timeout_at},
};

use super::user::is_folder_name;
use crate::gateway::GatewayApplicationError;

pub(crate) const QUIET: Duration = Duration::from_millis(250);
pub(crate) const LONGEST: Duration = Duration::from_secs(2);
/// Changed ids that may wait for the debouncer.
const PENDING: usize = 256;

/// Receives the sorted ids (folder names) of the modules that changed; none
/// means any module may have changed.
pub(crate) type ModulesChanged =
    Arc<dyn Fn(Vec<String>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// A running watch; dropping it stops the watcher and the reports.
pub(crate) struct ModuleWatcher {
    _watcher: RecommendedWatcher,
    task: JoinHandle<()>,
}

impl Drop for ModuleWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Watches `root` (created when missing) until the watcher is dropped.
pub(crate) fn watch(
    root: &Path,
    changed: ModulesChanged,
) -> Result<ModuleWatcher, GatewayApplicationError> {
    // FSEvents reports resolved paths, so match against the canonical root.
    let root = std::fs::create_dir_all(root)
        .and_then(|()| std::fs::canonicalize(root))
        .map_err(GatewayApplicationError::internal_from)?;
    let (sender, receiver) = channel(PENDING);
    let overflow = Arc::new(AtomicBool::new(false));
    let dropped = Arc::clone(&overflow);
    let watched = root.clone();
    let handler = move |event: notify::Result<notify::Event>| {
        for path in event.map(|event| event.paths).unwrap_or_default() {
            if let Some(id) = folder(&watched, &path)
                && let Err(TrySendError::Full(_)) = sender.try_send(id)
            {
                dropped.store(true, Ordering::Relaxed);
            }
        }
    };
    let config = Config::default().with_follow_symlinks(false);
    let mut watcher =
        RecommendedWatcher::new(handler, config).map_err(GatewayApplicationError::internal_from)?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(GatewayApplicationError::internal_from)?;
    Ok(ModuleWatcher {
        _watcher: watcher,
        task: tokio::spawn(debounce(receiver, overflow, changed)),
    })
}

/// Collects ids into bursts and reports each burst once; a burst that lost
/// ids to a full queue reports none (any module may have changed).
async fn debounce(
    mut receiver: Receiver<String>,
    overflow: Arc<AtomicBool>,
    changed: ModulesChanged,
) {
    while let Some(first) = receiver.recv().await {
        let mut ids = BTreeSet::from([first]);
        let deadline = Instant::now() + LONGEST;
        let open = loop {
            let quiet = (Instant::now() + QUIET).min(deadline);
            match timeout_at(quiet, receiver.recv()).await {
                Ok(Some(id)) => {
                    ids.insert(id);
                }
                Ok(None) => break false,
                Err(_) => break true,
            }
        };
        if overflow.swap(false, Ordering::Relaxed) {
            ids.clear();
        }
        changed(ids.into_iter().collect()).await;
        if !open {
            return;
        }
    }
}

/// The module folder a changed path lies in.
fn folder(root: &Path, path: &Path) -> Option<String> {
    match path.strip_prefix(root).ok()?.components().next()? {
        Component::Normal(name) => name
            .to_str()
            .filter(|name| is_folder_name(name))
            .map(str::to_owned),
        _ => None,
    }
}
