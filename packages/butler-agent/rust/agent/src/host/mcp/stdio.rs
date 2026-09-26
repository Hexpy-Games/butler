//! Nonblocking stdio transport so runtime shutdown never waits on a stdin worker.

use std::{
    fs::File,
    io::{self, Read, Write},
    pin::Pin,
    task::{Context, Poll},
};

use nix::fcntl::{FcntlArg, OFlag, fcntl};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, unix::AsyncFd};

pub(super) struct NonblockingStdio {
    input: AsyncFd<File>,
    output: AsyncFd<File>,
}

impl NonblockingStdio {
    pub(super) fn new() -> io::Result<Self> {
        Ok(Self {
            input: nonblocking_fd(std::io::stdin())?,
            output: nonblocking_fd(std::io::stdout())?,
        })
    }
}

fn nonblocking_fd(fd: impl std::os::fd::AsFd) -> io::Result<AsyncFd<File>> {
    let duplicate = nix::unistd::dup(fd).map_err(|error| io::Error::other(error.to_string()))?;
    let file = File::from(duplicate);
    let flags = fcntl(&file, FcntlArg::F_GETFL)
        .map(OFlag::from_bits_truncate)
        .map_err(|error| io::Error::other(error.to_string()))?;
    fcntl(&file, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))
        .map_err(|error| io::Error::other(error.to_string()))?;
    AsyncFd::new(file)
}

impl AsyncRead for NonblockingStdio {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            let mut readiness = match this.input.poll_read_ready(context) {
                Poll::Ready(Ok(readiness)) => readiness,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            };
            match readiness.try_io(|fd| {
                let mut file = fd.get_ref();
                file.read(buffer.initialize_unfilled())
            }) {
                Ok(Ok(read)) => {
                    buffer.advance(read);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => continue,
            }
        }
    }
}

impl AsyncWrite for NonblockingStdio {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        loop {
            let mut readiness = match this.output.poll_write_ready(context) {
                Poll::Ready(Ok(readiness)) => readiness,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            };
            match readiness.try_io(|fd| {
                let mut file = fd.get_ref();
                file.write(buffer)
            }) {
                Ok(result) => return Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut file = self.get_mut().output.get_ref();
        Poll::Ready(file.flush())
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(context)
    }
}
