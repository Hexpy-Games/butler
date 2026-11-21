//! Keep the release archive and unpacked versions in the scenario sandbox.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn versions_on_disk(home: &Path, sandbox_root: &Path) -> io::Result<PathBuf> {
    let remote = home.join(".butler-remote");
    fs::create_dir(&remote)?;
    let versions = sandbox_root.join(format!("remote-versions-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&versions)?;
    butler_platform::secure_fs::symlink(&versions, &remote.join("versions"))?;
    Ok(versions)
}
