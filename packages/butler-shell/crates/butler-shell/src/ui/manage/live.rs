//! The live topics the management pages follow, from the App stream the shell already reads:
//! React's small buses (`libraryEvents.ts`, `documentEvents.ts`, `canonEvents.ts`
//! `publishCanonEvent`, `projectDashboardInvalidation.ts`, `useSessionViewSubscription.ts`
//! `refreshSessionViewSubscriptions`) as one revision counter per topic. A page observes the
//! entity once and refetches only when its own topic's revision moved; no page subscribes to a
//! stream of its own.
#![allow(dead_code, reason = "seam API: the P4 units read it; F6 removes this")]
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{Context, SharedString};
use serde_json::Value;

use crate::ui::source::wire::{AppEventEnvelope, NavigationView};

/// What a page follows.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Topic {
    Library,
    Document(SharedString),
    /// A project's canon (board, plans, epics, tags).
    Canon(SharedString),
    /// A project's dashboard facts.
    Dashboard(SharedString),
    /// A session's view (the observer).
    Session(SharedString),
    /// `canon.trust_requested` / `canon.trust_changed`: the trust prompt rereads.
    CanonTrust,
}

#[derive(Default)]
pub(crate) struct ManageLive {
    revisions: HashMap<Topic, u64>,
    /// `stream.reconcile_required`: every topic moves.
    all: u64,
    /// `canon.queue_changed`: every canon topic moves (a queue change names only its session).
    canon: u64,
    /// The last `document.updated` payload per document (`DocumentUpdate`).
    documents: HashMap<SharedString, Rc<Value>>,
}

impl ManageLive {
    /// The topic's revision; it moves whenever the topic must be read again.
    pub(crate) fn revision(&self, topic: &Topic) -> u64 {
        let canon = if matches!(topic, Topic::Canon(_)) {
            self.canon
        } else {
            0
        };
        self.all + canon + self.revisions.get(topic).copied().unwrap_or(0)
    }

    /// The last `document.updated` payload of `id`.
    pub(crate) fn document_update(&self, id: &str) -> Option<Rc<Value>> {
        self.documents.get(id).cloned()
    }

    /// A local write moved `topic` (a dashboard send, a dashboard activation).
    pub(crate) fn bump(&mut self, topic: Topic, cx: &mut Context<Self>) {
        *self.revisions.entry(topic).or_default() += 1;
        cx.notify();
    }

    /// One committed App event; observers hear of it only when some revision moved.
    pub(crate) fn publish(
        &mut self,
        event: &AppEventEnvelope,
        navigation: Option<&NavigationView>,
        cx: &mut Context<Self>,
    ) {
        let kind = event.r#type.as_str();
        let payload = &event.payload;
        if kind == "stream.reconcile_required" {
            self.all += 1;
            cx.notify();
            return;
        }
        let mut topics = Vec::new();
        if library_changed(kind, payload) {
            topics.push(Topic::Library);
        }
        if kind == "document.updated"
            && let Some(id) = text(payload, "id")
        {
            self.documents.insert(id.clone(), Rc::new(payload.clone()));
            topics.push(Topic::Document(id));
        }
        if kind == "canon.queue_changed" {
            self.canon += 1;
        } else if matches!(
            kind,
            "space.changed" | "canon.changed" | "canon.progress_changed"
        ) && let Some(project) = text(payload, "project_id")
        {
            topics.push(Topic::Canon(project));
        }
        if matches!(kind, "canon.trust_requested" | "canon.trust_changed") {
            topics.push(Topic::CanonTrust);
        }
        topics.extend(dashboards(kind, payload, navigation).map(Topic::Dashboard));
        if session_view_refresh(kind) {
            let child = text(payload, "child_session_id");
            topics.extend(
                event_session_id(kind, payload)
                    .into_iter()
                    .chain(child)
                    .map(Topic::Session),
            );
        }
        let moved = kind == "canon.queue_changed" || !topics.is_empty();
        for topic in topics {
            *self.revisions.entry(topic).or_default() += 1;
        }
        if moved {
            cx.notify();
        }
    }
}

fn text(value: &Value, key: &str) -> Option<SharedString> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|text| SharedString::from(text.to_owned()))
}

/// `publishLibraryEvent`: committed delivery or a library write.
fn library_changed(kind: &str, payload: &Value) -> bool {
    matches!(kind, "document.updated" | "outputs.changed")
        || (kind == "turn.state_changed" && payload["turn"]["state"] == "delivered")
}

/// `eventSessionId` (liveSessionReconciliation.ts:173).
fn event_session_id(kind: &str, payload: &Value) -> Option<SharedString> {
    if matches!(
        kind,
        "agent.turn_event" | "agent.turn_event.progress" | "progress.summary"
    ) {
        return text(payload, "session_id");
    }
    text(payload, "chat_id")
        .or_else(|| text(payload, "session_id"))
        .or_else(|| text(&payload["turn"], "chat_id"))
        .or_else(|| text(&payload["message"], "chat_id"))
}

/// `isSessionViewRefreshEvent` (liveSessionReconciliation.ts:146).
fn session_view_refresh(kind: &str) -> bool {
    matches!(
        kind,
        "subsession.changed"
            | "question.answered"
            | "message.created"
            | "message.updated"
            | "message.deleted"
            | "outputs.changed"
            | "turn.state_changed"
            | "turn.progress"
            | "turn.queued"
            | "turn.queue_failed"
            | "agent.turn_event"
            | "agent.turn_event.progress"
            | "progress.summary"
            | "session.controls_updated"
            | "session.control.updated"
            | "session_queue.changed"
            | "session.queue.changed"
    ) || [
        "turn.progress.",
        "session.control",
        "session_queue.",
        "session.queue.",
        "worker.",
        "worker_",
    ]
    .iter()
    .any(|prefix| kind.starts_with(prefix))
}

/// `invalidateProjectDashboard` for every project at once: a direct project change, or a
/// committed report, terminal turn or session change of a session in the project.
fn dashboards(
    kind: &str,
    payload: &Value,
    navigation: Option<&NavigationView>,
) -> impl Iterator<Item = SharedString> {
    let mut projects = Vec::new();
    if matches!(kind, "project_dashboard_updated" | "project.updated") {
        projects.extend(text(payload, "project_id").or_else(|| text(&payload["project"], "id")));
        return projects.into_iter();
    }
    let report = matches!(kind, "message.created" | "message.updated")
        && payload["message"]["status"] == "delivered";
    let terminal = kind == "turn.state_changed"
        && matches!(
            payload["turn"]["state"].as_str(),
            Some("delivered" | "cancelled" | "failed")
        );
    let session = matches!(kind, "session.created" | "session.updated");
    if !report && !terminal && !session {
        return projects.into_iter();
    }
    if let (Some(id), Some(navigation)) = (event_session_id(kind, payload), navigation) {
        projects.extend(
            navigation
                .projects
                .iter()
                .filter(|project| {
                    project
                        .sessions
                        .iter()
                        .flatten()
                        .any(|session| session.id == id.as_ref())
                })
                .map(|project| SharedString::from(project.id.clone())),
        );
    }
    projects.extend(text(&payload["session"], "project_id"));
    projects.into_iter()
}
