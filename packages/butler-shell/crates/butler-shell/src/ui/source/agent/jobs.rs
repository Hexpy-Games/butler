//! One runner for UI-side `ShellClient` calls: the agent worker thread plus the current client.
//! Screens call [`Jobs::run`] instead of starting their own threads or runtimes.
use super::{Job, Worker};
use butler_shell_client::ShellClient;
use futures::{channel::oneshot, future::BoxFuture};
use gpui::App;
use std::sync::Arc;

/// The worker and the client of the current attachment; `client` is `None` while detached.
#[derive(Clone, Default)]
pub(crate) struct Jobs {
    worker: Option<Arc<Worker>>,
    client: Option<ShellClient>,
}

impl gpui::Global for Jobs {}

impl Jobs {
    pub(super) fn new(worker: Arc<Worker>, client: Option<ShellClient>) -> Self {
        Self {
            worker: Some(worker),
            client,
        }
    }

    /// The current client, for code that only builds requests.
    pub(crate) fn client(cx: &App) -> Option<ShellClient> {
        cx.try_global::<Self>().and_then(|jobs| jobs.client.clone())
    }

    /// Runs `work` with the current client on the agent worker. The future resolves to `None`
    /// when no agent is attached or the worker stopped before `work` finished.
    pub(crate) fn run<T, F, Fut>(cx: &App, work: F) -> BoxFuture<'static, Option<T>>
    where
        T: Send + 'static,
        F: FnOnce(ShellClient) -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
    {
        let jobs = cx.try_global::<Self>().cloned().unwrap_or_default();
        let (send, receive) = oneshot::channel();
        if let (Some(worker), Some(client)) = (jobs.worker, jobs.client) {
            let job: Job = Box::pin(async move {
                let _ = send.send(work(client).await);
            });
            let _ = worker.jobs.send(job);
        }
        Box::pin(async move { receive.await.ok() })
    }
}
