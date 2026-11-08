use super::{events::Decoder, transport::Body};
use crate::{Error, ShellClient};
use futures_core::Stream;
use reqwest::Method;
use serde_json::Value;
use std::{collections::VecDeque, pin::Pin, time::Duration};

/// Pull-driven log records; dropping the stream closes its socket and reconnect wait.
pub type LiveLogs = Pin<Box<dyn Stream<Item = Result<Value, Error>> + Send>>;

impl ShellClient {
    /// GET /logs/live. Reconnects without a cursor or replay; skips heartbeats.
    pub fn live_logs(&self) -> LiveLogs {
        let state = State {
            client: self.clone(),
            response: None,
            decoder: Decoder::default(),
            ready: VecDeque::new(),
            backoff: Duration::ZERO,
            stopped: false,
        };
        Box::pin(futures_util::stream::unfold(
            state,
            |mut state| async move {
                if state.stopped {
                    return None;
                }
                let record = state.next().await;
                if record.is_err() {
                    state.stopped = true;
                }
                Some((record, state))
            },
        ))
    }
}
struct State {
    client: ShellClient,
    response: Option<reqwest::Response>,
    decoder: Decoder,
    ready: VecDeque<Value>,
    backoff: Duration,
    stopped: bool,
}
impl State {
    async fn next(&mut self) -> Result<Value, Error> {
        loop {
            if let Some(record) = self.ready.pop_front() {
                self.backoff = Duration::from_millis(100);
                return Ok(record);
            }
            if self.response.is_none() {
                tokio::time::sleep(self.backoff).await;
                self.backoff =
                    (self.backoff * 2).clamp(Duration::from_millis(100), Duration::from_secs(5));
                let url = self.client.url(&["logs", "live"], &[])?;
                match self
                    .client
                    .request(Method::GET, url, &Body::None, true, None)
                    .await
                {
                    Ok(response) => self.response = Some(response),
                    Err(error) if error.kind() == crate::FailureKind::Retryable => continue,
                    Err(error) => return Err(error),
                }
            }
            let Some(response) = self.response.as_mut() else {
                return Err(Error::Connection);
            };
            match response.chunk().await {
                Ok(Some(bytes)) => self.ready.extend(self.decoder.push(&bytes)?),
                result => {
                    self.response = None;
                    self.decoder = Decoder::default();
                    if result.is_err() && !self.client.instance_alive().await {
                        return Err(Error::Connection);
                    }
                }
            }
        }
    }
}
