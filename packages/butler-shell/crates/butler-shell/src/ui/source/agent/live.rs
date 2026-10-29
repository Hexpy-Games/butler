//! Bounded, cancellable channel bridge: dropping a gpui stream closes its Tokio socket.
use super::{
    super::{ChatId, EventCursor, LiveEvent, LiveUpdate, SessionId, TurnId},
    Agent, convert,
};
use butler_shell_client::{Error, PageRequest, ShellClient};
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
                                Err(error) => {
                                    let _ = send.send(LiveEvent { cursor, update: LiveUpdate::Failed(convert::error(&error)) }).await;
                                },
                            }
                        }
                        Some(Err(Error::EventGap(_))) => { let _ = send.send(LiveEvent { cursor: None, update: LiveUpdate::Resync }).await; break; }
                        Some(Err(error)) => {
                            let _ = send.send(LiveEvent { cursor: None, update: LiveUpdate::Failed(convert::error(&error)) }).await;
                            break;
                        }
                        None => break,
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
            let delivered = message["role"] == "assistant" && message["status"] == "delivered";
            let mut updates = Vec::new();
            if delivered {
                refresh_rows(client, &mut updates).await;
            }
            // Keep the message last so it retains the envelope cursor for snapshot filtering.
            updates.push(LiveUpdate::Message {
                session: SessionId(session.to_owned().into()),
                message: convert::message(message)?,
            });
            Ok(updates)
        }
        "message.deleted" => Ok(vec![LiveUpdate::MessageDeleted {
            session: SessionId(
                convert::string(payload, "chat_id")
                    .or_else(|_| convert::string(payload, "session_id"))?
                    .to_owned()
                    .into(),
            ),
            id: convert::string(payload, "message_id")?.to_owned().into(),
        }]),
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
            let mut updates = vec![LiveUpdate::Turn {
                chat: ChatId(session.to_owned().into()),
                running,
            }];
            match client
                .authority_requests(session)
                .await
                .and_then(convert::authority)
            {
                Ok(cards) => updates.push(LiveUpdate::Authority {
                    session: SessionId(session.to_owned().into()),
                    cards,
                }),
                Err(error) => updates.push(LiveUpdate::Failed(convert::error(&error))),
            }
            refresh_rows(client, &mut updates).await;
            Ok(updates)
        }
        "session.created" | "session.updated" => {
            Ok(vec![LiveUpdate::Chat(convert::chat(&payload["session"])?)])
        }
        "session.cleared" | "session.permanently_deleted" => Ok(vec![LiveUpdate::Resync]),
        _ => Ok(Vec::new()),
    }
}

/// Refresh the same bounded first page Electron reloads on activity.
async fn refresh_rows(client: &ShellClient, updates: &mut Vec<LiveUpdate>) {
    let rows = match PageRequest::new(100, None) {
        Ok(page) => client.list_sessions(page).await,
        Err(error) => Err(error),
    };
    match rows.and_then(|page| {
        page.items
            .iter()
            .map(convert::chat)
            .collect::<Result<Vec<_>, _>>()
    }) {
        Ok(rows) => updates.extend(rows.into_iter().map(LiveUpdate::Chat)),
        Err(error) => updates.push(LiveUpdate::Failed(convert::error(&error))),
    }
}
