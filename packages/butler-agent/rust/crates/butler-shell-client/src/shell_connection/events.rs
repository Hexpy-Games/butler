use crate::{Error, EventKind, LiveEvent, ShellClient};
use futures_core::Stream;
use reqwest::Method;
use serde_json::Value;
use std::{collections::VecDeque, pin::Pin, time::Duration};

/// A pull-driven stream. Dropping it cancels reconnect waits and closes its socket.
pub type LiveEvents = Pin<Box<dyn Stream<Item = Result<LiveEvent, Error>> + Send>>;

impl ShellClient {
    /// Subscribe after a durable cursor. Reconnects with exponential backoff,
    /// suppresses replay duplicates, and pages /events on reconcile or a gap.
    /// A pruned durable gap is an explicit error, never silently skipped.
    /// Drafts have no cursor: only durable events have exactly-once replay.
    pub fn live_events(&self, cursor: u64) -> LiveEvents {
        let state = State {
            client: self.clone(),
            cursor,
            response: None,
            decoder: Decoder::default(),
            ready: VecDeque::new(),
            recovery: None,
            backoff: Duration::ZERO,
            stopped: false,
        };
        Box::pin(futures_util::stream::unfold(
            state,
            |mut state| async move {
                if state.stopped {
                    return None;
                }
                let event = state.next().await;
                if matches!(event, Err(Error::Protocol | Error::EventGap(_))) {
                    state.stopped = true;
                }
                Some((event, state))
            },
        ))
    }
}

struct State {
    client: ShellClient,
    cursor: u64,
    response: Option<reqwest::Response>,
    decoder: Decoder,
    ready: VecDeque<(Value, bool)>,
    recovery: Option<(u64, Option<Value>)>,
    backoff: Duration,
    stopped: bool,
}
impl State {
    async fn next(&mut self) -> Result<LiveEvent, Error> {
        loop {
            if let Some((raw, replayed)) = self.ready.pop_front() {
                if let Some(event) = self.accept(raw, replayed)? {
                    return Ok(event);
                }
                continue;
            }
            if let Some((target, _)) = &self.recovery {
                if let Err(error) = self.recover(*target).await {
                    if retryable(&error) {
                        continue;
                    }
                    self.stopped = true;
                    return Err(error);
                }
                continue;
            }
            if self.response.is_none()
                && let Err(error) = self.connect().await
            {
                if retryable(&error) {
                    continue;
                }
                self.stopped = true;
                return Err(error);
            }
            let chunk = match self.response.as_mut() {
                Some(response) => response.chunk().await,
                None => return Err(Error::Connection),
            };
            match chunk {
                Ok(Some(bytes)) => self.ready.extend(
                    self.decoder
                        .push(&bytes)?
                        .into_iter()
                        .map(|raw| (raw, false)),
                ),
                Ok(None) => self.disconnect(),
                Err(_) if self.client.instance_alive().await => {
                    self.disconnect();
                }
                Err(_) => {
                    self.disconnect();
                    self.stopped = true;
                    return Err(Error::Connection);
                }
            }
        }
    }
    async fn connect(&mut self) -> Result<(), Error> {
        tokio::time::sleep(self.backoff).await;
        self.backoff = (self.backoff * 2).clamp(Duration::from_millis(100), Duration::from_secs(5));
        let url = self
            .client
            .url(&["events", "live"], &[("cursor", self.cursor.to_string())])?;
        self.response = Some(self.client.request(Method::GET, url, None, true).await?);
        Ok(())
    }
    fn disconnect(&mut self) {
        self.response = None;
        self.decoder = Decoder::default();
    }
    fn accept(&mut self, raw: Value, replayed: bool) -> Result<Option<LiveEvent>, Error> {
        let name = raw
            .get("type")
            .and_then(Value::as_str)
            .ok_or(Error::Protocol)?;
        let id = raw.get("id").and_then(Value::as_u64).filter(|id| *id != 0);
        if name == "stream.reconcile_required" {
            let target = raw["payload"]["high_water_cursor"]
                .as_u64()
                .ok_or(Error::Protocol)?;
            self.recovery = Some((target, None));
            self.ready.clear();
            self.disconnect();
            return Ok(None);
        }
        if let Some(id) = id {
            if id <= self.cursor {
                return Ok(None);
            }
            if !replayed && id != self.cursor + 1 {
                self.recovery = Some((id, Some(raw)));
                self.ready.clear();
                self.disconnect();
                return Ok(None);
            }
            self.cursor = id;
        }
        self.backoff = Duration::from_millis(100);
        let kind = match name {
            "message.created" | "message.updated" => EventKind::Message,
            "turn.state_changed" => EventKind::TurnState,
            "security.connection_code_rotated" => EventKind::TokenRotated,
            _ => EventKind::Unknown(name.into()),
        };
        Ok(Some(LiveEvent {
            cursor: id,
            kind,
            raw,
        }))
    }
    async fn recover(&mut self, target: u64) -> Result<(), Error> {
        if self.cursor >= target {
            self.recovery = None;
            return Ok(());
        }
        let page = match self.client.replay_events(self.cursor, 200).await {
            Ok(page) => page,
            Err(error) => {
                tokio::time::sleep(self.backoff).await;
                self.backoff =
                    (self.backoff * 2).clamp(Duration::from_millis(100), Duration::from_secs(5));
                return Err(error);
            }
        };
        if page.events.is_empty() {
            // Only an explicit reconcile target which the server can no longer
            // replay requires a UI reload. Numeric holes alone mean nothing.
            if let Some((_, Some(raw))) = self.recovery.take() {
                self.ready.push_back((raw, true));
                return Ok(());
            }
            self.stopped = true;
            return Err(Error::EventGap(self.cursor));
        }
        // /events is authoritative: retained ids are ordered, not contiguous.
        // Tag replay rows so accepting them cannot trigger the same recovery.
        self.ready
            .extend(page.events.into_iter().map(|raw| (raw, true)));
        Ok(())
    }
}

#[derive(Default)]
struct Decoder {
    bytes: Vec<u8>,
    data: Vec<String>,
    heartbeat: bool,
}
impl Decoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, Error> {
        self.bytes.extend_from_slice(bytes);
        let mut output = Vec::new();
        let mut consumed = 0;
        for (index, byte) in self.bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            let line = std::str::from_utf8(&self.bytes[consumed..index])
                .map_err(|_| Error::Protocol)?
                .trim_end_matches('\r');
            consumed = index + 1;
            if line.is_empty() {
                if !self.data.is_empty() && !self.heartbeat {
                    output.push(
                        serde_json::from_str(&self.data.join("\n")).map_err(|_| Error::Protocol)?,
                    );
                }
                self.data.clear();
                self.heartbeat = false;
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).into());
            } else if line == "event: heartbeat" {
                self.heartbeat = true;
            }
        }
        self.bytes.drain(..consumed);
        Ok(output)
    }
}

fn retryable(error: &Error) -> bool {
    error.kind() == crate::FailureKind::Retryable
}
