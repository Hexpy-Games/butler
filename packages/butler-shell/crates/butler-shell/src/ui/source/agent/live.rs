//! Bounded, cancellable channel bridge: dropping a gpui stream closes its Tokio socket.
use super::super::wire;
use super::{
    super::{ChatId, EventCursor, LiveEvent, LiveUpdate, SessionId, TurnId},
    Agent, convert,
};
use butler_shell_client::Error;
use futures::{SinkExt as _, StreamExt as _, channel::mpsc};
use serde_json::Value;

pub(super) fn subscribe(
    agent: &Agent,
    after: EventCursor,
) -> futures::stream::LocalBoxStream<'static, LiveEvent> {
    let client = agent.client.clone();
    let (mut send, receive) = mpsc::channel(32);
    let (cancel, mut cancelled) = tokio::sync::oneshot::channel::<()>();
    let _ = agent.worker.jobs.send(Box::pin(async move {
        let dirty = super::refresh::Dirty::default();
        let mut refresh_send = send.clone();
        tokio::select! {
            _ = &mut cancelled => {},
            () = super::refresh::run(&client, &dirty, &mut refresh_send) => {},
            () = pump(&client, after.0, &dirty, &mut send) => {},
        }
    }));
    Box::pin(futures::stream::unfold(
        (receive, cancel),
        |(mut receive, cancel)| async move {
            receive.next().await.map(|event| (event, (receive, cancel)))
        },
    ))
}
async fn pump(
    client: &butler_shell_client::ShellClient,
    mut cursor: u64,
    dirty: &super::refresh::Dirty,
    send: &mut mpsc::Sender<LiveEvent>,
) {
    let mut backoff = std::time::Duration::from_millis(100);
    loop {
        let mut events = client.live_events(cursor);
        while let Some(event) = futures::future::poll_fn(|cx| {
            let next = events.as_mut().poll_next(cx);
            if next.is_pending() {
                dirty.flush();
            }
            next
        })
        .await
        {
            match event {
                Ok(event) => {
                    let updates = match updates(dirty, &event.raw) {
                        Ok(updates) => updates,
                        Err(error) => vec![LiveUpdate::Failed(convert::error(&error))],
                    };
                    if deliver(send, event.cursor.map(EventCursor), updates)
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if let Some(next) = event.cursor {
                        cursor = next;
                    }
                    backoff = std::time::Duration::from_millis(100);
                }
                Err(Error::EventGap(_)) => {
                    let _ = deliver(send, None, vec![LiveUpdate::Resync]).await;
                    return;
                }
                Err(error) => {
                    if deliver(send, None, vec![LiveUpdate::Failed(convert::error(&error))])
                        .await
                        .is_err()
                    {
                        return;
                    }
                    if matches!(
                        error.kind(),
                        butler_shell_client::FailureKind::Disconnected
                            | butler_shell_client::FailureKind::Incompatible
                    ) {
                        return;
                    }
                    break;
                }
            }
        }
        dirty.flush();
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(std::time::Duration::from_secs(5));
    }
}
async fn deliver(
    send: &mut mpsc::Sender<LiveEvent>,
    cursor: Option<EventCursor>,
    updates: Vec<LiveUpdate>,
) -> Result<(), ()> {
    let count = updates.len();
    for (index, update) in updates.into_iter().enumerate() {
        send.send(LiveEvent {
            cursor: (index + 1 == count).then_some(cursor).flatten(),
            update,
        })
        .await
        .map_err(|_| ())?;
    }
    Ok(())
}
/// The event types the open session's transcript and turn progress read.
const SESSION_EVENTS: [&str; 7] = [
    "message.created",
    "message.updated",
    "message.deleted",
    "turn.state_changed",
    "progress.summary",
    "agent.turn_event",
    "agent.turn_event.progress",
];

