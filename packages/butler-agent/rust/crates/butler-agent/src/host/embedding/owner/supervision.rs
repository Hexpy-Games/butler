//! Close admission on every actor exit, including panic and cancellation.
use super::*;

struct ExitGuard(Arc<Inner>);

impl Drop for ExitGuard {
    fn drop(&mut self) {
        self.0.close();
    }
}

pub(super) fn supervise(
    inner: Arc<Inner>,
    completion: watch::Sender<Option<bool>>,
    actor: impl std::future::Future<Output = ()>,
) -> impl std::future::Future<Output = ()> {
    let guard = ExitGuard(inner);
    async move {
        let completed = AssertUnwindSafe(actor).catch_unwind().await.is_ok();
        drop(guard);
        completion.send_replace(Some(completed));
    }
}
