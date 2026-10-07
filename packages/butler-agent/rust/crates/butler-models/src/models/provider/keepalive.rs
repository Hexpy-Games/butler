//! Ephemeral cache maintenance, owned by the last real parent request.
mod ping;

use super::{ModelProvider, ProviderRequestConfig, prefix_diagnostics::Prepared};
use butler_turn::btcc::ModelRoundRequest;
use parking_lot::Mutex;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_SESSIONS: usize = 128;

struct Settings {
    interval: Duration,
    cap: Duration,
}
impl Settings {
    fn environment() -> Option<Self> {
        if std::env::var("BUTLER_PROMPT_CACHE_KEEPALIVE").is_ok_and(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "off" | "0" | "false" | "no"
            )
        }) {
            return None;
        }
        let seconds = |key, default| {
            std::env::var(key)
                .ok()
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 86400.0)
                .unwrap_or(default)
        };
        let interval = seconds("BUTLER_PROMPT_CACHE_KEEPALIVE_INTERVAL_SECONDS", 240.0).max(30.0);
        let cap = seconds("BUTLER_PROMPT_CACHE_KEEPALIVE_CAP_SECONDS", 2700.0).max(interval);
        Some(Self {
            interval: Duration::from_secs_f64(interval),
            cap: Duration::from_secs_f64(cap),
        })
    }
}

struct Snapshot {
    body: Value,
    prefix: Prepared,
    config: Arc<ProviderRequestConfig>,
    http: reqwest::RequestBuilder,
    catalog: Arc<crate::models::ModelCatalog>,
    metrics: Arc<dyn crate::models::PromptUsageMetricSink>,
    clock: Arc<dyn super::ProviderClock>,
    scope: String,
    turn: String,
    data: Option<String>,
    bytes: usize,
}
struct Entry {
    snapshot: Option<Snapshot>,
    turn: String,
    bytes: usize,
    last_real: Instant,
    stop: CancellationToken,
    running: bool,
}
#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    bytes: usize,
    closed: bool,
}
#[derive(Default)]
pub(super) struct Keepalive(Mutex<State>);

