//! Headless tabs and the facts the browser reports about them. Memory only.
use super::progress::Progress;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Instant,
};
use tokio::sync::{Notify, oneshot, watch};

/// One frame of an observation: its CDP session and Butler's isolated world.
#[derive(Clone, Debug)]
pub(crate) struct Frame {
    pub id: String,
    pub url: String,
    pub parent: Option<usize>,
    pub session: String,
    pub context: i64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Geometry {
    pub width: f64,
    pub height: f64,
    pub css_width: f64,
    pub css_height: f64,
}

impl Geometry {
    pub(crate) fn to_value(self) -> Value {
        use super::js::jnum;
        json!({"width":jnum(self.width),"height":jnum(self.height),"cssWidth":jnum(self.css_width),"cssHeight":jnum(self.css_height)})
    }
}

/// The newest observation of a tab; refs are valid only against it.
pub(crate) struct Observation {
    pub obs: String,
    pub epoch: u64,
    pub frames: Vec<Frame>,
    pub bindings: HashMap<String, usize>,
    pub nodes: Vec<Value>,
    pub fields: Vec<Value>,
    pub payment: bool,
    pub payment_frames: HashSet<usize>,
    pub complete: bool,
    pub geometry: Option<Geometry>,
    pub capture_regions: Value,
    pub thumb: Option<Vec<u8>>,
}

impl Observation {
    pub(crate) fn node(&self, reference: &str) -> Option<&Value> {
        self.nodes.iter().find(|node| node["ref"] == reference)
    }
    pub(crate) fn frame_of(&self, reference: &str) -> Option<&Frame> {
        self.bindings
            .get(reference)
            .and_then(|i| self.frames.get(*i))
    }
}

pub(crate) struct Dialog {
    pub id: String,
    pub epoch: u64,
    pub kind: String,
    pub message: String,
    pub default_prompt: String,
    pub origin: String,
    pub deadline_ms: u64,
    pub session: String,
    pub before_unload_close: bool,
    pub answering: bool,
}

pub(crate) struct Upload {
    pub path: String,
    pub done: oneshot::Sender<Value>,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent tab facts the App snapshot reports"
)]
pub(crate) struct Tab {
    pub id: String,
    pub owner: String,
    pub target: String,
    pub session: String,
    pub context: String,
    pub url: String,
    pub title: String,
    pub epoch: u64,
    pub opener: Option<String>,
    pub popup_parent_url: Option<String>,
    pub admitted: bool,
    pub policy: Value,
    pub loading: bool,
    pub requests: HashMap<String, Instant>,
    pub dialog: Option<Dialog>,
    pub dialogs: watch::Sender<u64>,
    pub loads: watch::Sender<u64>,
    pub pending_batch: Option<Vec<Value>>,
    pub observation: Option<Arc<Observation>>,
    pub observation_seq: u64,
    pub progress: Progress,
    pub busy: bool,
    pub cancelled: bool,
    pub call_id: Option<String>,
    pub waiting: bool,
    pub waiting_turn: Option<String>,
    pub last_call: Instant,
    pub crashed: bool,
    pub closing: bool,
    /// Out-of-process frames: frame id → CDP session.
    pub frames: HashMap<String, String>,
    /// Butler's isolated world per (CDP session, frame id).
    pub contexts: HashMap<(String, String), i64>,
    pub upload: Option<Upload>,
    /// Butler's own page (output check, reader render), never a conversation's.
    pub hidden: Option<super::hidden::Purpose>,
    pub diagnostics: Option<super::hidden::Diagnostics>,
}

impl Tab {
    pub(crate) fn new(id: String, owner: String, target: String, session: String) -> Self {
        Self {
            id,
            owner,
            target,
            session,
            context: String::new(),
            url: String::new(),
            title: String::new(),
            epoch: 1,
            opener: None,
            popup_parent_url: None,
            admitted: true,
            policy: Value::Null,
            loading: false,
            requests: HashMap::new(),
            dialog: None,
            dialogs: watch::channel(0).0,
            loads: watch::channel(0).0,
            pending_batch: None,
            observation: None,
            observation_seq: 0,
            progress: Progress::default(),
            busy: false,
            cancelled: false,
            call_id: None,
            waiting: false,
            waiting_turn: None,
            last_call: Instant::now(),
            crashed: false,
            closing: false,
            frames: HashMap::new(),
            contexts: HashMap::new(),
            upload: None,
            hidden: None,
            diagnostics: None,
        }
    }

