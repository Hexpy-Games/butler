//! Windows pipes and consoles have no readiness notification Tokio can wait
//! on, so a thread of its own reads stdin into a channel, and stdout is
//! Tokio's (writes run on the blocking pool and always complete). The reader
//! thread is detached: runtime shutdown never waits for it.

use std::io::{self, Read};
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, Stdout};
use tokio::sync::mpsc;

/// How many chunks the reader thread may read ahead of the consumer.
const READ_AHEAD: usize = 16;
const CHUNK: usize = 8192;

#[derive(Debug)]
pub(super) struct ProcessStdio {
    input: mpsc::Receiver<io::Result<Vec<u8>>>,
    /// The unread rest of the last chunk.
    pending: Vec<u8>,
    output: Stdout,
}

impl ProcessStdio {
    pub(super) fn new() -> io::Result<Self> {
        let (sender, input) = mpsc::channel(READ_AHEAD);
        std::thread::Builder::new()
            .name("butler-stdin".into())
            .spawn(move || read_stdin(&sender))?;
        Ok(Self {
            input,
            pending: Vec::new(),
            output: tokio::io::stdout(),
        })
    }
}

/// Sends stdin in chunks until it ends (an empty chunk), fails, or nobody
/// receives any more.
fn read_stdin(sender: &mpsc::Sender<io::Result<Vec<u8>>>) {
    let mut stdin = io::stdin().lock();
    let mut buffer = vec![0_u8; CHUNK];
    loop {
        let chunk = match stdin.read(&mut buffer) {
            Ok(read) => Ok(buffer.get(..read).unwrap_or_default().to_vec()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => Err(error),
        };
        let last = !matches!(&chunk, Ok(bytes) if !bytes.is_empty());
        if sender.blocking_send(chunk).is_err() || last {
            return;
        }
    }
}

impl AsyncRead for ProcessStdio {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.pending.is_empty() {
            match this.input.poll_recv(context) {
                Poll::Pending => return Poll::Pending,
                // The reader ended after the end of input or an error.
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
                Poll::Ready(Some(Ok(chunk))) => this.pending = chunk,
            }
        }
        let count = this.pending.len().min(buffer.remaining());
        buffer.put_slice(this.pending.get(..count).unwrap_or_default());
        this.pending.drain(..count);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for ProcessStdio {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().output).poll_write(context, buffer)
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().output).poll_flush(context)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().output).poll_shutdown(context)
    }
}
