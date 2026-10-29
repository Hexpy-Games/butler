//! Windows has no zoneinfo directory: the rules are the baseline archive that
//! the executable embeds.

use std::io;

pub(super) fn zone_rules(name: &str) -> io::Result<Vec<u8>> {
    super::baseline_zone_rules(name)
}

pub(super) fn zone_file(_name: &str) -> Option<std::path::PathBuf> {
    None
}

pub(super) fn local_zone_file(_name: &str) -> Option<std::path::PathBuf> {
    None
}
