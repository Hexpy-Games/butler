//! A remote computer's view of the main's memory (session environments).
//! The main hands over a read-only copy of its instructions and profile on
//! every connect and answers the conversation memory reads this side waits on;
//! this side never contacts the main.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::Instant;

/// The main's all-chats instructions and profile, as last handed over.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct MemoryCopy {
    #[serde(default)]
    pub pending_ids: Vec<String>,
    pub rules: Vec<CopiedRule>,
    pub naming_profile: Option<String>,
    pub runtime_profile: Option<String>,
}

/// One active all-chats instruction of the main.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CopiedRule {
    pub handle: String,
    pub text: String,
    pub revision: String,
    pub expires_at: Option<String>,
}

#[derive(Default)]
struct State {
    copy: Option<Arc<MemoryCopy>>,
    next: u64,
    mains: HashMap<u64, MainListener>,
    last_contact: Option<Instant>,
    pending: HashMap<String, Pending>,
}

/// A read waiting for the main's answer.
struct Pending {
    request: Value,
    answer: oneshot::Sender<Value>,
    /// Set for a read admitted only by recent contact; fires when a main stream attaches.
    attached: Option<oneshot::Sender<()>>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);

/// Replaces the copy with the one the main just handed over.
pub fn replace_copy(copy: MemoryCopy) {
    STATE.lock().copy = Some(Arc::new(copy));
}

/// The copy from the main's last connect since this process started.
pub fn copy() -> Option<Arc<MemoryCopy>> {
    STATE.lock().copy.clone()
}

/// How long the main counts as connected after its last request or a dropped
/// live stream: its relay attaching after the write that started a turn, or
/// reconnecting (7b backoff 1, 2, 4 s plus SSH setup).
const CONTACT_GRACE: Duration = Duration::from_secs(15);
/// The longest a read waits once a main stream can carry it: a 5 s search
/// budget, an on-demand embedding model load and two SSH round trips, with
/// headroom. A turn is never parked.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);

/// Receives each read the remote waits on, for one attached main live stream.
pub type MainListener = Arc<dyn Fn(&'static str, &Value) + Send + Sync>;

/// Any request from the main: it counts as connected for [`CONTACT_GRACE`].
pub fn note_main_contact() {
    STATE.lock().last_contact = Some(Instant::now());
}

/// An attached main live stream; dropping it detaches and counts as contact.
/// A stream whose SSH session died stays attached until this side's next
/// heartbeat write on it fails (at most 15 s): a read made meanwhile waits
/// the full [`ANSWER_TIMEOUT`] before it fails.
pub struct MainAttachment(u64);

impl Drop for MainAttachment {
    fn drop(&mut self) {
        let mut state = STATE.lock();
        state.mains.remove(&self.0);
        state.last_contact = Some(Instant::now());
    }
}

/// Attaches a main live stream; reads waiting now are sent to it at once.
pub fn attach_main(listener: MainListener) -> MainAttachment {
    let send = listener.clone();
    let (id, waiting) = {
        let mut state = STATE.lock();
        let id = state.next;
        state.next += 1;
        state.mains.insert(id, listener);
        let mut waiting = Vec::with_capacity(state.pending.len());
        for pending in state.pending.values_mut() {
            if let Some(attached) = pending.attached.take() {
                let _ = attached.send(());
            }
            waiting.push(pending.request.clone());
        }
        (id, waiting)
    };
    for request in &waiting {
        send("memory.read_requested", request);
    }
    MainAttachment(id)
}

/// Wakes the attached mains with an id-less event.
pub fn wake_mains(event_type: &'static str) {
    let listeners = STATE.lock().mains.values().cloned().collect::<Vec<_>>();
    let payload = Value::Object(Map::new());
    for listener in listeners {
        listener(event_type, &payload);
    }
}

/// Sends a read to every attached main and waits for its answer. `None` at
/// once when no main is connected (no attached stream and no contact within
/// [`CONTACT_GRACE`]). A read admitted only by recent contact waits the rest
/// of the grace, extended to [`ANSWER_TIMEOUT`] from its start if a main
/// stream attaches meanwhile; any other read waits [`ANSWER_TIMEOUT`].
pub async fn ask(mut request: Map<String, Value>) -> Option<Value> {
    let started = Instant::now();
    let id = uuid::Uuid::new_v4().to_string();
    request.insert("read_id".to_owned(), Value::String(id.clone()));
    let request = Value::Object(request);
    let (sender, mut receiver) = oneshot::channel();
    let (attached, on_attach) = oneshot::channel();
    let (listeners, grace) = {
        let mut state = STATE.lock();
        let grace = if state.mains.is_empty() {
            let at = state.last_contact?;
            let left = CONTACT_GRACE.saturating_sub(at.elapsed());
            if left.is_zero() {
                return None;
            }
            Some(left)
        } else {
            None
        };
        let pending = Pending {
            request: request.clone(),
            answer: sender,
            attached: grace.is_some().then_some(attached),
        };
        state.pending.insert(id.clone(), pending);
        (state.mains.values().cloned().collect::<Vec<_>>(), grace)
    };
    let _waiting = Waiting(id);
    for listener in &listeners {
        listener("memory.read_requested", &request);
    }
    if let Some(left) = grace {
        tokio::select! {
            biased;
            answer = &mut receiver => return answer.ok(),
            _ = on_attach => {}
            () = tokio::time::sleep(left) => return None,
        }
    }
    tokio::time::timeout_at(started + ANSWER_TIMEOUT, receiver)
        .await
        .ok()?
        .ok()
}

/// Forgets a read when its caller stops waiting.
struct Waiting(String);

impl Drop for Waiting {
    fn drop(&mut self) {
        STATE.lock().pending.remove(&self.0);
    }
}

/// Hands the main's answer to the read waiting for it; false when none waits.
pub fn answer(read_id: &str, answer: Value) -> bool {
    let waiting = STATE.lock().pending.remove(read_id);
    waiting.is_some_and(|pending| pending.answer.send(answer).is_ok())
}
