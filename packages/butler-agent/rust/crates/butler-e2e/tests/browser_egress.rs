//! Opaque browser connections through the real guard and shared HTTP boundary.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test crate TCP drivers"
)]
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_log::{Config, Logger, Query, Record};
use butler_runtime::browser::{ContentOrigin, EgressProxy};
use std::{io, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tracing::Instrument;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn logger() -> &'static Logger {
    static LOG: OnceLock<Logger> = OnceLock::new();
    LOG.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("egress-logs-{}", uuid::Uuid::new_v4()));
        let log = Logger::open(&root, Config::full()).unwrap();
        butler_log::install(log.clone()).unwrap();
        log
    })
}
async fn record() -> Record {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let rows = logger()
                .query(&Query {
                    category: Some("http.client".into()),
                    ..Query::default()
                })
                .unwrap()
                .rows;
            let mut rows = rows.into_iter().filter(|r| r.event == "http.connection");
            if let Some(row) = rows.next() {
                assert!(rows.next().is_none(), "one record per connection");
                assert_eq!(row.attrs["purpose"], "browser.egress");
                assert!(row.duration_ms.unwrap() > 0.0);
                assert!(row.content.is_none());
                assert!(row.body_ref.is_none());
                return row;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
async fn client(proxy: &EgressProxy, request: &[u8]) -> io::Result<Vec<u8>> {
    let url = url::Url::parse(&proxy.url()).unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", url.port().unwrap())).await?;
    stream.write_all(request).await?;
    stream.shutdown().await?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[tokio::test]
async fn connect_counts_opaque_bytes_and_preserves_span() -> io::Result<()> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().clear()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let payload = b"\x16\x03\x01\0\xffopaque /private-path?secret=query-value";
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut got = vec![0; payload.len()];
        stream.read_exact(&mut got).await.unwrap();
        assert_eq!(got, payload);
        stream.write_all(payload).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    let proxy = EgressProxy::start_preview(ContentOrigin(port)).instrument(tracing::info_span!(
        target: "butler.egress", "browser", trace_id="egress-trace", turn_id="egress-turn", chat_id="egress-chat", span_id="egress-span"
    )).await?;
    let mut request = format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n").into_bytes();
    request.extend_from_slice(payload);
    let response = client(&proxy, &request).await?;
    let mut expected = b"HTTP/1.1 200 Connection Established\r\n\r\n".to_vec();
    expected.extend_from_slice(payload);
    assert_eq!(response, expected);
    server.await.unwrap();
    let row = record().await;
    assert_eq!(row.level, "DEBUG");
    assert_eq!(row.attrs["host"], "127.0.0.1");
    assert_eq!(row.attrs["port"], port);
    assert_eq!(row.attrs["bytes_up"], payload.len());
    assert_eq!(row.attrs["bytes_down"], payload.len());
    assert_eq!(row.attrs["outcome"], "completed");
    assert_eq!(row.trace_id.as_deref(), Some("egress-trace"));
    assert_eq!(row.turn_id.as_deref(), Some("egress-turn"));
    assert_eq!(row.chat_id.as_deref(), Some("egress-chat"));
    assert_eq!(row.span_id.as_deref(), Some("egress-span"));
    assert!(
        !serde_json::to_string(&row)
            .unwrap()
            .contains("private-path")
    );
    Ok(())
}

#[tokio::test]
async fn forwarded_connection_logs_origin_only_and_exact_bytes() -> io::Result<()> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().clear()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(stream.read_u8().await.unwrap());
        }
        assert!(request.starts_with(b"GET /__o/private-path?secret=query-value HTTP/1.1\r\n"));
        stream.write_all(response).await.unwrap();
        stream.shutdown().await.unwrap();
        request.len()
    });
    let proxy = EgressProxy::start(Some(ContentOrigin(port))).await?;
    let response = client(&proxy, format!("GET http://127.0.0.1:{port}/__o/private-path?secret=query-value HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).await?;
    assert!(response.ends_with(b"\r\n\r\nhello"));
    let sent = server.await.unwrap();
    let row = record().await;
    assert_eq!(row.level, "DEBUG");
    assert_eq!(row.attrs["host"], "127.0.0.1");
    assert_eq!(row.attrs["port"], port);
    assert_eq!(row.attrs["bytes_up"], sent);
    assert_eq!(row.attrs["bytes_down"], 43);
    let serialized = serde_json::to_string(&row).unwrap();
    for secret in ["private-path", "query-value", "hello"] {
        assert!(!serialized.contains(secret));
    }
    Ok(())
}

#[tokio::test]
async fn denied_is_error_and_refused_connect_is_warn() -> io::Result<()> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().clear()?;
    let proxy = EgressProxy::start(None).await?;
    let response = client(&proxy, b"CONNECT 127.0.0.1:1 HTTP/1.1\r\n\r\n").await?;
    assert!(response.starts_with(b"HTTP/1.1 403"));
    let row = record().await;
    assert_eq!(row.level, "ERROR");
    assert_eq!(row.error.unwrap()["kind"], "PermissionDenied");
    assert_eq!(row.attrs["bytes_up"], 0);
    assert_eq!(row.attrs["bytes_down"], 0);
    logger().clear()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    let proxy = EgressProxy::start_preview(ContentOrigin(port)).await?;
    let response = client(
        &proxy,
        format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n").as_bytes(),
    )
    .await?;
    assert!(response.starts_with(b"HTTP/1.1 502"));
    let row = record().await;
    assert_eq!(row.level, "WARN");
    assert_eq!(row.error.unwrap()["kind"], "ConnectionRefused");
    Ok(())
}

#[tokio::test]
async fn cancelled_tunnel_keeps_partial_counts() -> io::Result<()> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().await;
    logger().clear()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let proxy = EgressProxy::start_preview(ContentOrigin(port)).await?;
    let url = url::Url::parse(&proxy.url()).unwrap();
    let mut client = TcpStream::connect(("127.0.0.1", url.port().unwrap())).await?;
    client
        .write_all(format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\npartial").as_bytes())
        .await?;
    let (mut upstream, _) = listener.accept().await?;
    let mut got = [0; 7];
    upstream.read_exact(&mut got).await?;
    assert_eq!(&got, b"partial");
    drop(proxy);
    let row = record().await;
    assert_eq!(row.level, "DEBUG");
    assert_eq!(row.attrs["outcome"], "cancelled");
    assert_eq!(row.attrs["bytes_up"], 7);
    assert_eq!(row.attrs["bytes_down"], 0);
    Ok(())
}
