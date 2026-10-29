//! A truncated HTTP body drops the TCP connection, rather than ending SSE cleanly.
use super::{transport::Peer, *};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

async fn request(socket: &mut tokio::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        bytes.push(socket.read_u8().await.unwrap());
    }
    String::from_utf8(bytes)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .to_owned()
}
async fn write_events(socket: &mut tokio::net::TcpStream, ids: &[u64]) {
    socket
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 65536\r\n\r\n",
        )
        .await
        .unwrap();
    for id in ids {
        socket
            .write_all(
                format!(
                    "data: {{\"id\":{id},\"type\":\"retained\",\"payload\":{{\"value\":{id}}}}}\n\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }
    socket.flush().await.unwrap();
}

#[tokio::test]
async fn truncated_live_connection_resumes_without_lost_or_duplicate_events()
-> Result<(), TestError> {
    butler_e2e::gate!();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let (reset, reset_requested) = tokio::sync::oneshot::channel();
    let peer = Peer::serve(move |listener| async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let line = request(&mut first).await;
        observed.lock().unwrap().push(line);
        write_events(&mut first, &[1]).await;
        reset_requested.await.unwrap();
        // Drop before Content-Length is satisfied: reqwest must see a body error.
        drop(first);
        let (mut resumed, _) = listener.accept().await.unwrap();
        let line = request(&mut resumed).await;
        observed.lock().unwrap().push(line);
        write_events(&mut resumed, &[1, 2, 3]).await;
        std::future::pending::<()>().await;
    })
    .await?;
    let client = peer.client().await?;
    let mut live = client.live_events(0);
    let first = tokio::time::timeout(Duration::from_secs(5), live.next())
        .await?
        .unwrap()?;
    assert_eq!(first.cursor, Some(1));
    reset.send(()).unwrap();
    let began = std::time::Instant::now();
    let later = tokio::time::timeout(Duration::from_secs(5), async {
        let second = live.next().await.unwrap().unwrap();
        let third = live.next().await.unwrap().unwrap();
        [second, third]
    })
    .await?;
    assert_eq!(
        [first.cursor, later[0].cursor, later[1].cursor],
        [Some(1), Some(2), Some(3)]
    );
    for event in [first, later[0].clone(), later[1].clone()] {
        assert_eq!(event.raw["payload"]["value"].as_u64(), event.cursor);
    }
    assert!(began.elapsed() >= Duration::from_millis(100));
    assert_eq!(
        *requests.lock().unwrap(),
        [
            "GET /events/live?cursor=0 HTTP/1.1",
            "GET /events/live?cursor=1 HTTP/1.1"
        ]
    );
    eprintln!("SHELL truncated TCP resume {:?}", began.elapsed());
    Ok(())
}
