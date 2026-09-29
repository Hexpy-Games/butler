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
