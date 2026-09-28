//! Watches the user module folder (the workspace's `notify` watcher, as the
//! transcript projection uses) and reports which modules changed: once per
//! burst, because an agent or editor writes a module as several files. A
//! burst ends after [`QUIET`] without changes; steady changes still report
//! at least every [`LONGEST`].

use std::{
    future::Future,
    path::{Component, Path},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::{
    sync::mpsc::{UnboundedReceiver, unbounded_channel},
    task::JoinHandle,
    time::{Instant, timeout_at},
};

use super::user::is_folder_name;
use crate::gateway::GatewayApplicationError;

pub(crate) const QUIET: Duration = Duration::from_millis(250);
pub(crate) const LONGEST: Duration = Duration::from_secs(2);

/// Receives the sorted ids (folder names) of the modules that changed.
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
    let (sender, receiver) = unbounded_channel();
    let watched = root.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        for path in event.map(|event| event.paths).unwrap_or_default() {
            if let Some(id) = folder(&watched, &path) {
                let _ = sender.send(id);
            }
        }
    })
    .map_err(GatewayApplicationError::internal_from)?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(GatewayApplicationError::internal_from)?;
    Ok(ModuleWatcher {
        _watcher: watcher,
        task: tokio::spawn(debounce(receiver, changed)),
    })
}

/// Collects ids into bursts and reports each burst once.
pub(crate) async fn debounce(mut receiver: UnboundedReceiver<String>, changed: ModulesChanged) {
    while let Some(first) = receiver.recv().await {
        let mut ids = std::collections::BTreeSet::from([first]);
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
        changed(ids.into_iter().collect()).await;
        if !open {
            return;
        }
    }
}

/// The module folder a changed path lies in.
pub(crate) fn folder(root: &Path, path: &Path) -> Option<String> {
    match path.strip_prefix(root).ok()?.components().next()? {
        Component::Normal(name) => name
            .to_str()
            .filter(|name| is_folder_name(name))
            .map(str::to_owned),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
