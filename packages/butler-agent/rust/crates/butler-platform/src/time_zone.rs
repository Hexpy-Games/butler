//! IANA time zone rules by name.
//!
//! Unix hosts keep the rules in a system directory (`/usr/share/zoneinfo`);
//! Windows has none, so it reads the baseline rules embedded in the
//! executable. Callers parse the compiled (TZif) bytes themselves.

use std::io;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// The baseline zone archive (`BTZ2`: a count, then per zone its name,
/// canonical name and TZif bytes, sorted by lower-case name), frozen from ICU
/// and embedded in the executable.
pub const BASELINE_ARCHIVE: &[u8] = include_bytes!("../data/source-2026c.btz");

/// The compiled (TZif) rules of the IANA zone `name` (such as
/// `Asia/Seoul`). The caller checks that `name` is a relative path without
/// `.` or `..` parts. A zone the host does not know is a
/// [`io::ErrorKind::NotFound`] error.
pub fn zone_rules(name: &str) -> io::Result<Vec<u8>> {
    sys::zone_rules(name)
}

/// Cheap identity of the process-local rules; inspect on a blocking thread.
#[derive(Clone, PartialEq)]
pub struct LocalZoneSource {
    /// IANA identifier, or the explicit TZ file name.
    pub name: String,
    file: Option<std::path::PathBuf>,
    modified: Option<std::time::SystemTime>,
    len: u64,
}
impl LocalZoneSource {
    /// Resolve TZ first, otherwise the host setting. Metadata detects TZif updates.
    pub fn current() -> io::Result<Self> {
        let (name, file) = match std::env::var("TZ") {
            Ok(value) if value.is_empty() => ("UTC".to_owned(), None),
            Ok(value) => {
                let name = value.strip_prefix(':').unwrap_or(&value).to_owned();
                let file = if std::path::Path::new(&name).is_absolute() {
                    Some(name.clone().into())
                } else {
                    if name.split('/').any(|part| matches!(part, "" | "." | "..")) {
                        return Err(io::ErrorKind::InvalidInput.into());
                    }
                    sys::zone_file(&name)
                };
                (name, file)
            }
            Err(_) => {
                let name = iana_time_zone::get_timezone().map_err(io::Error::other)?;
                let file = sys::local_zone_file(&name);
                (name, file)
            }
        };
        let metadata = file.as_ref().map(std::fs::metadata).transpose()?;
        Ok(Self {
            name,
            file,
            modified: metadata.as_ref().and_then(|m| m.modified().ok()),
            len: metadata.map_or(0, |m| m.len()),
        })
    }
    /// Read only after the source identity changed.
    pub fn rules(&self) -> io::Result<Vec<u8>> {
        match &self.file {
            Some(path) => std::fs::read(path),
            None => zone_rules(&self.name),
        }
    }
}
