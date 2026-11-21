//! Forward browser callbacks over the computer's pinned SSH connection.
use super::{Computer, relay};
use parking_lot::Mutex;
use std::{collections::HashMap, sync::LazyLock, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time,
};
use tokio_util::sync::CancellationToken;

static FORWARDS: LazyLock<Mutex<HashMap<String, (String, CancellationToken)>>> =
    LazyLock::new(Mutex::default);

pub(super) fn replace(id: &str, flow_id: &str, shutdown: &CancellationToken) -> CancellationToken {
    let token = shutdown.child_token();
    if let Some((_, previous)) = FORWARDS
        .lock()
        .insert(id.to_owned(), (flow_id.to_owned(), token.clone()))
    {
        previous.cancel();
    }
    token
}

pub(super) fn stop(id: &str, flow_id: &str) {
    let mut forwards = FORWARDS.lock();
    if let std::collections::hash_map::Entry::Occupied(entry) = forwards.entry(id.to_owned())
        && entry.get().0 == flow_id
    {
        entry.remove().1.cancel();
    }
}

pub(super) async fn serve(
    listener: TcpListener,
    computer: Computer,
    port: u16,
    stop: CancellationToken,
) {
    let connections = async {
        while let Ok((mut stream, _)) = listener.accept().await {
            let read = async {
                let mut buffer = [0_u8; 8192];
                let mut len = 0;
                while len < buffer.len() {
                    let n = stream.read(&mut buffer[len..]).await.ok()?;
                    if n == 0 {
                        break;
                    }
                    let from = len.saturating_sub(3);
                    len += n;
                    if let Some(end) = buffer[from..len].windows(4).position(|w| w == b"\r\n\r\n") {
                        return Some(buffer[..from + end + 4].to_vec());
                    }
                }
                None
            };
            let Ok(Some(head)) = time::timeout(Duration::from_secs(10), read).await else {
                continue;
            };
            let reply = relay::loopback(&computer, port, head, stop.clone())
                .await
                .unwrap_or_else(|_| "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n".into());
            let _ = stream.write_all(reply.as_bytes()).await;
            let _ = stream.shutdown().await;
            if reply.starts_with("HTTP/1.1 200") {
                break;
            }
        }
    };
    tokio::select! {
        biased;
        () = stop.cancelled() => {},
        () = time::sleep(Duration::from_secs(330)) => {},
        () = connections => {},
    }
}
