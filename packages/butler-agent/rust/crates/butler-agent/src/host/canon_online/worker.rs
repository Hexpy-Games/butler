//! One linked space: flush the queue, pull the stream, then hold the socket.
//! No timers while idle besides the socket ping; every wait also ends on
//! cancellation (return) or a wake (next pass).
mod stream;
use super::*;
use std::time::{Duration, Instant};

use butler_canon::store::Context;
use futures_util::{SinkExt, StreamExt};
use reqwest::Method;
use serde_json::Map;
use tokio_tungstenite::tungstenite::Message;

const MAX_BACKOFF: Duration = Duration::from_secs(300);
const PING: Duration = Duration::from_secs(50);
const SILENT: Duration = Duration::from_secs(120);

/// How one step ended; anything but `Done` leaves the connected loop.
#[derive(Clone, Copy)]
enum Outcome {
    Done,
    Reconnect,
    SignedOut,
    Detached,
    Stopped,
    Wake,
    Cancelled,
}
/// What the worker does after a pass.
enum Next {
    Exit,
    Stopped,
    Retry,
    Wake,
    Idle,
}
enum Pause {
    Elapsed,
    Wake,
    Cancelled,
}

struct Worker {
    online: Arc<CanonOnline>,
    space: String,
    path: String,
    cancel: CancellationToken,
    wake: watch::Receiver<u64>,
    changes: watch::Receiver<()>,
    backoff: Duration,
    /// A token the server refused; never retried on its own.
    dead: Option<String>,
    /// Set while the signed-in account differs from the link's; warns once.
    mismatched: bool,
}
/// Read once per pass; the token goes to every call of the pass.
struct Pass {
    token: String,
    account: String,
    actor: Value,
    members: Map<String, Value>,
}

pub(super) async fn run(
    online: Arc<CanonOnline>,
    space: String,
    cancel: CancellationToken,
    errored: Arc<Mutex<HashSet<String>>>,
) {
    let mut worker = Worker {
        path: path(&space),
        wake: online.wake.subscribe(),
        changes: online.storage.subscribe_changes(),
        online,
        space,
        cancel,
        backoff: Duration::from_secs(1),
        dead: None,
        mismatched: false,
    };
    loop {
        match worker.pass().await {
            Next::Exit => {
                worker.state("offline");
                return;
            }
            Next::Stopped => {
                worker.state("error");
                errored.lock().insert(worker.space.clone());
                return;
            }
            Next::Wake => worker.state("offline"),
            Next::Idle => {
                if !worker.idle().await {
                    return;
                }
            }
            Next::Retry => {
                worker.state("offline");
                match worker.pause(worker.backoff).await {
                    Pause::Cancelled => return,
                    Pause::Wake => {}
                    Pause::Elapsed => worker.backoff = (worker.backoff * 2).min(MAX_BACKOFF),
                }
            }
        }
    }
}

impl Worker {
    fn state(&self, state: &'static str) {
        self.online.connect_state(&self.space, state);
    }
    fn me(pass: &Pass) -> Context {
        Context {
            now: chrono::Utc::now().timestamp_millis(),
            actor: pass.actor.clone(),
        }
    }
    async fn pause(&mut self, duration: Duration) -> Pause {
        tokio::select! {
            () = self.cancel.cancelled() => Pause::Cancelled,
            changed = self.wake.changed() => if changed.is_err() { Pause::Cancelled } else { Pause::Wake },
            () = tokio::time::sleep(duration) => Pause::Elapsed,
        }
    }
    /// Signed out or another account: wait for a wake or any BTCC change.
    async fn idle(&mut self) -> bool {
        tokio::select! {
            () = self.cancel.cancelled() => false,
            changed = self.wake.changed() => changed.is_ok(),
            changed = self.changes.changed() => changed.is_ok(),
        }
    }
    async fn link(&self) -> Result<Option<Value>, Outcome> {
        let space = self.space.clone();
        self.online
            .storage
            .canon_read(move |db| sync_link_by_space(db, &space))
            .await
            .map_err(|_| Outcome::Reconnect)
    }
    async fn detach(&self) {
        let space = self.space.clone();
        let result = self
            .online
            .storage
            .canon_write(move |tx| sync_set_state(tx, &space, "detached"))
            .await;
        if let Err(error) = result {
            tracing::warn!(%error, "Canon online link could not be detached");
        }
    }
    fn after(&mut self, outcome: Outcome, pass: Pass) -> Next {
        match outcome {
            Outcome::Done | Outcome::Reconnect => Next::Retry,
            Outcome::SignedOut => {
                self.dead = Some(pass.token);
                self.state("offline");
                Next::Idle
            }
            Outcome::Detached | Outcome::Cancelled => Next::Exit,
            Outcome::Stopped => Next::Stopped,
            Outcome::Wake => Next::Wake,
        }
    }

