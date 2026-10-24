//! The mark the system puts on a file downloaded from the internet, so the
//! app that opens it treats it as untrusted (Office: Protected View).
//!
//! macOS sets the `com.apple.quarantine` extended attribute; Windows writes
//! the Mark-of-the-Web (`Zone.Identifier` stream, Internet zone). Other
//! systems have no such mark and report `Unsupported`, so a caller that
//! needs the mark refuses instead of opening an unmarked file.
use std::{io, path::Path};

#[cfg(target_os = "macos")]
const QUARANTINE: &str = "com.apple.quarantine";
#[cfg(windows)]
const ZONE_STREAM: &str = ":Zone.Identifier";
#[cfg(windows)]
const INTERNET_ZONE: &str = "[ZoneTransfer]\r\nZoneId=3\r\n";

/// Whether this system has a downloaded-file mark.
pub fn supported() -> bool {
    cfg!(any(target_os = "macos", windows))
}

/// Marks the regular file at `path` as downloaded from the internet.
pub fn mark(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        // flags (downloaded, not yet approved); time; the downloading agent.
        let value = format!("0081;{seconds:08x};Butler;");
        rustix::fs::setxattr(
            path,
            QUARANTINE,
            value.as_bytes(),
            rustix::fs::XattrFlags::empty(),
        )
        .map_err(io::Error::from)
    }
    #[cfg(windows)]
    {
        std::fs::write(zone_stream(path), INTERNET_ZONE)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "this system has no downloaded-file mark",
        ))
    }
}

/// Whether the file at `path` carries the mark [`mark`] sets.
pub fn is_marked(path: &Path) -> io::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let mut value = [0_u8; 256];
        match rustix::fs::getxattr(path, QUARANTINE, &mut value[..]) {
            Ok(length) => Ok(value
                .get(..length)
                .is_some_and(|value| value.starts_with(b"0081;"))),
            Err(rustix::io::Errno::NOATTR) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    #[cfg(windows)]
    {
        match std::fs::read_to_string(zone_stream(path)) {
            Ok(text) => Ok(text.lines().any(|line| line.trim() == "ZoneId=3")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        Ok(false)
    }
}

#[cfg(windows)]
fn zone_stream(path: &Path) -> std::path::PathBuf {
    let mut stream = path.as_os_str().to_owned();
    stream.push(ZONE_STREAM);
    stream.into()
}
