//! CreateProcess rejects a working directory beyond MAX_PATH. Use existing
//! short names without creating aliases or changing volume/system settings.
use std::{
    io,
    os::windows::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
};

const MAX_PATH: usize = 260;

pub(crate) fn working_directory(path: &Path) -> io::Result<PathBuf> {
    if path.as_os_str().encode_wide().count() < MAX_PATH {
        return Ok(dunce::simplified(path).to_path_buf());
    }
    let mut original = PathBuf::new();
    let mut short = PathBuf::new();
    for component in path.components() {
        original.push(component);
        if let Component::Normal(name) = component {
            let mut data = winsafe::WIN32_FIND_DATA::default();
            let text = original
                .to_str()
                .ok_or_else(|| io::Error::other("Invalid directory encoding"))?;
            let (_handle, found) = winsafe::HFINDFILE::FindFirstFile(text, &mut data)
                .map_err(|error| io::Error::other(error.to_string()))?;
            if !found {
                return Err(io::ErrorKind::NotFound.into());
            }
            let alias = data.cAlternateFileName();
            short.push(if alias.is_empty() {
                name
            } else {
                std::ffi::OsStr::new(&alias)
            });
        } else {
            short.push(component);
        }
    }
    let short = dunce::simplified(&short).to_path_buf();
    if short.as_os_str().encode_wide().count() >= MAX_PATH {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "This Windows directory has no usable short name. Choose a shorter project folder for commands.",
        ));
    }
    if !same_file::is_same_file(path, &short)? {
        return Err(io::Error::other("The command directory identity changed"));
    }
    Ok(short)
}
