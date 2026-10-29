//! This process's diagnostic output and async stdio protocol transport.
//!
//! Reading never occupies a runtime worker, so shutting the runtime down
//! never waits for input that may never come: Unix reads non-blocking
//! duplicates of both descriptors on the Tokio reactor; Windows reads stdin
//! on a detached thread of its own and writes through Tokio's stdout.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// stdin (read) and stdout (write) of this process.
#[derive(Debug)]
pub struct ProcessStdio(sys::ProcessStdio);

impl ProcessStdio {
    /// Takes over stdin and stdout. Must be called within a Tokio runtime.
    pub fn new() -> io::Result<Self> {
        sys::ProcessStdio::new().map(Self)
    }
}

impl AsyncRead for ProcessStdio {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(context, buffer)
    }
}

impl AsyncWrite for ProcessStdio {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(context, buffer)
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(context)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(context)
    }
}

/// Writes a complete diagnostic line with one stderr write. Format before
/// locking stderr: formatted writes otherwise issue a write per argument and
/// literal, multiplying file I/O and lock contention on diagnostic-heavy paths.
/// No lines or fields are dropped, and no background writer is kept alive.
pub fn diagnostic_line(arguments: std::fmt::Arguments<'_>) {
    let mut line = std::fmt::format(arguments);
    line.push('\n');
    eprint!("{line}");
}