    async fn pass(&mut self) -> Next {
        let link = match self.link().await {
            Ok(Some(link)) if link["state"] == "linked" => link,
            Ok(_) => return Next::Exit,
            Err(_) => return Next::Retry,
        };
        let id = match self.online.account.identity().await {
            Ok(Some(id)) if self.dead.as_deref() != Some(id.token.as_str()) => id,
            Ok(_) => {
                self.state("offline");
                return Next::Idle;
            }
            Err(_) => return Next::Retry,
        };
        let mismatched = link["account_id"] != id.account_id.as_str();
        if mismatched && !self.mismatched {
            tracing::warn!("signed-in account differs from the link's account");
        }
        self.mismatched = mismatched;
        if mismatched {
            self.state("error");
            return Next::Idle;
        }
        let mut pass = Pass {
            actor: json!({"via": "sync", "account": id.account_id, "device": id.device_id}),
            token: id.token,
            account: id.account_id,
            members: Map::new(),
        };
        match self.online.account.email(&pass.token).await {
            Ok(email) => pass.actor["person"] = json!(email),
            Err(GatewayApplicationError::Public { status: 401, .. }) => {
                return self.after(Outcome::SignedOut, pass);
            }
            Err(_) => return Next::Retry,
        }
        let outcome = self.start(&mut pass, &link).await;
        self.after(outcome, pass)
    }

    /// Members, resync, role, socket; then the connected loop.
    async fn start(&mut self, pass: &mut Pass, link: &Value) -> Outcome {
        let members = match self.members(pass).await {
            Ok(members) => members,
            Err(outcome) => return outcome,
        };
        pass.members = email_map(&members);
        let outcome = self.ensure_resync(pass).await;
        if !matches!(outcome, Outcome::Done) {
            return outcome;
        }
        let own = members["members"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|member| member["account_id"] == pass.account.as_str());
        let Some(role) = own
            .and_then(|member| member["role"].as_str())
            .map(str::to_owned)
        else {
            self.detach().await;
            return Outcome::Detached;
        };
        if link["role"] != role.as_str() {
            let space = self.space.clone();
            let saved = self
                .online
                .storage
                .canon_write(move |tx| sync_set_role(tx, &space, &role))
                .await;
            if saved.is_err() {
                return Outcome::Reconnect;
            }
        }
        let base = self.online.account.base_url().to_owned();
        let socket = match socket::connect(&base, &self.path, &pass.token).await {
            Ok(socket) => socket,
            Err(socket::ConnectError::Status(404)) => {
                self.detach().await;
                return Outcome::Detached;
            }
            Err(socket::ConnectError::Status(401)) => return Outcome::SignedOut,
            Err(_) => return Outcome::Reconnect,
        };
        self.state("connected");
        self.connected(pass, socket).await
    }

    async fn connected(&mut self, pass: &mut Pass, mut socket: socket::Socket) -> Outcome {
        let mut outcome = self.flush(pass).await;
        if matches!(outcome, Outcome::Done) {
            outcome = self.pull(pass).await;
        }
        if matches!(outcome, Outcome::Done) {
            outcome = self.flush_if_sendable(pass).await;
        }
        if matches!(outcome, Outcome::Done) {
            // The connection held through a full flush and pull.
            self.backoff = Duration::from_secs(1);
        }
        let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING, PING);
        let mut last_seen = Instant::now();
        while matches!(outcome, Outcome::Done) {
            tokio::select! {
                () = self.cancel.cancelled() => outcome = Outcome::Cancelled,
                frame = socket.stream.next() => {
                    last_seen = Instant::now();
                    match frame {
                        Some(Ok(Message::Text(text))) => outcome = self.frame(pass, text.as_str()).await,
                        Some(Ok(Message::Close(close))) => {
                            if close.is_some_and(|close| matches!(u16::from(close.code), 4003 | 4004)) {
                                self.detach().await;
                                outcome = Outcome::Detached;
                            }
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => break,
                    }
                }
                _ = ping.tick() => {
                    if last_seen.elapsed() > SILENT
                        || socket.stream.send(Message::Ping(Default::default())).await.is_err()
                    {
                        break;
                    }
                }
                changed = self.changes.changed() => {
                    outcome = if changed.is_err() { Outcome::Cancelled } else { self.debounced(pass).await };
                }
                _ = self.wake.changed() => outcome = Outcome::Wake,
            }
        }
        socket.finish(Ok(()));
        outcome
    }
    async fn debounced(&mut self, pass: &mut Pass) -> Outcome {
        match self.pause(Duration::from_millis(300)).await {
            Pause::Cancelled => Outcome::Cancelled,
            Pause::Wake => Outcome::Wake,
            Pause::Elapsed => {
                self.changes.borrow_and_update();
                self.flush_if_sendable(pass).await
            }
        }
    }
    async fn frame(&mut self, pass: &mut Pass, text: &str) -> Outcome {
        let frame: Value = serde_json::from_str(text).unwrap_or(Value::Null);
        if frame["type"] != "ops" {
            return Outcome::Done;
        }
        let ops = frame["ops"].as_array().cloned().unwrap_or_default();
        let outcome = match self.apply(pass, ops).await {
            Ok(applied) if applied.gap => self.pull(pass).await,
            Ok(_) => Outcome::Done,
            Err(outcome) => outcome,
        };
        if !matches!(outcome, Outcome::Done) {
            return outcome;
        }
        self.flush_if_sendable(pass).await
    }
}

fn email_map(members: &Value) -> Map<String, Value> {
    members["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| Some((m["account_id"].as_str()?.to_owned(), m["email"].clone())))
        .collect()
}
fn retry_after(seconds: Option<u64>) -> Duration {
    Duration::from_secs(seconds.unwrap_or(60)).min(MAX_BACKOFF)
}