impl Keepalive {
    pub(super) fn requested(&self, scope: Option<&str>, turn: Option<&str>) {
        if let Some(scope) = scope
            && let Some(entry) = self.0.lock().entries.get_mut(scope)
            && Some(entry.turn.as_str()) == turn
        {
            entry.last_real = Instant::now();
        }
    }
    pub(super) fn stop_scope(&self, scope: Option<&str>) {
        if let Some(scope) = scope {
            remove(&mut self.0.lock(), scope);
        }
    }
    pub(super) fn stop_turn(&self, turn: &str) {
        let mut state = self.0.lock();
        let scopes: Vec<_> = state
            .entries
            .iter()
            .filter(|(_, e)| e.turn == turn)
            .map(|(s, _)| s.clone())
            .collect();
        for scope in scopes {
            remove(&mut state, &scope);
        }
    }
    pub(super) fn close(&self) {
        let mut state = self.0.lock();
        state.closed = true;
        for (_, entry) in state.entries.drain() {
            entry.stop.cancel();
        }
        state.bytes = 0;
    }
    fn remember(&self, snapshot: Snapshot) {
        let mut state = self.0.lock();
        remove(&mut state, &snapshot.scope);
        if state.closed
            || state.entries.len() >= MAX_SESSIONS
            || state.bytes + snapshot.bytes > MAX_BYTES
        {
            return;
        }
        state.bytes += snapshot.bytes;
        state.entries.insert(
            snapshot.scope.clone(),
            Entry {
                turn: snapshot.turn.clone(),
                bytes: snapshot.bytes,
                snapshot: Some(snapshot),
                last_real: Instant::now(),
                stop: CancellationToken::new(),
                running: false,
            },
        );
    }
    pub(super) fn start(self: &Arc<Self>, session: &str, turn: &str) {
        let Some(settings) = Settings::environment() else {
            self.stop_turn(turn);
            return;
        };
        let scope = format!("btcc-guided:{session}");
        let mut state = self.0.lock();
        let Some(entry) = state.entries.get_mut(&scope) else {
            return;
        };
        if entry.turn != turn || entry.running {
            return;
        }
        let Some(snapshot) = entry.snapshot.take() else {
            return;
        };
        entry.running = true;
        let last_real = entry.last_real;
        let stop = entry.stop.clone();
        let owner = Arc::downgrade(self);
        tokio::spawn(async move {
            let result = maintain(&snapshot, &settings, last_real, stop.clone()).await;
            if let Err(error) = result {
                eprintln!(
                    "prompt cache keepalive failed; session={} reason={}; stopped for this wait",
                    scope.strip_prefix("btcc-guided:").unwrap_or(&scope),
                    failure_reason(&error),
                );
            }
            if let Some(owner) = owner.upgrade() {
                let mut state = owner.0.lock();
                if state
                    .entries
                    .get(&scope)
                    .is_some_and(|e| e.last_real == last_real)
                {
                    remove(&mut state, &scope);
                }
            }
        });
    }
}
fn remove(state: &mut State, scope: &str) {
    if let Some(entry) = state.entries.remove(scope) {
        entry.stop.cancel();
        state.bytes -= entry.bytes;
    }
}
async fn maintain(
    snapshot: &Snapshot,
    settings: &Settings,
    last_real: Instant,
    stop: CancellationToken,
) -> Result<(), butler_turn::btcc::ModelRoundError> {
    let deadline = Instant::now() + settings.cap;
    let mut next = (last_real + settings.interval).max(Instant::now());
    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => return Ok(()),
            () = tokio::time::sleep_until(deadline) => return Ok(()),
            () = tokio::time::sleep_until(next) => {},
        }
        let ping_stop = stop.child_token();
        let send = ping::send(snapshot, ping_stop.clone(), last_real);
        tokio::pin!(send);
        let result = tokio::select! {
            biased;
            () = stop.cancelled() => { ping_stop.cancel(); send.await },
            () = tokio::time::sleep_until(deadline) => { ping_stop.cancel(); send.await },
            result = &mut send => result,
        };
        if stop.is_cancelled() || Instant::now() >= deadline {
            return Ok(());
        }
        result?;
        next = Instant::now() + settings.interval;
    }
}
impl ModelProvider {
    /// Incoming inputs and worker results invalidate a wait before queue dispatch.
    pub fn stop_session_cache_wait(&self, session: &str) {
        self.keepalive
            .stop_scope(Some(&format!("btcc-guided:{session}")));
    }
    pub(super) fn remember_cache_request(
        &self,
        request: &ModelRoundRequest<'_>,
        config: &Arc<ProviderRequestConfig>,
        body: Value,
        prefix: &Prepared,
        http: &reqwest::RequestBuilder,
    ) {
        if Settings::environment().is_none()
            || config.metadata.provider_id != "openai"
            || config.auth.mode() == super::ProviderAuthMode::None
            || body.get("prompt_cache_retention").and_then(Value::as_str) == Some("24h")
            || !request.tools.iter().any(|tool| {
                matches!(
                    tool.name.as_str(),
                    "delegate_to_steward" | "delegate_to_worker" | "wait_for_worker"
                )
            })
        {
            return;
        }
        let Some((scope, turn)) = request
            .cache_scope
            .zip(request.usage_attribution.map(|a| a.turn_id.as_str()))
        else {
            return;
        };
        let Some(http) = http.try_clone() else {
            return;
        };
        let Some(bytes) = http
            .try_clone()
            .and_then(|h| h.build().ok())
            .and_then(|r| r.body().and_then(|b| b.as_bytes()).map(<[u8]>::len))
        else {
            return;
        };
        self.keepalive.remember(Snapshot {
            body,
            prefix: prefix.clone(),
            config: config.clone(),
            http,
            catalog: self.catalog.clone(),
            metrics: self.prompt_metrics.clone(),
            clock: self.clock.clone(),
            scope: scope.into(),
            turn: turn.into(),
            data: request.butler_data.map(str::to_owned),
            bytes: bytes.saturating_mul(4),
        });
    }
}
impl Drop for Keepalive {
    fn drop(&mut self) {
        self.close();
    }
}

// Fixed classifications only: provider messages may contain request content.
fn failure_reason(error: &butler_turn::btcc::ModelRoundError) -> &'static str {
    use butler_turn::btcc::ModelRoundError;
    match error {
        ModelRoundError::Provider(error) => match error.status_code {
            Some(400..=499) => "provider_client_error",
            Some(500..=599) => "provider_server_error",
            _ => "provider_transport_error",
        },
        ModelRoundError::StablePrefix(_) => "prefix_or_metric_failure",
        ModelRoundError::Cancelled => "cancelled",
        _ => "request_failed",
    }
}
