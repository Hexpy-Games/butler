use std::sync::{Arc, Mutex as StdMutex};

use tokio::{
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
};

use super::{AutomationRunListView, AutomationRunResult};
use crate::gateway::application::{AppApplication, GatewayApplicationError};

const CAPACITY: usize = 64;

#[derive(Clone)]
pub(crate) struct AutomationRunOwner {
    inner: Arc<Inner>,
}
struct Inner {
    admission: Mutex<Admission>,
    task: StdMutex<Option<JoinHandle<()>>>,
}
struct Admission {
    sender: Option<mpsc::Sender<Command>>,
}
enum Command {
    Initialize {
        app: AppApplication,
        reply: oneshot::Sender<Result<(), GatewayApplicationError>>,
    },
    Run {
        id: String,
        trigger: &'static str,
        reply: oneshot::Sender<Result<AutomationRunResult, GatewayApplicationError>>,
    },
    Due {
        reply: oneshot::Sender<Result<AutomationRunListView, GatewayApplicationError>>,
    },
}

impl AutomationRunOwner {
    pub(crate) fn start() -> Self {
        let (sender, receiver) = mpsc::channel(CAPACITY);
        let task = tokio::spawn(run(receiver));
        Self {
            inner: Arc::new(Inner {
                admission: Mutex::new(Admission {
                    sender: Some(sender),
                }),
                task: StdMutex::new(Some(task)),
            }),
        }
    }
    pub(crate) async fn initialize(
        &self,
        app: AppApplication,
    ) -> Result<(), GatewayApplicationError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.admit(Command::Initialize {
            app,
            reply: reply_tx,
        })
        .await?;
        reply_rx
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
    }
    pub(crate) async fn execute(
        &self,
        id: String,
        trigger: &'static str,
    ) -> Result<AutomationRunResult, GatewayApplicationError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.admit(Command::Run {
            id,
            trigger,
            reply: reply_tx,
        })
        .await?;
        reply_rx
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
    }
    pub(crate) async fn due(&self) -> Result<AutomationRunListView, GatewayApplicationError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.admit(Command::Due { reply: reply_tx }).await?;
        reply_rx
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
    }
    pub(crate) async fn close(&self) -> Result<(), GatewayApplicationError> {
        let sender = self.inner.admission.lock().await.sender.take();
        drop(sender);
        let task = self
            .inner
            .task
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(task) = task {
            task.await.map_err(|_| GatewayApplicationError::Internal)?;
        }
        Ok(())
    }

    async fn admit(&self, command: Command) -> Result<(), GatewayApplicationError> {
        let admission = self.inner.admission.lock().await;
        admission
            .sender
            .as_ref()
            .ok_or(GatewayApplicationError::Internal)?
            .send(command)
            .await
            .map_err(|_| GatewayApplicationError::Internal)
    }
}

async fn run(mut receiver: mpsc::Receiver<Command>) {
    let mut app = None;
    while let Some(command) = receiver.recv().await {
        match command {
            Command::Initialize { app: value, reply } => {
                let result = if app.is_some() {
                    Err(GatewayApplicationError::Internal)
                } else {
                    app = Some(value);
                    Ok(())
                };
                let _ = reply.send(result);
            }
            Command::Run { id, trigger, reply } => {
                let result = match app.as_ref() {
                    Some(app) => app.execute_automation(id, trigger).await,
                    None => Err(GatewayApplicationError::Internal),
                };
                let _ = reply.send(result);
            }
            Command::Due { reply } => {
                let result = match app.as_ref() {
                    Some(app) => app.execute_due_automations().await,
                    None => Err(GatewayApplicationError::Internal),
                };
                let _ = reply.send(result);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn close_drains_admitted_commands_and_rejects_late_admission() {
        let owner = AutomationRunOwner::start();
        let (reply, admitted) = oneshot::channel();
        owner
            .admit(Command::Due { reply })
            .await
            .expect("command admitted before close");

        owner.close().await.expect("owner closes after draining");
        // Uninitialized, the owner answers the drained command instead of dropping it.
        assert!(matches!(
            admitted.await.expect("admitted command completed"),
            Err(GatewayApplicationError::Internal)
        ));

        assert!(owner.due().await.is_err());
    }
}
