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
                    let mut updates = match updates(dirty, &event.raw) {
                        Ok(updates) => updates,
                        Err(error) => vec![LiveUpdate::Failed(convert::error(&error))],
                    };
                    if let Ok(envelope) = convert::decode::<wire::AppEventEnvelope>(&event.raw) {
                        updates.insert(0, LiveUpdate::NavigationEvent(Box::new(envelope)));
                    }
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
fn updates(dirty: &super::refresh::Dirty, raw: &Value) -> Result<Vec<LiveUpdate>, Error> {
    let raw = convert::decode::<wire::EventProjection>(raw)?;
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
            let mut updates = Vec::new();
            if delivered {
                dirty.mark(session);
            }
            // Keep the message last so it retains the envelope cursor for snapshot filtering.
            updates.push(LiveUpdate::Message {
                session: SessionId(session.to_owned().into()),
                message: convert::message(message)?,
            });
            Ok(updates)
        }
        "message.deleted" => {
            let payload = raw.payload.ok_or(Error::Protocol)?;
            Ok(vec![LiveUpdate::MessageDeleted {
                session: SessionId(
                    payload
                        .chat_id
                        .or(payload.session_id)
                        .ok_or(Error::Protocol)?
                        .into(),
                ),
                id: payload.message_id.ok_or(Error::Protocol)?.into(),
            }])
        }
        "turn.state_changed" => turn(dirty, &raw.payload.ok_or(Error::Protocol)?),
        "session.created" | "session.updated" => {
            let session = raw.payload.and_then(|p| p.session).ok_or(Error::Protocol)?;
            Ok(vec![LiveUpdate::Chat(convert::chat_row(&session)?)])
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
