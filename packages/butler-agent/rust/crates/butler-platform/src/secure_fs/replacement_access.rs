//! Access required to distinguish a rename conflict from a permission denial.
use std::{fs::Metadata, io, path::Path};

pub(super) fn target_probe(metadata: io::Result<Metadata>, to: &Path) -> io::Result<(&Path, u32)> {
    match metadata {
        Ok(metadata) if metadata.is_file() && metadata.permissions().readonly() => {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        }
        // DELETE for an existing entry; FILE_ADD_FILE on the parent for creation.
        Ok(_) => Ok((to, 0x0001_0000)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok((to.parent().unwrap_or(Path::new(".")), 0x0000_0002))
        }
        Err(error) => Err(error),
    }
}
