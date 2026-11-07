//! Tokio lives on one owned background thread; gpui only receives channel results.
mod convert;
mod frame;
mod jobs;
mod live;
mod refresh;
mod session_view;
mod watch;

use super::wire;
use super::{
    AuthorityCard, ChatPage, ChatRef, EventCursor, Fetch, LiveEvent, PageCursor, SentTurn,
    SessionId, Source, SourceError, TurnId,
};
use butler_shell_client::{PageRequest, ShellClient};
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
    future::BoxFuture,
};
use std::{path::PathBuf, rc::Rc, sync::Arc};

pub(crate) use jobs::Jobs;

type Job = BoxFuture<'static, ()>;

pub(crate) struct Worker {
    jobs: tokio::sync::mpsc::UnboundedSender<Job>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

pub(crate) struct Agent {
    worker: Arc<Worker>,
    client: ShellClient,
}

pub(crate) enum MonitorSignal {
    Retry,
    SnapshotLoaded,
}

pub(crate) struct Attachment {
    worker: Arc<Worker>,
    changes: mpsc::UnboundedReceiver<Option<ShellClient>>,
    pub(crate) retry: tokio::sync::mpsc::UnboundedSender<MonitorSignal>,
}
impl Attachment {
    pub(crate) fn start(data: Option<PathBuf>) -> Self {
        let (jobs, mut incoming) = tokio::sync::mpsc::unbounded_channel::<Job>();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let (changes, events) = mpsc::unbounded();
        let (retry, retries) = tokio::sync::mpsc::unbounded_channel();
        std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                return;
            };
            runtime.block_on(async move {
                tokio::spawn(watch::monitor(data, changes, retries));
                tokio::pin!(stopped);
                loop {
                    tokio::select! {
                        _ = &mut stopped => break,
                        job = incoming.recv() => match job {
                            Some(job) => { tokio::spawn(job); }
                            None => break,
                        }
                    }
                }
            });
            runtime.shutdown_timeout(std::time::Duration::from_secs(2));
        });
        Self {
            worker: Arc::new(Worker {
                jobs,
                stop: Some(stop),
            }),
            changes: events,
            retry,
        }
    }
    /// The next attach change: the new source (if any) and the runner for UI-side calls.
    pub(crate) async fn next(&mut self) -> Option<(Option<Rc<dyn Source>>, Jobs)> {
        self.changes.next().await.map(|client| {
            let jobs = Jobs::new(self.worker.clone(), client.clone());
            let source = client.map(|client| {
                Rc::new(Agent {
                    worker: self.worker.clone(),
                    client,
                }) as Rc<dyn Source>
            });
            (source, jobs)
        })
    }
}

impl Agent {
    fn fetch<T: Send + 'static>(
        &self,
        work: impl Future<Output = Result<T, butler_shell_client::Error>> + Send + 'static,
    ) -> Fetch<T> {
        let (send, receive) = oneshot::channel();
        let _ = self.worker.jobs.send(Box::pin(async move {
            let _ = send.send(work.await);
        }));
        Box::pin(async move {
            receive
                .await
                .map_err(|_| SourceError::Disconnected)?
                .map_err(|error| convert::error(&error))
        })
    }
}

impl Source for Agent {
    fn summary(&self, session: &SessionId) -> Fetch<wire::SessionSummaryView> {
        self.frame_summary(session)
    }
    fn settings(&self) -> Fetch<wire::FrameSettings> {
        self.frame_settings()
    }
    fn session_action(&self, session: &SessionId, action: super::SessionAction) -> Fetch<()> {
        self.frame_action(session, action)
    }
    fn chats(&self, cursor: Option<PageCursor>) -> Fetch<ChatPage> {
        let client = self.client.clone();
        self.fetch(async move {
            let page = client
                .list_sessions(PageRequest::new(100, cursor.map(|c| c.0))?)
                .await?;
            Ok(ChatPage {
                chats: page
                    .items
                    .iter()
                    .map(convert::chat)
                    .collect::<Result<_, _>>()?,
                next: page.next_cursor.map(PageCursor),
                events: EventCursor(page.event_cursor),
            })
        })
    }
    fn open_session(&self, session: &SessionId) -> Fetch<wire::SessionView> {
        let (client, session) = (self.client.clone(), session.0.to_string());
        self.fetch(async move { session_view::fetch(&client, &session, None).await })
    }
    fn session_view(
        &self,
        session: &SessionId,
        before: Option<String>,
    ) -> Fetch<wire::SessionView> {
        let (client, session) = (self.client.clone(), session.0.to_string());
        self.fetch(async move { session_view::fetch(&client, &session, before.as_deref()).await })
    }

    fn authority(&self, session: &SessionId) -> Fetch<Vec<AuthorityCard>> {
        let (client, session) = (self.client.clone(), session.0.to_string());
        self.fetch(async move { Ok(convert::authority(client.authority_requests(&session).await?)) })
    }
    fn live(&self, after: EventCursor) -> futures::stream::LocalBoxStream<'static, LiveEvent> {
        live::subscribe(self, after)
    }
    fn create_chat(&self) -> Fetch<ChatRef> {
        let client = self.client.clone();
        self.fetch(async move {
            let raw = client.create_session(None).await?;
            let raw = convert::decode::<wire::CreatedSessionProjection>(&raw)?;
            convert::identity(&raw.session)
        })
    }
    fn cancel(&self, turn: &TurnId) -> Fetch<()> {
        let (client, turn) = (self.client.clone(), turn.0.to_string());
        self.fetch(async move { client.cancel_turn(&turn).await.map(|_| ()) })
    }
}

/// The turn a `POST /messages` response started.
pub(crate) fn sent_turn(raw: &serde_json::Value) -> Result<SentTurn, SourceError> {
    let raw = convert::decode::<wire::SentTurnProjection>(raw)
        .map_err(|error| convert::error(&error))?;
    let id = raw
        .turn_id
        .or_else(|| raw.turn.as_ref().and_then(|t| t.turn_id.clone()))
        .or_else(|| raw.turn.and_then(|t| t.id))
        .ok_or_else(|| convert::error(&butler_shell_client::Error::Protocol))?;
    Ok(SentTurn {
        turn: TurnId(id.into()),
    })
}

/// A client failure in the UI's terms.
pub(crate) fn source_error(error: &butler_shell_client::Error) -> SourceError {
    convert::error(error)
}
