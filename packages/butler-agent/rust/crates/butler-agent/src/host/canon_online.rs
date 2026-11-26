//! Canon online: links local Canon projects to butler-cloud spaces and keeps
//! them in sync. One worker per linked space; idle is a held socket plus a ping.
mod requests;
mod socket;
mod worker;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use butler_canon::store::{
    sync_apply, sync_demote, sync_has_sendable, sync_join, sync_link, sync_link_by_project,
    sync_link_by_space, sync_links, sync_mark_resync, sync_project_used, sync_record_results,
    sync_resync, sync_set_role, sync_set_state, sync_take_sendable, sync_unlink,
};
use butler_gateway::gateway::{CanonOnlineRequest, GatewayApplicationError};
use butler_turn::btcc::BtccStorage;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::host::app::runtime_ports::ButlerAccount;

pub(crate) struct CanonOnline {
    account: Arc<ButlerAccount>,
    storage: BtccStorage,
    /// space_id → "connected" | "offline" | "error"
    connections: Arc<Mutex<HashMap<String, &'static str>>>,
}

impl CanonOnline {
    pub(crate) fn start(
        account: Arc<ButlerAccount>,
        storage: BtccStorage,
        shutdown: CancellationToken,
    ) -> Arc<Self> {
        let online = Arc::new(Self {
            account,
            storage,
            connections: Arc::default(),
        });
        tokio::spawn(supervise(online.clone(), shutdown));
        online
    }

    pub(crate) async fn handle(
        &self,
        request: CanonOnlineRequest,
    ) -> Result<Value, GatewayApplicationError> {
        requests::handle(self, request).await
    }

    /// Every watcher sees each bump on its own next `changed()`.
    pub(crate) fn poke(&self) {
        self.account.bump();
    }

    fn connect_state(&self, space: &str, state: &'static str) {
        self.connections.lock().insert(space.to_owned(), state);
    }

    /// `{project_id, space_id, role, state, connection, pending}` for one link row.
    fn view(&self, link: &Value) -> Value {
        let space = link["space_id"].as_str().unwrap_or_default();
        let connection = if link["state"] == "linked" {
            self.connections
                .lock()
                .get(space)
                .copied()
                .unwrap_or("offline")
        } else {
            "offline"
        };
        json!({"project_id": link["project_id"], "space_id": space, "role": link["role"],
            "state": link["state"], "connection": connection, "pending": link["pending"]})
    }
}

/// One URL path segment, percent-encoded.
fn encode(value: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(value.as_bytes()).collect();
    encoded.replace('+', "%20")
}
/// The space's API path, `/spaces/{id}`.
fn path(space: &str) -> String {
    format!("/spaces/{}", encode(space))
}

type Running = HashMap<String, (CancellationToken, tokio::task::JoinHandle<()>)>;

/// Starts a worker per linked space; no timers. A worker that stopped on an
/// error is not restarted until the next wake or app start.
async fn supervise(online: Arc<CanonOnline>, shutdown: CancellationToken) {
    let mut wake = online.account.changes();
    let errored = Arc::new(Mutex::new(HashSet::new()));
    let mut running = Running::new();
    loop {
        match online.storage.canon_read(sync_links).await {
            Ok(links) => {
                let spaces: HashSet<String> = links
                    .iter()
                    .filter_map(|link| link["space_id"].as_str().map(str::to_owned))
                    .collect();
                running.retain(|space, (token, _)| {
                    let keep = spaces.contains(space);
                    if !keep {
                        token.cancel();
                    }
                    keep
                });
                for link in &links {
                    let Some(space) = link["space_id"].as_str() else {
                        continue;
                    };
                    if link["state"] != "linked"
                        || errored.lock().contains(space)
                        || running
                            .get(space)
                            .is_some_and(|(_, task)| !task.is_finished())
                    {
                        continue;
                    }
                    let token = shutdown.child_token();
                    let task = tokio::spawn(worker::run(
                        online.clone(),
                        space.to_owned(),
                        token.clone(),
                        errored.clone(),
                    ));
                    running.insert(space.to_owned(), (token, task));
                }
            }
            Err(error) => tracing::warn!(%error, "Canon online links could not be read"),
        }
        tokio::select! {
            () = shutdown.cancelled() => {
                for (token, _) in running.values() {
                    token.cancel();
                }
                return;
            }
            changed = wake.changed() => {
                if changed.is_err() {
                    return;
                }
                errored.lock().clear();
            }
        }
    }
}
