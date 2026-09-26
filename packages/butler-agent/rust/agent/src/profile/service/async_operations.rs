use std::future::Future;

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::super::contracts::{ProfileError, ProfileResult};
use super::ProfileService;

impl ProfileService {
    pub(super) async fn run_async<T, F, Fut>(
        &self,
        caller_cancellation: CancellationToken,
        operation: F,
    ) -> ProfileResult<T>
    where
        T: Send + 'static,
        F: FnOnce(CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = ProfileResult<T>> + Send + 'static,
    {
        let permit = self
            .async_admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ProfileError::new("profile_closed", "Profile service is closed."))?;
        let token = {
            let lifecycle = self.lifecycle.lock();
            if lifecycle.closing {
                return Err(ProfileError::new(
                    "profile_closed",
                    "Profile service is closed.",
                ));
            }
            self.operations.token()
        };
        let shutdown = self.shutdown.clone();
        let child = caller_cancellation.child_token();
        let operation_child = child.clone();
        let (sender, receiver) = oneshot::channel();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _permit = permit;
            let _token = token;
            if shutdown.is_cancelled() {
                child.cancel();
            }
            let mut future = Box::pin(operation(operation_child));
            let result = tokio::select! {
                result = &mut future => result,
                () = caller_cancellation.cancelled() => {
                    child.cancel();
                    future.await
                }
                () = shutdown.cancelled() => {
                    child.cancel();
                    future.await
                }
            };
            let _ = sender.send(result);
        });
        receiver.await.map_err(|_| {
            ProfileError::new("profile_operation_failed", "Profile operation failed.")
        })?
    }
}
