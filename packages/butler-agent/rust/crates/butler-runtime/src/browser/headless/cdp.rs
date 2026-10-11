//! DevTools protocol over the browser's pipe: NUL-separated JSON messages,
//! commands matched to replies by id, events delivered in order to one consumer.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

/// A protocol event; `session` is the flattened target session it came from.
pub(crate) struct Event {
    pub method: String,
    pub params: Value,
    pub session: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub(crate) struct Cdp {
    outgoing: mpsc::Sender<Vec<u8>>,
    pending: Pending,
    next: AtomicU64,
}

/// No single protocol command may hold a tool call longer than this.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
/// A message larger than this is a protocol fault, never page data to keep.
const MAX_MESSAGE: usize = 64 * 1024 * 1024;

impl Cdp {
    /// Starts reading `incoming`; events go to the returned receiver, which
    /// closes when the browser's pipe ends.
    pub(crate) fn start(
        mut incoming: mpsc::Receiver<Vec<u8>>,
        outgoing: mpsc::Sender<Vec<u8>>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Event>) {
        let pending: Pending = Arc::default();
        let (events, receiver) = mpsc::unbounded_channel();
        let reader = pending.clone();
        tokio::spawn(async move {
            let mut buffer = Vec::new();
            while let Some(chunk) = incoming.recv().await {
                buffer.extend_from_slice(&chunk);
                while let Some(end) = buffer.iter().position(|byte| *byte == 0) {
                    let message: Vec<u8> = buffer.drain(..=end).collect();
                    deliver(&reader, &events, &message[..end]);
                }
                if buffer.len() > MAX_MESSAGE {
                    break;
                }
            }
            // The pipe ended: every waiting command fails now, never later.
            reader
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
        });
        (
            Arc::new(Self {
                outgoing,
                pending,
                next: AtomicU64::new(1),
            }),
            receiver,
        )
    }

    /// Sends `method` to the browser (or to the target `session`) and waits
    /// for its reply. A protocol error is returned as its message.
    pub(crate) async fn send(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, sender);
        let mut bytes = message.to_string().into_bytes();
        bytes.push(0);
        if self.outgoing.send(bytes).await.is_err() {
            self.forget(id);
            return Err("browser_closed".into());
        }
        match tokio::time::timeout(COMMAND_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("browser_closed".into()),
            Err(_) => {
                self.forget(id);
                Err("protocol_timeout".into())
            }
        }
    }

    fn forget(&self, id: u64) {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }
}

fn deliver(pending: &Pending, events: &mpsc::UnboundedSender<Event>, raw: &[u8]) {
    let Ok(mut message) = serde_json::from_slice::<Value>(raw) else {
        return;
    };
    if let Some(id) = message["id"].as_u64() {
        let sender = pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
        if let Some(sender) = sender {
            let reply = match message.get("error") {
                Some(error) => Err(error["message"].as_str().unwrap_or("protocol_error").into()),
                None => Ok(message["result"].take()),
            };
            let _ = sender.send(reply);
        }
        return;
    }
    if let Some(method) = message["method"].as_str() {
        let _ = events.send(Event {
            method: method.to_owned(),
            params: message["params"].take(),
            session: message["sessionId"].as_str().map(str::to_owned),
        });
    }
}
