//! `app/canonQueue.ts` and `useSessionCanonQueue`: one shared reader per session that follows
//! the live events, and the edit that claims it. Every call runs through `Jobs::run`.
use std::collections::HashMap;

use butler_shell_client::Error;
use butler_ds::ui::toast::{self, Toast};
use gpui::{App, Global, SharedString, Window};
use serde_json::Value;

use crate::ui::i18n::canon_order::CanonOrder;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{CanonQueueEdit, CanonQueueView};

/// `Snapshot`
#[derive(Clone, Default)]
pub(crate) struct CanonQueueSnapshot {
    pub(crate) view: Option<CanonQueueView>,
    pub(crate) busy: bool,
}

/// `Reader`; `token` tells a reader from a later one of the same session.
struct Reader {
    snapshot: CanonQueueSnapshot,
    observers: usize,
    token: u64,
    revision: u64,
    in_flight: bool,
    dirty: bool,
}

#[derive(Default)]
struct Readers {
    by_session: HashMap<String, Reader>,
    tokens: u64,
}

impl Global for Readers {}

fn readers(cx: &mut App) -> &mut Readers {
    cx.default_global::<Readers>()
}

fn parse(value: Value) -> Option<CanonQueueView> {
    serde_json::from_value(value).ok()
}

/// `canonQueueSnapshot`
pub(crate) fn snapshot(cx: &mut App, session_id: &str) -> CanonQueueSnapshot {
    readers(cx)
        .by_session
        .get(session_id)
        .map(|reader| reader.snapshot.clone())
        .unwrap_or_default()
}

/// What keeps a session's reader alive while the section is in the frame; releasing it (the
/// keyed state is dropped) is `observeCanonQueue`'s unsubscribe.
struct Observer;

/// `useSessionCanonQueue` (the read half): subscribes while rendered and returns the snapshot.
pub(crate) fn use_canon_queue(
    session_id: &str,
    window: &mut Window,
    cx: &mut App,
) -> CanonQueueSnapshot {
    if !session_id.is_empty() {
        let id = session_id.to_owned();
        let _observer = window.use_keyed_state(
            SharedString::from(format!("canon-queue-{session_id}")),
            cx,
            move |_, cx| {
                observe(cx, &id);
                let id = id.clone();
                cx.on_release(move |_: &mut Observer, cx| release(cx, &id))
                    .detach();
                Observer
            },
        );
    }
    snapshot(cx, session_id)
}

/// `observeCanonQueue`
fn observe(cx: &mut App, session_id: &str) {
    let readers = readers(cx);
    readers.tokens += 1;
    let token = readers.tokens;
    let reader = readers
        .by_session
        .entry(session_id.to_owned())
        .or_insert_with(|| Reader {
            snapshot: CanonQueueSnapshot::default(),
            observers: 0,
            token,
            revision: 0,
            in_flight: false,
            dirty: false,
        });
    reader.observers += 1;
    if reader.observers == 1 {
        refresh(cx, session_id);
    }
}

fn release(cx: &mut App, session_id: &str) {
    let readers = readers(cx);
    if let Some(reader) = readers.by_session.get_mut(session_id) {
        reader.observers = reader.observers.saturating_sub(1);
        if reader.observers == 0 {
            readers.by_session.remove(session_id);
        }
    }
}

fn publish(cx: &mut App, session_id: &str, snapshot: CanonQueueSnapshot) {
    if let Some(reader) = readers(cx).by_session.get_mut(session_id) {
        reader.snapshot = snapshot;
        cx.refresh_windows();
    }
}

/// `refresh`: fetches the view unless a fetch or an edit is under way; either one fetches
/// again when it ends.
fn refresh(cx: &mut App, session_id: &str) {
    let Some(reader) = readers(cx).by_session.get_mut(session_id) else {
        return;
    };
    reader.dirty = true;
    if reader.in_flight || reader.snapshot.busy {
        return;
    }
    reader.dirty = false;
    reader.in_flight = true;
    reader.revision += 1;
    let (token, revision) = (reader.token, reader.revision);
    let id = session_id.to_owned();
    let fetch = Jobs::run(cx, {
        let id = id.clone();
        move |client| async move { client.get_canon_queue(&id).await.ok().and_then(parse) }
    });
    cx.spawn(async move |cx| {
        let view = fetch.await.flatten();
        cx.update(|cx| settled(cx, &id, token, revision, view));
    })
    .detach();
}

