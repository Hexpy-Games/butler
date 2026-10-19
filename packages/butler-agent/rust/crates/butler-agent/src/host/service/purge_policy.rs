//! One refusal policy for uninstall purge and full reset.
use butler_platform::{secure_fs::Canonical as _, user_dirs};
use std::{fs, path::Path};
const DATA_MARKERS: [&str; 4] = ["butler.config.json", "state", "agent-runtime", "config"];
pub(crate) fn allowed(
    path: &Path,
    requested: &Path,
    agent_home: &Path,
) -> Result<(), &'static str> {
    if fs::symlink_metadata(requested).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("the data folder is a symbolic link");
    }
    let populated = fs::read_dir(path).is_ok_and(|mut e| e.next().is_some());
    if populated && !DATA_MARKERS.iter().any(|m| path.join(m).exists()) {
        return Err("the folder does not look like a Butler data folder");
    }
    let home = user_dirs::home_dir().and_then(|p| p.canonical().ok());
    let overlaps_home = home
        .as_ref()
        .is_some_and(|h| path == h || h.starts_with(path));
    let overlaps_agent = agent_home
        .canonical()
        .is_ok_and(|a| path.starts_with(&a) || a.starts_with(path));
    if overlaps_home || overlaps_agent || user_dirs::is_system_folder(path) {
        return Err("the data folder is not a folder Butler may delete");
    }
    Ok(())
}
