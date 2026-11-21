//! Local socket connection ownership and change-driven idle detection.

use std::{
    io,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::{Duration, Instant},
};

use butler_platform::local_socket::{self, LocalListener, LocalStream};
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;

/// The owner-only API listener and its idle exit policy.
#[derive(Clone)]
pub struct RemoteSocket {
    pub path: PathBuf,
    pub activity: Arc<SocketActivity>,
    pub idle: Duration,
}

/// Consistent connection count and idle time for a remote socket.
#[derive(Default)]
pub struct SocketActivity {
    state: Mutex<ActivityState>,
    closed: Notify,
}

struct ActivityState {
    open: usize,
    idle_since: Option<Instant>,
}

impl Default for ActivityState {
    fn default() -> Self {
        Self {
            open: 0,
            idle_since: Some(Instant::now()),
        }
    }
}

impl SocketActivity {
    /// How long the socket has had no open connection; None while one is open.
    /// One lock read, so the answer is consistent.
    pub fn idle_for(&self) -> Option<Duration> {
        self.state.lock().idle_since.map(|since| since.elapsed())
    }

    /// Wait until the socket has been continuously idle for `idle`.
    pub async fn idle_elapsed(&self, idle: Duration) {
        loop {
            let notified = self.closed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match self.idle_for() {
                None => notified.await,
                Some(waited) if waited >= idle => return,
                Some(waited) => tokio::time::sleep(idle.saturating_sub(waited)).await,
            }
        }
    }
}

pub(super) struct Counted {
    stream: LocalStream,
    activity: Arc<SocketActivity>,
}

impl Counted {
    fn new(stream: LocalStream, activity: Arc<SocketActivity>) -> Self {
        {
            let mut state = activity.state.lock();
            state.open += 1;
            state.idle_since = None;
        }
        Self { stream, activity }
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        {
            let mut state = self.activity.state.lock();
            state.open -= 1;
            if state.open == 0 {
                state.idle_since = Some(Instant::now());
            }
        }
        self.activity.closed.notify_waiters();
    }
}

impl AsyncRead for Counted {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Counted {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

pub(super) struct CountedListener {
    listener: LocalListener,
    activity: Arc<SocketActivity>,
}

impl CountedListener {
    pub(super) fn new(listener: LocalListener, activity: Arc<SocketActivity>) -> Self {
        activity.state.lock().idle_since = Some(Instant::now());
        Self { listener, activity }
    }
}

impl axum::serve::Listener for CountedListener {
    type Io = Counted;
    type Addr = ();

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match local_socket::accept(&self.listener).await {
                Ok(stream) => return (Counted::new(stream, self.activity.clone()), ()),
                Err(error) => {
                    butler_core::diagnostic!("[gateway] local socket accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(())
    }
}
