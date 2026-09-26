//! Electron foreground ownership lease carried by the child's stdin pipe.

use std::{fs::File, io::Read};

use nix::fcntl::{FcntlArg, OFlag, fcntl};
use tokio::io::unix::AsyncFd;

pub(super) struct ForegroundLease {
    input: AsyncFd<File>,
}

impl ForegroundLease {
    pub(super) fn capture() -> Result<Self, String> {
        let descriptor = nix::unistd::dup(std::io::stdin())
            .map_err(|error| format!("foreground_lease_unavailable: {error}"))?;
        let file = File::from(descriptor);
        let flags = fcntl(&file, FcntlArg::F_GETFL)
            .map(OFlag::from_bits_truncate)
            .map_err(|error| format!("foreground_lease_unavailable: {error}"))?;
        fcntl(&file, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))
            .map_err(|error| format!("foreground_lease_unavailable: {error}"))?;
        let input =
            AsyncFd::new(file).map_err(|error| format!("foreground_lease_unavailable: {error}"))?;
        Ok(Self { input })
    }

    pub(super) async fn closed(&self) -> Result<(), String> {
        let mut byte = [0_u8; 1];
        loop {
            let mut readable = self
                .input
                .readable()
                .await
                .map_err(|error| format!("foreground_lease_failed: {error}"))?;
            match readable.try_io(|input| {
                let mut file = input.get_ref();
                file.read(&mut byte)
            }) {
                Ok(Ok(0)) => return Ok(()),
                Ok(Ok(_)) | Err(_) => continue,
                Ok(Err(error)) => return Err(format!("foreground_lease_failed: {error}")),
            }
        }
    }
}