    /// A navigation or document change: every ref of the last observation expires.
    pub(crate) fn changed(&mut self) {
        self.epoch += 1;
        self.observation = None;
    }

    pub(crate) fn public_dialog(&self) -> Value {
        self.dialog.as_ref().map_or(Value::Null, |d| {
            json!({"id":d.id,"epoch":d.epoch,"type":d.kind,"message":d.message,"defaultPrompt":d.default_prompt,
                "origin":d.origin,"deadline":d.deadline_ms,"approvalRequired":true,"untrusted":true})
        })
    }

    pub(crate) fn snapshot(&self) -> Value {
        json!({"id":self.id,"owner":self.owner,"opener":self.opener,"dialog":self.public_dialog(),"url":self.url,
            "title":self.title,"status":if self.crashed {"crashed"} else if self.loading {"loading"} else {"idle"},
            "agent":true,"driven":false,"profile":"signed_out","epoch":self.epoch,"holder":"agent","sticky":false,
            "waiting":self.waiting,"busy":self.busy,"inUse":self.busy,"picking":false,"selectionCount":0,
            "stills":true})
    }

    pub(crate) fn pending_dialog(&self) -> Value {
        json!({"status":"dialog_pending","tab":self.id,"url":self.url,"epoch":self.epoch,"dialog":self.public_dialog()})
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub tabs: HashMap<String, Tab>,
    /// CDP session (page or out-of-process frame) → tab id.
    pub sessions: HashMap<String, String>,
    /// Owner → its in-memory browser context.
    pub contexts: HashMap<String, String>,
    /// Owner → change events its next tool call drains.
    pub events: HashMap<String, Vec<Value>>,
    /// Page targets attached before the call that created them claimed them.
    pub unclaimed: HashMap<String, String>,
    /// Page targets this process is creating right now.
    pub creating: usize,
    pub utility: Option<String>,
}

#[derive(Clone, Default)]
pub(crate) struct Shared {
    state: Arc<Mutex<State>>,
    pub attached: Arc<Notify>,
}

impl Shared {
    pub(crate) fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `f` on the tab, if it still exists.
    pub(crate) fn with_tab<T>(&self, id: &str, f: impl FnOnce(&mut Tab) -> T) -> Option<T> {
        self.lock().tabs.get_mut(id).map(f)
    }
}

impl State {
    pub(crate) fn event(&mut self, tab: &str, kind: &str, data: &Value) {
        let Some(tab) = self.tabs.get(tab) else {
            return;
        };
        let mut event = json!({"type":kind,"tab":tab.id,"epoch":tab.epoch});
        if let (Some(target), Some(data)) = (event.as_object_mut(), data.as_object()) {
            target.extend(data.clone());
        }
        self.events
            .entry(tab.owner.clone())
            .or_default()
            .push(event);
    }

    pub(crate) fn tab_of_session(&self, session: &str) -> Option<String> {
        self.sessions.get(session).cloned()
    }

    pub(crate) fn snapshots(&self) -> Vec<Value> {
        self.tabs
            .values()
            .filter(|tab| tab.admitted)
            .map(Tab::snapshot)
            .collect()
    }

    /// Forgets a tab and every session that belonged to it.
    pub(crate) fn remove(&mut self, id: &str) -> Option<Tab> {
        let tab = self.tabs.remove(id)?;
        self.sessions.retain(|_, owner| owner != id);
        Some(tab)
    }
}

/// Short ids the model copies reliably: a letter plus six base-36 characters.
pub(crate) fn short_id(prefix: char, taken: impl Fn(&str) -> bool) -> String {
    loop {
        let value = uuid::Uuid::new_v4().as_u128() % 36_u128.pow(6);
        let mut digits = String::new();
        let mut rest = value;
        for _ in 0..6 {
            let digit = u32::try_from(rest % 36).unwrap_or(0);
            digits.insert(0, char::from_digit(digit, 36).unwrap_or('0'));
            rest /= 36;
        }
        let id = format!("{prefix}{digits}");
        if !taken(&id) {
            return id;
        }
    }
}
