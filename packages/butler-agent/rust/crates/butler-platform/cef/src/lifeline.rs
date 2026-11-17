//! The Agent holds the only write end of the DevTools pipe, so a hangup on
//! descriptor 3 means the Agent is gone. On Linux CEF's message loop keeps
//! running after Chromium notices that, so the host ends itself (and its group,
//! when it leads one). macOS, Windows (Job Object) and Chrome's headless shell
//! end by their own means (measured, #2249 follow-up).

use std::os::fd::BorrowedFd;

use rustix::event::{PollFd, PollFlags, poll};
use rustix::io::{Errno, fcntl_dupfd_cloexec};
use rustix::process::{Signal, getpgrp, getpid, kill_current_process_group, kill_process};

/// The descriptor Chromium reads DevTools commands from (`--remote-debugging-pipe`).
const DEVTOOLS_IN: i32 = 3;

/// Kills the host once the Agent's end of the DevTools pipe hangs up: its whole process group when it
/// leads one, only itself otherwise.
/// Without a pipe to duplicate or a thread to watch it, nothing is started.
pub(crate) fn watch() {
    // SAFETY: the launcher opens descriptor 3 for every host started with
    // `--remote-debugging-pipe`; nothing in this process closes it before Chromium
    // starts, and the borrow ends with the duplicate below.
    #[allow(
        unsafe_code,
        reason = "borrowing the inherited DevTools descriptor; see SAFETY"
    )]
    let inherited = unsafe { BorrowedFd::borrow_raw(DEVTOOLS_IN) };
    // Chromium may close its own descriptor 3; the duplicate keeps the hangup visible.
    let Ok(pipe) = fcntl_dupfd_cloexec(inherited, 0) else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("butler-lifeline".to_owned())
        .spawn(move || {
            let mut fds = [PollFd::new(&pipe, PollFlags::empty())];
            loop {
                match poll(&mut fds, None) {
                    Ok(_)
                        if fds[0]
                            .revents()
                            .intersects(PollFlags::HUP | PollFlags::ERR | PollFlags::NVAL) =>
                    {
                        break;
                    }
                    Ok(_) | Err(Errno::INTR) => {}
                    Err(_) => return,
                }
            }
            // The Agent starts the browser as the leader of its own group, so that group is the
            // browser's tree. Started any other way, the group may hold unrelated processes.
            if getpgrp() == getpid() {
                let _ = kill_current_process_group(Signal::KILL);
            } else {
                let _ = kill_process(getpid(), Signal::KILL);
            }
        });
}
