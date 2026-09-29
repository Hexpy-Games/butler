//! The system zoneinfo directories: `/usr/share/zoneinfo`, and macOS's own
//! copy.

use std::io;
use std::path::Path;

const ROOTS: [&str; 2] = ["/usr/share/zoneinfo", "/var/db/timezone/zoneinfo"];

pub(super) fn zone_rules(name: &str) -> io::Result<Vec<u8>> {
    let mut last = None;
    for root in ROOTS {
        match std::fs::read(Path::new(root).join(name)) {
            Ok(bytes) => return Ok(bytes),
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| io::ErrorKind::NotFound.into()))
}
