//! SIGTERM and SIGINT as quit requests.
//!
//! CEF's start-up installs its own handlers for both, and a handler chained after them (as tokio's
//! signal support does) lets Chromium's shutdown run beside ours: it kills the browser before our
//! quit has flushed it. `install` replaces them instead. The handler only writes one byte to a
//! pipe, which is async-signal-safe; a thread reads the pipe and calls the callback.

/// Calls `on_request` on a thread of its own for every SIGTERM or SIGINT this process receives from
/// now on, replacing the handlers installed so far (CEF's included): call it after CEF started.
/// Does nothing on Windows, which has no SIGTERM. Only the first call in a process has an effect.
#[cfg(unix)]
pub fn install(on_request: impl Fn() + Send + 'static) -> std::io::Result<()> {
    use std::ffi::c_int;
    use std::fs::File;
    use std::io::{self, Read as _};
    use std::os::fd::{AsRawFd as _, BorrowedFd};
    use std::sync::atomic::{AtomicI32, Ordering};

    use nix::errno::Errno;
    use nix::fcntl::{FcntlArg, FdFlag, OFlag, fcntl};
    use nix::sys::signal::{SaFlags, SigAction, SigHandler, SigSet, Signal, sigaction};
    use nix::unistd::{pipe, write};

    static WRITE_END: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn request(_: c_int) {
        let errno = Errno::last_raw();
        let fd = WRITE_END.load(Ordering::Relaxed);
        if fd >= 0 {
            // SAFETY: the write end is stored once, below, and is never closed.
            #[allow(unsafe_code, reason = "the descriptor outlives the process; see SAFETY")]
            let end = unsafe { BorrowedFd::borrow_raw(fd) };
            let _ = write(end, &[1]);
        }
        Errno::set_raw(errno);
    }

    let (read_end, write_end) = pipe()?;
    fcntl(&read_end, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC))?;
    fcntl(&write_end, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC))?;
    // A full pipe already holds a request; the handler must never block.
    fcntl(&write_end, FcntlArg::F_SETFL(OFlag::O_NONBLOCK))?;
    if WRITE_END
        .compare_exchange(-1, write_end.as_raw_fd(), Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }
    // The write end is read by the handler for the rest of the process.
    std::mem::forget(write_end);
    let mut pipe = File::from(read_end);
    std::thread::Builder::new()
        .name("butler-quit-signals".to_owned())
        .spawn(move || {
            let mut byte = [0u8; 1];
            loop {
                match pipe.read(&mut byte) {
                    Ok(1) => on_request(),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    _ => return,
                }
            }
        })?;
    let action = SigAction::new(SigHandler::Handler(request), SaFlags::SA_RESTART, SigSet::empty());
    for signal in [Signal::SIGTERM, Signal::SIGINT] {
        // SAFETY: `request` only reads an atomic and calls `write` and the errno accessors.
        #[allow(unsafe_code, reason = "installing the handler; see SAFETY")]
        unsafe {
            sigaction(signal, &action)?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn install(_on_request: impl Fn() + Send + 'static) -> std::io::Result<()> {
    Ok(())
}
