//! Processes that outlive the SSH session that started them.
//!
//! `Command::spawn` always passes every inheritable handle to the child, and an
//! SSH server waits for the handles of its session to close, so a service
//! started that way holds the session open. `CreateProcess` here passes none.

use crate::windows_command_line::quote_argument;
use std::ffi::OsStr;
use std::io;
use std::os::windows::process::ExitStatusExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus};

use winsafe::{co, guard::CloseHandlePiGuard};

/// A detached child: started by `Command::spawn`, or created here.
pub(crate) enum DetachedChild {
    /// Started by `Command::spawn`.
    Spawned(Child),
    /// Created by [`spawn_outliving_session`]. The guard closes the process
    /// and thread handles when dropped (winsafe has no safe way to close one
    /// of them alone); the child keeps running.
    Created(CloseHandlePiGuard),
}

pub(crate) fn detached(child: Child) -> DetachedChild {
    DetachedChild::Spawned(child)
}

impl DetachedChild {
    pub(crate) fn id(&self) -> u32 {
        match self {
            Self::Spawned(child) => child.id(),
            Self::Created(process) => process.dwProcessId,
        }
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self {
            Self::Spawned(child) => child.try_wait(),
            Self::Created(process) => exit_status(process, Some(0)),
        }
    }

    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        match self {
            Self::Spawned(child) => child.wait(),
            Self::Created(process) => exit_status(process, None)?
                .ok_or_else(|| io::Error::other("the process did not exit")),
        }
    }

    pub(crate) fn kill(&mut self) -> io::Result<()> {
        match self {
            Self::Spawned(child) => child.kill(),
            Self::Created(process) => match process.hProcess.TerminateProcess(1) {
                Ok(()) => Ok(()),
                // Like `Child::kill`: a process that already exited is not an error.
                Err(_) if exit_status(process, Some(0))?.is_some() => Ok(()),
                Err(error) => Err(os_error(error)),
            },
        }
    }
}

/// The exit status once the process has exited, waiting at most
/// `milliseconds` (`None`: until it exits).
fn exit_status(
    process: &CloseHandlePiGuard,
    milliseconds: Option<u32>,
) -> io::Result<Option<ExitStatus>> {
    let state = process
        .hProcess
        .WaitForSingleObject(milliseconds)
        .map_err(os_error)?;
    if state != co::WAIT::OBJECT_0 {
        return Ok(None);
    }
    let code = process.hProcess.GetExitCodeProcess().map_err(os_error)?;
    Ok(Some(ExitStatus::from_raw(code)))
}

pub(crate) fn spawn_outliving_session(command: &mut Command) -> io::Result<DetachedChild> {
    let program = Path::new(command.get_program());
    if !program.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the program must be an absolute path",
        ));
    }
    let program = text(program.as_os_str())?;
    let mut line = quote_argument(program);
    for argument in command.get_args() {
        line.push(' ');
        line.push_str(&quote_argument(text(argument)?));
    }
    let directory = command
        .get_current_dir()
        .map(|directory| text(directory.as_os_str()))
        .transpose()?;
    let flags = co::CREATE::DETACHED_PROCESS
        | co::CREATE::NEW_PROCESS_GROUP
        | co::CREATE::BREAKAWAY_FROM_JOB;
    let mut startup = winsafe::STARTUPINFO::default();
    winsafe::CreateProcess(
        Some(program),
        Some(&line),
        None,
        None,
        false,
        flags,
        // Empty: NULL, so the child inherits this environment. The facade
        // refuses env changes (winsafe would pass a freed block).
        &[],
        directory,
        &mut startup,
    )
    .map(DetachedChild::Created)
    .map_err(os_error)
}

fn text(value: &OsStr) -> io::Result<&str> {
    value.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "a command part is not valid Unicode",
        )
    })
}

fn os_error(error: co::ERROR) -> io::Error {
    io::Error::from_raw_os_error(i32::from_ne_bytes(error.raw().to_ne_bytes()))
}
