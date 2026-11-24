//! Each frame reader has its own task; an unfinished frame cannot hold up stop.
use super::{Arc, CancellationToken, ControlContext, serve_one};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::task::JoinSet;

pub(super) async fn run<S, F>(
    accept: impl Fn() -> F,
    context: Arc<ControlContext>,
    shutdown: CancellationToken,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: Future<Output = std::io::Result<S>> + Send,
{
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = accept() => {
                let Ok(stream) = accepted else { continue; };
                connections.spawn(serve(stream, Arc::clone(&context), shutdown.clone()));
            },
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

async fn serve(
    mut stream: impl AsyncRead + AsyncWrite + Unpin,
    context: Arc<ControlContext>,
    shutdown: CancellationToken,
) {
    #[cfg(feature = "e2e-fixtures")]
    super::shutdown_order::before_wait(&context.data_root, &shutdown).await;
    tokio::select! {
        biased;
        _ = serve_one(&mut stream, &context) => {},
        () = shutdown.cancelled() => {
            crate::host::service::shutdown_trace::event("control_connection_cancelled");
        },
    }
}
