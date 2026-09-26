//! Small adapter for the 2024 legacy HTTP+SSE transport. MCP messages and
//! request/session policy stay in rmcp; this only maps the endpoint event to
//! POSTs and message events back to rmcp's client transport.

use std::{collections::HashMap, future::Future};

use futures_util::StreamExt;
use http::{HeaderMap, HeaderName, HeaderValue, header};
use reqwest::Url;
use rmcp::{
    RoleClient,
    model::ServerJsonRpcMessage,
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::Transport,
};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

const CHANNEL_CAPACITY: usize = 64;

#[derive(Debug)]
pub(super) struct LegacySseError;

impl std::fmt::Display for LegacySseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("legacy MCP SSE transport failed")
    }
}

impl std::error::Error for LegacySseError {}

pub(super) struct LegacySseTransport {
    client: reqwest::Client,
    headers: HeaderMap,
    cancel: CancellationToken,
    endpoint: watch::Receiver<Option<Result<Url, ()>>>,
    incoming: mpsc::Receiver<RxJsonRpcMessage<RoleClient>>,
    source_task: Option<tokio::task::JoinHandle<()>>,
}

impl LegacySseTransport {
    pub(super) fn connect(
        client: reqwest::Client,
        source_url: Url,
        headers: HeaderMap,
        cancel: CancellationToken,
    ) -> Self {
        let (endpoint_tx, endpoint) = watch::channel(None);
        let (incoming_tx, incoming) = mpsc::channel(CHANNEL_CAPACITY);
        let task_cancel = cancel.clone();
        let task_client = client.clone();
        let task_headers = headers.clone();
        let source_task = tokio::spawn(async move {
            run_sse_source(
                task_client,
                source_url,
                task_headers,
                task_cancel,
                endpoint_tx,
                incoming_tx,
            )
            .await;
        });
        Self {
            client,
            headers,
            cancel,
            endpoint,
            incoming,
            source_task: Some(source_task),
        }
    }
}

impl Transport<RoleClient> for LegacySseTransport {
    type Error = LegacySseError;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let client = self.client.clone();
        let headers = self.headers.clone();
        let cancel = self.cancel.clone();
        let mut endpoint = self.endpoint.clone();
        async move {
            let body = serde_json::to_vec(&item).map_err(|_| LegacySseError)?;
            let target = loop {
                if let Some(value) = endpoint.borrow_and_update().clone() {
                    break value.map_err(|()| LegacySseError)?;
                }
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Err(LegacySseError),
                    changed = endpoint.changed() => changed.map_err(|_| LegacySseError)?,
                }
            };
            let request = client
                .post(target)
                .header(header::ACCEPT, "application/json, text/event-stream")
                .header(header::CONTENT_TYPE, "application/json")
                .headers(headers)
                .body(body);
            // reqwest requests are only cancelled here when the scoped session
            // closes; a completed POST is never retried by this adapter.
            let response = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(LegacySseError),
                result = request.send() => result.map_err(|_| LegacySseError)?,
            };
            if !response.status().is_success() {
                return Err(LegacySseError);
            }
            Ok(())
        }
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.incoming.recv()
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.cancel.cancel();
        async move {
            if let Some(task) = self.source_task.as_mut() {
                let _ = task.await;
            }
            self.source_task.take();
            Ok(())
        }
    }
}

impl Drop for LegacySseTransport {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.source_task.take() {
            task.abort();
        }
    }
}

