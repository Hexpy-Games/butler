//! Stub-only ordering of cancellation before the connection select is created.

use std::{future::Future, path::Path, task::Poll};
use tokio_util::sync::CancellationToken;

pub(super) async fn before_wait(data_root: &Path, shutdown: &CancellationToken) {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub") {
        return;
    }
    let Ok(order) = std::env::var("BUTLER_E2E_CONTROL_SHUTDOWN_ORDER") else {
        return;
    };
    if order != "cancel-before-wait" {
        return;
    }
    if tokio::fs::write(data_root.join("e2e-control-accepted"), b"accepted")
        .await
        .is_err()
    {
        return;
    }
    shutdown.cancelled().await;
    crate::host::service::shutdown_trace::event("control_cancelled_before_wait");
}

/// Mark only after the real frame read has been polled and returned Pending.
pub(super) async fn read_started<T>(data_root: &Path, read: impl Future<Output = T>) -> T {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_CONTROL_SHUTDOWN_ORDER").as_deref() != Ok("read")
    {
        return read.await;
    }
    tokio::pin!(read);
    if let Poll::Ready(result) =
        std::future::poll_fn(|cx| Poll::Ready(read.as_mut().poll(cx))).await
    {
        return result;
    }
    let _ = tokio::fs::write(data_root.join("e2e-control-accepted"), b"read pending").await;
    read.await
}