fn updates(dirty: &super::refresh::Dirty, raw: &Value) -> Result<Vec<LiveUpdate>, Error> {
    let projection = convert::decode::<wire::EventProjection>(raw)?;
    let mut updates = chat_updates(dirty, &projection)?;
    if SESSION_EVENTS.contains(&projection.r#type.as_str())
        && let Some(session) = event_session(raw)
    {
        // Keep the event last so it retains the envelope cursor for snapshot filtering.
        updates.push(LiveUpdate::Event {
            session: SessionId(session.into()),
            event: Box::new(envelope(raw)),
        });
    }
    Ok(updates)
}

/// The session an event belongs to.
fn event_session(raw: &Value) -> Option<String> {
    let payload = raw.get("payload")?;
    [
        payload.pointer("/message/chat_id"),
        payload.get("chat_id"),
        payload.get("session_id"),
        payload.pointer("/turn/chat_id"),
        payload.pointer("/event/sessionId"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .map(str::to_owned)
}

/// The gateway envelope as sent; provisional drafts have no id.
fn envelope(raw: &Value) -> wire::AppEventEnvelope {
    let text = |key: &str| {
        raw.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    wire::AppEventEnvelope {
        protocol_version: text("protocol_version"),
        id: raw.get("id").and_then(Value::as_i64).unwrap_or(0),
        r#type: text("type"),
        created_at: text("created_at"),
        payload: raw.get("payload").cloned().unwrap_or(Value::Null),
    }
}

/// The updates the sidebar and the composer read from an event.
fn chat_updates(
    dirty: &super::refresh::Dirty,
    raw: &wire::EventProjection,
) -> Result<Vec<LiveUpdate>, Error> {
    match raw.r#type.as_str() {
        "message.created" | "message.updated" => {
            let payload = raw.payload.as_ref().ok_or(Error::Protocol)?;
            let message = payload.message.as_ref().ok_or(Error::Protocol)?;
            let session = message
                .chat_id
                .as_deref()
                .or(payload.chat_id.as_deref())
                .or(payload.session_id.as_deref())
                .ok_or(Error::Protocol)?;
            let delivered = message.role.as_deref() == Some("assistant")
                && message.status.as_deref() == Some("delivered");
            if delivered {
                dirty.mark(session);
            }
            Ok(Vec::new())
        }
        "message.deleted" => {
            let payload = raw.payload.as_ref().ok_or(Error::Protocol)?;
            payload
                .chat_id
                .as_ref()
                .or(payload.session_id.as_ref())
                .ok_or(Error::Protocol)?;
            payload.message_id.as_ref().ok_or(Error::Protocol)?;
            Ok(Vec::new())
        }
        "turn.state_changed" => turn(dirty, raw.payload.as_ref().ok_or(Error::Protocol)?),
        "session.created" | "session.updated" => {
            let session = raw
                .payload
                .as_ref()
                .and_then(|p| p.session.as_ref())
                .ok_or(Error::Protocol)?;
            Ok(vec![LiveUpdate::Chat(convert::chat_row(session)?)])
        }
        "session.cleared" | "session.permanently_deleted" => Ok(vec![LiveUpdate::Resync]),
        _ => Ok(Vec::new()),
    }
}

fn turn(
    dirty: &super::refresh::Dirty,
    payload: &wire::EventPayloadProjection,
) -> Result<Vec<LiveUpdate>, Error> {
    let (chat_id, state, id) = match &payload.turn {
        wire::Field::Present(Some(turn)) => (&turn.chat_id, &turn.state, &turn.id),
        wire::Field::Present(None) => return Err(Error::Protocol),
        wire::Field::Missing => (&payload.chat_id, &payload.state, &payload.id),
    };
    let session = chat_id
        .as_deref()
        .or(payload.chat_id.as_deref())
        .or(payload.session_id.as_deref())
        .ok_or(Error::Protocol)?;
    let state = state.as_deref().ok_or(Error::Protocol)?;
    let running = if convert::active(state) {
        Some(TurnId(
            id.as_deref()
                .or(payload.turn_id.as_deref())
                .ok_or(Error::Protocol)?
                .to_owned()
                .into(),
        ))
    } else {
        None
    };
    let updates = vec![LiveUpdate::Turn {
        chat: ChatId(session.to_owned().into()),
        running,
    }];
    dirty.mark(session);
    Ok(updates)
}