async fn run_sse_source(
    client: reqwest::Client,
    source_url: Url,
    headers: HeaderMap,
    cancel: CancellationToken,
    endpoint: watch::Sender<Option<Result<Url, ()>>>,
    incoming: mpsc::Sender<RxJsonRpcMessage<RoleClient>>,
) {
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return,
        result = client
            .get(source_url.clone())
            .header(header::ACCEPT, "text/event-stream")
            .headers(headers)
            .send() => match result {
                Ok(response) if response.status().is_success() => response,
                _ => {
                    endpoint.send_replace(Some(Err(())));
                    return;
                }
            },
    };
    let mut bytes = response.bytes_stream();
    let mut parser = SseParser::default();
    loop {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            next = bytes.next() => next,
        };
        let Some(chunk) = next else {
            if endpoint.borrow().is_none() {
                endpoint.send_replace(Some(Err(())));
            }
            return;
        };
        let Ok(chunk) = chunk else {
            if endpoint.borrow().is_none() {
                endpoint.send_replace(Some(Err(())));
            }
            return;
        };
        let Ok(events) = parser.push(&chunk) else {
            if endpoint.borrow().is_none() {
                endpoint.send_replace(Some(Err(())));
            }
            return;
        };
        for event in events {
            if event.event == "endpoint" {
                let resolved = source_url
                    .join(event.data.trim())
                    .ok()
                    .filter(|endpoint| endpoint.origin() == source_url.origin())
                    .ok_or(());
                endpoint.send_replace(Some(resolved));
            } else if (event.event.is_empty() || event.event == "message")
                && let Ok(message) = serde_json::from_str::<ServerJsonRpcMessage>(&event.data)
            {
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => return,
                    result = incoming.send(message) => if result.is_err() { return; },
                }
            }
        }
    }
}

#[derive(Default)]
struct SseParser {
    pending: Vec<u8>,
    data: String,
    event: String,
}

struct SseEvent {
    event: String,
    data: String,
}

impl SseParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, ()> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending.drain(..=index).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                if self.data.is_empty() {
                    self.event.clear();
                } else {
                    events.push(SseEvent {
                        event: std::mem::take(&mut self.event),
                        data: std::mem::take(&mut self.data),
                    });
                }
                continue;
            }
            if line[0] == b':' {
                continue;
            }
            let separator = line.iter().position(|byte| *byte == b':');
            let (field, value) = match separator {
                Some(index) => (
                    &line[..index],
                    line[index + 1..]
                        .strip_prefix(b" ")
                        .unwrap_or(&line[index + 1..]),
                ),
                None => (line.as_slice(), &[][..]),
            };
            if field == b"event" {
                self.event = String::from_utf8(value.to_vec()).map_err(|_| ())?;
            } else if field == b"data" {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data
                    .push_str(std::str::from_utf8(value).map_err(|_| ())?);
            }
        }
        Ok(events)
    }
}

#[cfg(test)]
mod parser_tests {
    use super::SseParser;

    #[test]
    fn parses_fragmented_multiline_events() {
        let mut parser = SseParser::default();
        assert!(
            parser
                .push(b"event: endpoint\r\ndata: /mcp\r\n\r")
                .unwrap()
                .is_empty()
        );
        let events = parser
            .push(b"\nevent: message\ndata: {\"jsonrpc\":\ndata: \"2.0\"}\n\n")
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event, "endpoint");
        assert_eq!(events[0].data, "/mcp");
        assert_eq!(events[1].event, "message");
        assert_eq!(events[1].data, "{\"jsonrpc\":\n\"2.0\"}");
    }
}

pub(super) fn headers(values: &[(String, String)]) -> Result<HeaderMap, LegacySseError> {
    let mut headers = HeaderMap::new();
    for (key, value) in values {
        let name = HeaderName::from_bytes(key.as_bytes()).map_err(|_| LegacySseError)?;
        let value = HeaderValue::from_str(value).map_err(|_| LegacySseError)?;
        headers.insert(name, value);
    }
    Ok(headers)
}

pub(super) fn streamable_headers(
    values: &[(String, String)],
) -> Result<HashMap<HeaderName, HeaderValue>, LegacySseError> {
    let mut headers = HashMap::new();
    for (key, value) in values {
        let name = HeaderName::from_bytes(key.as_bytes()).map_err(|_| LegacySseError)?;
        let value = HeaderValue::from_str(value).map_err(|_| LegacySseError)?;
        headers.insert(name, value);
    }
    Ok(headers)
}

#[cfg(test)]
mod tests;
