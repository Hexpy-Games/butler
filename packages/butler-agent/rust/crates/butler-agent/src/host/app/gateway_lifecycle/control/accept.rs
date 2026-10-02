//! Each frame reader has its own task; an unfinished frame cannot hold up stop.
use super::{Arc, CancellationToken, ControlContext, TcpListener, TcpStream, serve_one};
use tokio::task::JoinSet;

pub(super) async fn run(
    listener: TcpListener,
    context: Arc<ControlContext>,
    shutdown: CancellationToken,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => {
                let Ok((stream, _peer)) = accepted else { continue; };
                connections.spawn(serve(stream, Arc::clone(&context), shutdown.clone()));
            },
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

async fn serve(mut stream: TcpStream, context: Arc<ControlContext>, shutdown: CancellationToken) {
    #[cfg(debug_assertions)]
    super::shutdown_order::before_wait(&context.data_root, &shutdown).await;
    tokio::select! {
        biased;
        _ = serve_one(&mut stream, &context) => {},
        () = shutdown.cancelled() => {
            crate::host::service::shutdown_trace::event("control_connection_cancelled");
        },
    }
}
