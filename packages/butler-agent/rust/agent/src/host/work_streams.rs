//! Single lifecycle owner for source-compatible WorkStream and todo files.

mod outcome;
mod prompt;
mod recovery;
mod storage;
mod support;
mod todo_view;

use std::{path::PathBuf, sync::Arc, thread::JoinHandle};

use serde_json::Value;
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::{
    btcc::BtccError,
    gateway::{
        AppWorkStreamQuery, AppWorkStreamReader, AppWorkStreamTurnOutcome, ApplicationFuture,
    },
};

const CAPACITY: usize = 32;

#[derive(Clone)]
pub(crate) struct WorkStreamScope {
    pub session_id: String,
    pub origin_chat_id: Option<String>,
    pub project_id: Option<String>,
    pub turn_id: String,
}

pub(crate) struct WorkStreamPrompt {
    pub text: String,
    pub worker_task_ids: Vec<String>,
}

enum Job {
    UpdateTodo(WorkStreamScope, Value, Reply),
    ViewTodo(WorkStreamScope, Value, Reply),
    List(WorkStreamScope, Value, Reply),
    Transition(WorkStreamScope, Value, Reply),
    Active(AppWorkStreamQuery, Reply),
    Reconcile(AppWorkStreamTurnOutcome, Reply),
    Prompt(String, Option<String>, Reply),
    Link(WorkStreamScope, String, &'static str, Reply),
}

type Reply = oneshot::Sender<Result<Value, BtccError>>;

struct State {
    sender: Option<mpsc::Sender<Job>>,
    worker: Option<JoinHandle<()>>,
}

pub(crate) struct NativeWorkStreams {
    state: Arc<Mutex<State>>,
}

impl NativeWorkStreams {
    pub(crate) fn open(root: PathBuf) -> Result<Self, BtccError> {
        let (sender, mut receiver) = mpsc::channel(CAPACITY);
        let worker = std::thread::Builder::new()
            .name("butler-work-streams".into())
            .spawn(move || {
                let mut store = storage::Store::new(root);
                while let Some(job) = receiver.blocking_recv() {
                    let (result, reply) = match job {
                        Job::UpdateTodo(scope, input, reply) => {
                            (store.update_todo(scope, input), reply)
                        }
                        Job::ViewTodo(scope, input, reply) => {
                            (store.view_todo(scope, input), reply)
                        }
                        Job::List(scope, input, reply) => (store.list(scope, input), reply),
                        Job::Transition(scope, input, reply) => {
                            (store.transition(scope, input), reply)
                        }
                        Job::Active(query, reply) => (store.active(query), reply),
                        Job::Reconcile(outcome, reply) => {
                            (store.reconcile_turn(outcome).map(|()| Value::Null), reply)
                        }
                        Job::Prompt(session, project, reply) => {
                            (store.prompt_context(&session, project.as_deref()), reply)
                        }
                        Job::Link(scope, target_id, field, reply) => {
                            (store.link(scope, target_id, field), reply)
                        }
                    };
                    let _ = reply.send(result);
                }
            })
            .map_err(|error| failure("work_stream_owner_open_failed", error))?;
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                sender: Some(sender),
                worker: Some(worker),
            })),
        })
    }

    async fn submit(&self, make: impl FnOnce(Reply) -> Job) -> Result<Value, BtccError> {
        Self::submit_state(self.state.clone(), make).await
    }

    async fn submit_state(
        state: Arc<Mutex<State>>,
        make: impl FnOnce(Reply) -> Job,
    ) -> Result<Value, BtccError> {
        let (reply, result) = oneshot::channel();
        let guard = state.lock().await;
        guard
            .sender
            .as_ref()
            .ok_or_else(closed)?
            .send(make(reply))
            .await
            .map_err(|_| closed())?;
        drop(guard);
        result.await.map_err(|_| closed())?
    }

    pub(crate) async fn execute(
        &self,
        name: &str,
        scope: WorkStreamScope,
        arguments: Value,
    ) -> Result<Value, BtccError> {
        match name {
            "update_todo_list" => {
                self.submit(|reply| Job::UpdateTodo(scope, arguments, reply))
                    .await
            }
            "list_todo_list" => {
                self.submit(|reply| Job::ViewTodo(scope, arguments, reply))
                    .await
            }
            "list_work_streams" => {
                self.submit(|reply| Job::List(scope, arguments, reply))
                    .await
            }
            "update_work_stream_state" => {
                self.submit(|reply| Job::Transition(scope, arguments, reply))
                    .await
            }
            _ => Err(failure("work_stream_tool_unsupported", name)),
        }
    }

    pub(crate) async fn close(&self) -> Result<(), BtccError> {
        let mut state = self.state.lock().await;
        state.sender.take();
        if let Some(worker) = state.worker.take() {
            tokio::task::spawn_blocking(move || worker.join())
                .await
                .map_err(|error| failure("work_stream_owner_join_failed", error))?
                .map_err(|_| failure("work_stream_owner_join_failed", "worker panicked"))?;
        }
        Ok(())
    }

    pub(crate) async fn link_orchestration(
        &self,
        scope: WorkStreamScope,
        relation_id: String,
    ) -> Result<(), BtccError> {
        self.submit(|reply| Job::Link(scope, relation_id, "linked_orchestration_ids", reply))
            .await
            .map(|_| ())
    }

    pub(crate) async fn link_worker(
        &self,
        scope: WorkStreamScope,
        task_id: String,
    ) -> Result<(), BtccError> {
        self.submit(|reply| Job::Link(scope, task_id, "linked_worker_task_ids", reply))
            .await
            .map(|_| ())
    }

    pub(crate) async fn prompt_context(
        &self,
        session_id: String,
        project_id: Option<String>,
    ) -> Result<WorkStreamPrompt, BtccError> {
        self.submit(|reply| Job::Prompt(session_id, project_id, reply))
            .await
            .and_then(|value| {
                let text = value.get("text").and_then(Value::as_str).ok_or_else(|| {
                    failure("work_stream_prompt_invalid", "Invalid prompt projection")
                })?;
                let worker_task_ids = value
                    .get("worker_task_ids")
                    .and_then(Value::as_array)
                    .ok_or_else(|| failure("work_stream_prompt_invalid", "Invalid worker links"))?
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
                Ok(WorkStreamPrompt {
                    text: text.to_owned(),
                    worker_task_ids,
                })
            })
    }
}

impl AppWorkStreamReader for NativeWorkStreams {
    fn list_active(&self, query: AppWorkStreamQuery) -> ApplicationFuture<Value> {
        let state = self.state.clone();
        Box::pin(async move {
            Self::submit_state(state, |reply| Job::Active(query, reply))
                .await
                .map_err(|_| crate::gateway::GatewayApplicationError::Internal)
        })
    }

    fn reconcile_turn(&self, outcome: AppWorkStreamTurnOutcome) -> ApplicationFuture<()> {
        let state = self.state.clone();
        Box::pin(async move {
            Self::submit_state(state, |reply| Job::Reconcile(outcome, reply))
                .await
                .map(|_| ())
                .map_err(|_| crate::gateway::GatewayApplicationError::Internal)
        })
    }
}

fn closed() -> BtccError {
    failure("work_stream_owner_closed", "WorkStream owner is closed")
}

fn failure(code: &'static str, message: impl std::fmt::Display) -> BtccError {
    BtccError::new(code, message.to_string())
}
