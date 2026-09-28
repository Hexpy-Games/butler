//! Linux process identity from `/proc` and the boot id.

use std::fs;
use std::io;

use super::IdentityError;

pub(super) fn process_start_identity(pid: u32) -> Result<Option<String>, IdentityError> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(IdentityError::unavailable()),
    };
    // Fields after the parenthesized command name; the start time is field 22.
    let tail = stat
        .rfind(')')
        .and_then(|index| stat.get(index + 1..))
        .ok_or_else(IdentityError::unavailable)?;
    let start_ticks = tail
        .split_whitespace()
        .nth(19)
        .ok_or_else(IdentityError::unavailable)?;
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|source| {
        IdentityError::Unavailable {
            source: Some(source),
        }
    })?;
    Ok(Some(format!("linux:{}:{}", boot_id.trim(), start_ticks)))
}

pub(super) fn process_executable(pid: u32) -> Result<Option<String>, IdentityError> {
    match fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(IdentityError::unavailable()),
    }
}