fn settled(cx: &mut App, session_id: &str, token: u64, revision: u64, view: Option<CanonQueueView>) {
    let Some(reader) = readers(cx).by_session.get_mut(session_id) else {
        return;
    };
    if reader.token != token {
        return;
    }
    reader.in_flight = false;
    let again = reader.dirty;
    if reader.revision == revision
        && let Some(view) = view.filter(|view| view.session_id == session_id)
    {
        publish(cx, session_id, CanonQueueSnapshot { view: Some(view), busy: false });
    }
    if again {
        refresh(cx, session_id);
    }
}

/// `publishCanonQueueEvent`: the live event types `stream.reconcile_required`,
/// `canon.queue_changed` and `canon.progress_changed` with their payloads.
pub(crate) fn on_event(cx: &mut App, event_type: &str, payload: &Value) {
    let ids: Vec<String> = readers(cx)
        .by_session
        .iter()
        .filter(|(id, reader)| {
            let view = reader.snapshot.view.as_ref();
            match event_type {
                "stream.reconcile_required" => true,
                "canon.queue_changed" => {
                    payload.get("session_id").and_then(Value::as_str) == Some(id.as_str())
                        && payload.get("graph_revision").and_then(Value::as_i64)
                            > Some(view.map_or(-1, |view| view.graph_revision))
                }
                "canon.progress_changed" => {
                    let epic = payload.get("epic_id").and_then(Value::as_str);
                    view.is_some_and(|view| {
                        view.chains.iter().any(|chain| {
                            chain.steps.iter().any(|step| {
                                step.items.iter().any(|item| Some(item.epic_id.as_str()) == epic)
                            })
                        })
                    })
                }
                _ => false,
            }
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        refresh(cx, &id);
    }
}

/// How an edit ended.
enum Outcome {
    Next(CanonQueueView),
    Conflict(CanonQueueView),
    Failed,
}

async fn send(client: butler_shell_client::ShellClient, id: String, input: Value) -> Outcome {
    match client.edit_canon_queue(&id, &input).await {
        Ok(value) => parse(value).map_or(Outcome::Failed, Outcome::Next),
        Err(Error::Http(409)) => client
            .get_canon_queue(&id)
            .await
            .ok()
            .and_then(parse)
            .map_or(Outcome::Failed, Outcome::Conflict),
        Err(_) => Outcome::Failed,
    }
}

/// `useSessionCanonQueue().edit`: claims the reader (`beginCanonQueueEdit`; none when an edit is
/// under way), shows `optimistic` (a drag's result) meanwhile, then takes the server's view,
/// reloads on a 409 and restores the old view on any other failure.
pub(crate) fn edit(
    cx: &mut App,
    session_id: &str,
    input: &CanonQueueEdit,
    optimistic: Option<CanonQueueView>,
) {
    let Some(reader) = readers(cx).by_session.get_mut(session_id) else {
        return;
    };
    let Some(before) = reader.snapshot.view.clone() else {
        return;
    };
    if reader.snapshot.busy {
        return;
    }
    reader.revision += 1;
    let token = reader.token;
    let shown = optimistic.unwrap_or_else(|| before.clone());
    publish(cx, session_id, CanonQueueSnapshot { view: Some(shown), busy: true });
    let id = session_id.to_owned();
    let Ok(body) = serde_json::to_value(input) else {
        return finish(cx, &id, token, before);
    };
    let done = Jobs::run(cx, {
        let id = id.clone();
        move |client| send(client, id, body)
    });
    cx.spawn(async move |cx| {
        let outcome = done.await.unwrap_or(Outcome::Failed);
        cx.update(|cx| {
            let copy = CanonOrder::get(cx);
            let next = match outcome {
                Outcome::Next(view) => view,
                Outcome::Conflict(view) => {
                    toast::show(cx, Toast::message(copy.changed));
                    view
                }
                Outcome::Failed => {
                    toast::show(cx, Toast::error(copy.failed));
                    before
                }
            };
            finish(cx, &id, token, next);
        });
    })
    .detach();
}

/// The `finish` of `beginCanonQueueEdit`.
fn finish(cx: &mut App, session_id: &str, token: u64, next: CanonQueueView) {
    let Some(reader) = readers(cx).by_session.get_mut(session_id) else {
        return;
    };
    if reader.token != token {
        return;
    }
    let dirty = reader.dirty;
    publish(cx, session_id, CanonQueueSnapshot { view: Some(next), busy: false });
    if dirty {
        refresh(cx, session_id);
    }
}
