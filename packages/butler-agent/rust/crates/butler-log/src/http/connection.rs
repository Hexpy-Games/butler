//! Opaque TCP egress: metadata only, with no inspection or storage of payloads.
use super::Purpose;
use crate::Record;
use serde_json::json;
use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};

#[derive(Default)]
struct Counts {
    up: AtomicU64,
    down: AtomicU64,
}

/// One record per connection, including failed admission and cancellation.
/// Create inside the owning span before resolution; drop after all I/O stops.
pub struct Connection {
    row: Record,
    start: Instant,
    counts: Arc<Counts>,
    connected: AtomicBool,
}
impl Connection {
    pub fn new(host: &str, port: u16, purpose: &Purpose) -> Self {
        let mut row = Record::new(
            "DEBUG",
            &purpose.category,
            "http.connection",
            "HTTP connection",
        );
        crate::structured_logging::current_ids(&mut row);
        // Reject authority delimiters rather than allowing a caller to log a URL.
        let host = url::Host::parse(host).ok().map(|host| host.to_string());
        row.attrs = json!({"host":host,"port":port,"purpose":purpose.name,"outcome":"cancelled"});
        Self {
            row,
            start: Instant::now(),
            counts: Arc::default(),
            connected: AtomicBool::new(false),
        }
    }

    /// Connect only to caller-validated addresses, retaining DNS rebinding guards.
    pub async fn connect(
        &self,
        addresses: &[SocketAddr],
        timeout: Duration,
    ) -> io::Result<ConnectionStream> {
        super::logging::ensure().await;
        if self.row.attrs["host"].is_null() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let mut last = io::Error::from(io::ErrorKind::AddrNotAvailable);
        for address in addresses {
            match tokio::time::timeout(timeout, TcpStream::connect(address)).await {
                Ok(Ok(inner)) => {
                    self.connected.store(true, Ordering::Relaxed);
                    return Ok(ConnectionStream {
                        inner,
                        counts: self.counts.clone(),
                    });
                }
                Ok(Err(error)) => last = error,
                Err(_) => last = io::ErrorKind::TimedOut.into(),
            }
        }
        Err(last)
    }

    /// Errors retain only their kind, never remote data, paths or credentials.
    pub fn finish(mut self, result: io::Result<()>) {
        match result {
            Ok(()) => {
                self.row.level = "DEBUG".into();
                self.row.attrs["outcome"] = json!("completed");
            }
            Err(error) => {
                self.row.level = if self.connected.load(Ordering::Relaxed) {
                    "DEBUG"
                } else if error.kind() == io::ErrorKind::PermissionDenied {
                    "ERROR"
                } else {
                    "WARN"
                }
                .into();
                self.row.attrs["outcome"] = json!("error");
                self.row.error = Some(json!({"kind":format!("{:?}", error.kind())}));
            }
        }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.row.duration_ms = Some(self.start.elapsed().as_secs_f64() * 1000.0);
        self.row.attrs["bytes_up"] = json!(self.counts.up.load(Ordering::Relaxed));
        self.row.attrs["bytes_down"] = json!(self.counts.down.load(Ordering::Relaxed));
        crate::emit(self.row.clone());
    }
}

/// Counts bytes at the socket boundary, including partial I/O and buffered heads.
pub struct ConnectionStream {
    inner: TcpStream,
    counts: Arc<Counts>,
}
impl AsyncRead for ConnectionStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buffer);
        self.counts
            .down
            .fetch_add((buffer.filled().len() - before) as u64, Ordering::Relaxed);
        result
    }
}
impl AsyncWrite for ConnectionStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, bytes);
        if let Poll::Ready(Ok(size)) = result {
            self.counts.up.fetch_add(size as u64, Ordering::Relaxed);
        }
        result
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write_vectored(cx, bytes);
        if let Poll::Ready(Ok(size)) = result {
            self.counts.up.fetch_add(size as u64, Ordering::Relaxed);
        }
        result
    }
    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
