//! One runner for UI-side `ShellClient` calls: the agent worker thread plus the current client.
//! Screens call [`Jobs::run`] instead of starting their own threads or runtimes.
use super::{Job, MonitorSignal, Worker};
use butler_shell_client::ShellClient;
use futures::{channel::oneshot, future::BoxFuture};
use gpui::App;
use std::{path::PathBuf, sync::Arc};

/// The worker and the client of the current attachment; `client` is `None` while detached.
#[derive(Clone, Default)]
pub(crate) struct Jobs {
    worker: Option<Arc<Worker>>,
    client: Option<ShellClient>,
}

impl gpui::Global for Jobs {}

/// The app attachment's monitor, asked to look again when a request finds the Agent gone.
struct AppMonitor(tokio::sync::mpsc::UnboundedSender<MonitorSignal>);

impl gpui::Global for AppMonitor {}

impl Jobs {
    pub(super) fn new(worker: Arc<Worker>, client: Option<ShellClient>) -> Self {
        Self {
            worker: Some(worker),
            client,
        }
    }

    /// The App's own attachment, for the life of the App and the only writer of [`Jobs`]: a
    /// restarted Agent reaches it with no window open (each window still attaches for its own
    /// source).
    pub(crate) fn keep_current(data: PathBuf, cx: &mut App) {
        let mut attachment = super::Attachment::start(Some(data));
        cx.set_global(AppMonitor(attachment.retry.clone()));
        cx.spawn(async move |cx| {
            while let Some((_source, jobs)) = attachment.next().await {
                cx.update(|cx| cx.set_global(jobs));
            }
        })
        .detach();
    }

    /// Asks the app attachment to look for the Agent again.
    pub(crate) fn rediscover(cx: &App) {
        if let Some(monitor) = cx.try_global::<AppMonitor>() {
            let _ = monitor.0.send(MonitorSignal::Retry);
        }
    }

    /// True when the current [`Jobs`] reaches the Agent `self` names (always, when `self` names
    /// none).
    pub(crate) fn current(&self, cx: &App) -> bool {
        self.client.as_ref().is_none_or(|client| {
            Self::client(cx)
                .is_some_and(|now| now.instance_identity() == client.instance_identity())
        })
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
