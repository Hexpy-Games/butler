//! Device identity without traversing symbolic links.
use std::{fs, io, path::Path};
/// Whether renaming `child` into `root` stays on one filesystem; links use their own device.
pub fn same_device(root: &Path, child: &Path) -> io::Result<bool> {
    let metadata = fs::symlink_metadata(child)?;
    #[cfg(unix)]
    {
        let a = super::identity(&fs::metadata(root)?).id;
        let b = super::identity(&metadata).id;
        Ok(a.zip(b).is_some_and(|(a, b)| a.device == b.device))
    }
    #[cfg(windows)]
    {
        // A link itself is renamed on its parent's volume.
        let path = if metadata.file_type().is_symlink() {
            child
                .parent()
                .ok_or_else(|| io::Error::other("Missing link parent"))?
        } else {
            child
        };
        let volume = |path: &Path| -> io::Result<u64> {
            let handle = same_file::Handle::from_path(path)?;
            winapi_util::file::information(handle.as_file()).map(|i| i.volume_serial_number())
        };
        Ok(volume(root)? == volume(path)?)
    }
}
