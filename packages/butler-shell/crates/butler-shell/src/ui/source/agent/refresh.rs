//! Coalesced activity reads run alongside streaming, with one batch in flight.
use super::{
    super::{LiveEvent, LiveUpdate, SessionId},
    convert,
};
use butler_shell_client::{Error, PageRequest, ShellClient};
use futures::{SinkExt as _, channel::mpsc};
use std::{collections::HashSet, time::Duration};

#[derive(Default)]
pub(super) struct Dirty {
    sessions: std::sync::Mutex<HashSet<String>>,
    changed: tokio::sync::Notify,
}
impl Dirty {
    pub(super) fn mark(&self, session: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(session.to_owned());
        }
    }
    /// Refresh after available input drains, rather than while UI backpressure
    /// is still pacing delivery of the same replay burst.
    pub(super) fn flush(&self) {
        if self
            .sessions
            .lock()
            .is_ok_and(|sessions| !sessions.is_empty())
        {
            self.changed.notify_one();
        }
    }
}
pub(super) async fn run(client: &ShellClient, dirty: &Dirty, send: &mut mpsc::Sender<LiveEvent>) {
    loop {
        dirty.changed.notified().await;
        // Drain a replay burst before issuing reads. Marks during the batch
        // remain in the set and schedule exactly one trailing batch.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let sessions = match dirty.sessions.lock() {
            Ok(mut sessions) => std::mem::take(&mut *sessions),
            Err(_) => return,
        };
        if sessions.is_empty() {
            continue;
        }
        let rows = rows(client).await;
        match rows {
            Ok(rows) => {
                for row in rows {
                    if emit(send, LiveUpdate::Chat(row)).await.is_err() {
                        return;
                    }
                }
            }
            Err(error) => {
                if emit(send, LiveUpdate::Failed(convert::error(&error)))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
        for session in sessions {
            let update = match client
                .authority_requests(&session)
                .await
                .and_then(convert::authority)
            {
                Ok(cards) => LiveUpdate::Authority {
                    session: SessionId(session.into()),
                    cards,
                },
                Err(error) => LiveUpdate::Failed(convert::error(&error)),
            };
            if emit(send, update).await.is_err() {
                return;
            }
        }
    }
}
async fn rows(client: &ShellClient) -> Result<Vec<super::super::ChatSummary>, Error> {
    // The gateway has session-view/summary projections but no single-row
    // session-list endpoint. Refresh the same bounded first page as the App.
    client
        .list_sessions(PageRequest::new(100, None)?)
        .await?
        .items
        .iter()
        .map(convert::chat)
        .collect()
}
async fn emit(send: &mut mpsc::Sender<LiveEvent>, update: LiveUpdate) -> Result<(), ()> {
    send.send(LiveEvent {
        cursor: None,
        update,
    })
    .await
    .map_err(|_| ())
}
