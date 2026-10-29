//! Bounded, cancellable channel bridge: dropping a gpui stream closes its Tokio socket.
use super::{
    super::{ChatId, EventCursor, LiveEvent, LiveUpdate, SessionId, TurnId},
    Agent, convert,
};
use butler_shell_client::{Error, ShellClient};
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
        let mut events = client.live_events(after.0);
        loop {
            tokio::select! {
                _ = &mut cancelled => break,
                event = events.next() => {
                    match event {
                        Some(Ok(event)) => {
                            let cursor = event.cursor.map(EventCursor);
                            match updates(&client, &event.raw).await {
                                Ok(updates) => {
                                    // Only the last projection claims the envelope cursor.
                                    let count = updates.len();
                                    for (i, update) in updates.into_iter().enumerate() {
                                        if send.send(LiveEvent { cursor: (i + 1 == count).then_some(cursor).flatten(), update }).await.is_err() { return; }
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        Some(Err(Error::EventGap(_))) => { let _ = send.send(LiveEvent { cursor: None, update: LiveUpdate::Resync }).await; break; }
                        _ => break,
                    }
                }
            }
        }
    }));
    Box::pin(futures::stream::unfold(
        (receive, cancel),
        |(mut receive, cancel)| async move {
            receive.next().await.map(|event| (event, (receive, cancel)))
        },
    ))
}
async fn updates(client: &ShellClient, raw: &Value) -> Result<Vec<LiveUpdate>, Error> {
    let payload = &raw["payload"];
    let name = convert::string(raw, "type")?;
    match name {
        "message.created" | "message.updated" => {
            let message = &payload["message"];
            let session = message["chat_id"]
                .as_str()
                .or_else(|| payload["chat_id"].as_str())
                .or_else(|| payload["session_id"].as_str())
                .ok_or(Error::Protocol)?;
            Ok(vec![LiveUpdate::Message {
                session: SessionId(session.to_owned().into()),
                message: convert::message(message)?,
            }])
        }
        "turn.state_changed" => {
            let turn = payload.get("turn").unwrap_or(payload);
            let session = turn["chat_id"]
                .as_str()
                .or_else(|| payload["chat_id"].as_str())
                .or_else(|| payload["session_id"].as_str())
                .ok_or(Error::Protocol)?;
            let state = convert::string(turn, "state")?;
            let running = if convert::active(state) {
                Some(TurnId(
                    convert::string(turn, "id")
                        .or_else(|_| convert::string(payload, "turn_id"))?
                        .to_owned()
                        .into(),
                ))
            } else {
                None
            };
            let cards = convert::authority(client.authority_requests(session).await?)?;
            Ok(vec![
                LiveUpdate::Turn {
                    chat: ChatId(session.to_owned().into()),
                    running,
                },
                LiveUpdate::Authority {
                    session: SessionId(session.to_owned().into()),
                    cards,
                },
            ])
        }
        "session.created" | "session.updated" => {
            Ok(vec![LiveUpdate::Chat(convert::chat(&payload["session"])?)])
        }
        "session.cleared" | "session.permanently_deleted" => Ok(vec![LiveUpdate::Resync]),
        _ => Ok(Vec::new()),
    }
}
