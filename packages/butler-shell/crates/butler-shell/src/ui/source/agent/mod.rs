//! Tokio lives on one owned background thread; gpui only receives channel results.
mod convert;
mod live;
mod presentation;
mod refresh;
mod watch;

use super::{
    AuthorityCard, ChatId, ChatPage, ChatRef, ClientMessageId, ComposerContext, Decision,
    EventCursor, Fetch, LiveEvent, MessageCursor, MessagePage, PageCursor, RequestRef, SentTurn,
    SessionId, Source, SourceError, TurnId, model::AllowScope,
};
use butler_shell_client::{AuthorityDecision, PageRequest, ShellClient};
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
    future::BoxFuture,
};
use std::{path::PathBuf, rc::Rc, sync::Arc};

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
    presentation: Rc<presentation::Presentation>,
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
    pub(crate) async fn next(&mut self) -> Option<Option<Rc<dyn Source>>> {
        self.changes.next().await.map(|client| {
            client.map(|client| {
                Rc::new(Agent {
                    worker: self.worker.clone(),
                    client,
                    presentation: Rc::default(),
                }) as Rc<dyn Source>
            })
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
    fn chats(&self, cursor: Option<PageCursor>) -> Fetch<ChatPage> {
        let client = self.client.clone();
        let fallback = self.presentation.get();
        let first = cursor.is_none();
        self.presentation.initial(self.fetch(async move {
            let page = client
                .list_sessions(PageRequest::new(100, cursor.map(|c| c.0))?)
                .await?;
            let context = if first && let Some(row) = page.items.first() {
                presentation::read(&client, convert::string(row, "id")?).await?
            } else {
                fallback
            };
            Ok((
                ChatPage {
                    chats: page
                        .items
                        .iter()
                        .map(convert::chat)
                        .collect::<Result<_, _>>()?,
                    next: page.next_cursor.map(PageCursor),
                    events: EventCursor(page.event_cursor),
                },
                context,
            ))
        }))
    }
    fn messages(&self, session: &SessionId, before: Option<MessageCursor>) -> Fetch<MessagePage> {
        let (client, session) = (self.client.clone(), session.0.to_string());
        self.presentation.remember(self.fetch(async move {
            let (raw, context) = tokio::join!(
                client.message_window(&session, before.as_ref().map(|c| c.0.as_str()), 200),
                presentation::read(&client, &session)
            );
            Ok((convert::window(&raw?)?, context?))
        }))
    }

    fn authority(&self, session: &SessionId) -> Fetch<Vec<AuthorityCard>> {
        let (client, session) = (self.client.clone(), session.0.to_string());
        self.fetch(async move { convert::authority(client.authority_requests(&session).await?) })
    }
    fn live(&self, after: EventCursor) -> futures::stream::LocalBoxStream<'static, LiveEvent> {
        live::subscribe(self, after)
    }
    fn create_chat(&self) -> Fetch<ChatRef> {
        let client = self.client.clone();
        self.presentation.remember(self.fetch(async move {
            let raw = client.create_session(None).await?;
            let chat = convert::identity(&raw["session"])?;
            Ok((chat, ComposerContext::unavailable()))
        }))
    }

    fn send(&self, chat: &ChatId, id: ClientMessageId, text: String) -> Fetch<SentTurn> {
        let (client, chat) = (self.client.clone(), chat.0.to_string());
        self.fetch(async move {
            let raw = client.post_message(&chat, &id.0, &text).await?;
            let id = raw["turn_id"]
                .as_str()
                .or_else(|| raw["turn"]["turn_id"].as_str())
                .or_else(|| raw["turn"]["id"].as_str())
                .ok_or(butler_shell_client::Error::Protocol)?;
            Ok(SentTurn {
                turn: TurnId(id.to_owned().into()),
            })
        })
    }
    fn cancel(&self, turn: &TurnId) -> Fetch<()> {
        let (client, turn) = (self.client.clone(), turn.0.to_string());
        self.fetch(async move { client.cancel_turn(&turn).await.map(|_| ()) })
    }
    fn answer(&self, session: &SessionId, request: &RequestRef, decision: Decision) -> Fetch<()> {
        let (client, session, request) = (
            self.client.clone(),
            session.0.to_string(),
            request.0.to_string(),
        );
        let decision = match decision {
            Decision::AllowOnce => AuthorityDecision::Allow {
                scope: "once".into(),
            },
            Decision::Allow(scope) => AuthorityDecision::Allow {
                scope: match scope {
                    AllowScope::Conversation => "conversation",
                    AllowScope::Site => "site",
                }
                .into(),
            },
            Decision::Deny => AuthorityDecision::Deny,
            Decision::Modify(instruction) => AuthorityDecision::Modify { instruction },
            Decision::Answer(answers) => AuthorityDecision::Answer(
                serde_json::json!({"answers": answers.iter().map(|a| serde_json::json!({"id":a.id.as_ref(),"selected":a.selected.iter().map(AsRef::<str>::as_ref).collect::<Vec<_>>(),"custom":a.custom,"skipped":a.skipped})).collect::<Vec<_>>()}),
            ),
        };
        self.fetch(async move {
            client
                .answer_authority(&session, &request, decision)
                .await
                .map(|_| ())
        })
    }
    fn composer(&self) -> ComposerContext {
        self.presentation.get()
    }
}
