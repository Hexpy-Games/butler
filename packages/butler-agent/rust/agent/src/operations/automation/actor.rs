use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{Map, Value, json};
use tokio::{
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
};

use super::{AutomationDependencies, AutomationError, AutomationFuture, store::AutomationStore};

enum Command {
    Execute {
        name: String,
        args: Map<String, Value>,
        session_id: String,
        reply: oneshot::Sender<Result<Value, AutomationError>>,
    },
    Close,
}

pub(crate) struct NativeAutomationService {
    admission: Mutex<Option<mpsc::Sender<Command>>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl NativeAutomationService {
    pub(crate) fn open(data_root: &Path, dependencies: AutomationDependencies) -> Arc<Self> {
        let (sender, receiver) = mpsc::channel(64);
        let task = tokio::spawn(run(AutomationStore::new(data_root), dependencies, receiver));
        Arc::new(Self {
            admission: Mutex::new(Some(sender)),
            task: Mutex::new(Some(task)),
        })
    }

    pub(crate) fn execute<'a>(
        &'a self,
        name: &'a str,
        args: Map<String, Value>,
        session_id: &'a str,
    ) -> AutomationFuture<'a, Value> {
        Box::pin(async move {
            let (reply, answer) = oneshot::channel();
            let admission = self.admission.lock().await;
            let sender = admission.as_ref().ok_or_else(closed)?;
            sender
                .send(Command::Execute {
                    name: name.into(),
                    args,
                    session_id: session_id.into(),
                    reply,
                })
                .await
                .map_err(|_| closed())?;
            drop(admission);
            answer.await.map_err(|_| closed())?
        })
    }

    pub(crate) async fn close(&self) -> Result<(), AutomationError> {
        let mut admission = self.admission.lock().await;
        if let Some(sender) = admission.take() {
            sender.send(Command::Close).await.map_err(|_| closed())?;
        }
        drop(admission);
        if let Some(task) = self.task.lock().await.take() {
            task.await.map_err(|_| closed())?;
        }
        Ok(())
    }
}

async fn run(
    store: AutomationStore,
    dependencies: AutomationDependencies,
    mut receiver: mpsc::Receiver<Command>,
) {
    let store = Arc::new(store);
    let dependencies = Arc::new(dependencies);
    let mut timer = tokio::time::interval(dependencies.scheduler_interval);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            command = receiver.recv() => match command {
                Some(Command::Execute { name, args, session_id, reply }) => {
                    let store = store.clone();
                    let dependencies = dependencies.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        execute(&store, &dependencies, &name, &args, &session_id)
                    }).await.unwrap_or_else(|_| Err(closed()));
                    let _ = reply.send(result);
                }
                Some(Command::Close) | None => break,
            },
            _ = timer.tick() => {
                let store = store.clone();
                let dependencies = dependencies.clone();
                let result = tokio::task::spawn_blocking(move || {
                    dispatch_due(&store, &dependencies)
                }).await.unwrap_or_else(|_| Err(closed()));
                if let Err(error) = result {
                    eprintln!("[native-automation] scheduler code={}", error.code);
                }
            }
        }
    }
}

fn execute(
    store: &AutomationStore,
    dependencies: &AutomationDependencies,
    name: &str,
    args: &Map<String, Value>,
    session_id: &str,
) -> Result<Value, AutomationError> {
    let now = (dependencies.now_millis)();
    match name {
        "create_automation" => Ok(
            json!({"ok":true,"automation":store.create(args, if session_id.is_empty() { "butler/main" } else { session_id }, now, dependencies.parse_date.as_ref())?}),
        ),
        "list_automations" => Ok(
            json!({"ok":true,"automations":store.list(args.get("include_deleted").and_then(Value::as_bool) == Some(true))?}),
        ),
        "delete_automation" => {
            let id = args.get("id").and_then(Value::as_str).unwrap_or("").trim();
            if id.is_empty() {
                return Err(AutomationError::new(
                    "automation_invalid",
                    "delete_automation requires id",
                ));
            }
            Ok(json!({"ok":true,"automation":store.delete(id, now)?}))
        }
        "run_due_automations" => {
            let now = match args
                .get("now")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                Some(value) => (dependencies.parse_date)(value).ok_or_else(|| {
                    AutomationError::new(
                        "automation_invalid",
                        "run_due_automations now must be a valid ISO date",
                    )
                })?,
                None => now,
            };
            let runs = store.claim_due(now, dependencies.parse_date.as_ref())?;
            Ok(json!({"ok":true,"claimed":runs.len(),"runs":runs}))
        }
        _ => Err(AutomationError::new(
            "automation_tool_unknown",
            "Automation tool is unavailable",
        )),
    }
}

fn dispatch_due(
    store: &AutomationStore,
    dependencies: &AutomationDependencies,
) -> Result<(), AutomationError> {
    let now = (dependencies.now_millis)();
    for run in store.claim_due(now, dependencies.parse_date.as_ref())? {
        dependencies.enqueue.enqueue(
            run.envelope,
            Map::from_iter([
                (
                    "source".into(),
                    Value::String("packages/butler-agent/scripts/native-scheduler.ts".into()),
                ),
                ("automationId".into(), Value::String(run.automation.id)),
            ]),
        )?;
    }
    Ok(())
}

fn closed() -> AutomationError {
    AutomationError::new("automation_service_closed", "Automation service closed")
}
