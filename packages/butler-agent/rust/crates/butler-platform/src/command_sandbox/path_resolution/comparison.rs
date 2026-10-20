//! Compare lexical paths using the credential volume's actual lookup behavior.
use std::path::Path;

pub(super) fn within(path: &Path, root: &Path) -> bool {
    if crate::secure_fs::path_is_within(path, root) {
        return true;
    }
    insensitive(root)
        && Path::new(&path.to_string_lossy().to_lowercase())
            .starts_with(Path::new(&root.to_string_lossy().to_lowercase()))
}

pub(super) fn insensitive(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    return volume_case::insensitive(path);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        cfg!(windows)
    }
}

#[cfg(target_os = "macos")]
mod volume_case {
    use std::{
        collections::HashMap,
        os::unix::fs::MetadataExt,
        path::Path,
        sync::{Mutex, OnceLock},
    };

    static VOLUMES: OnceLock<Mutex<HashMap<u64, bool>>> = OnceLock::new();

    pub(super) fn insensitive(path: &Path) -> bool {
        let Some((existing, metadata)) = path
            .ancestors()
            .find_map(|path| std::fs::metadata(path).ok().map(|meta| (path, meta)))
        else {
            return true;
        };
        let device = metadata.dev();
        let cache = VOLUMES.get_or_init(Mutex::default);
        if let Ok(cache) = cache.lock()
            && let Some(result) = cache.get(&device)
        {
            return *result;
        }
        let result = probe(existing, device);
        if let Ok(mut cache) = cache.lock() {
            cache.insert(device, result);
        }
        result
    }

    // A read-only lookup probe avoids unsafe FFI and external processes. Compare
    // inode identities after toggling a real component, only on this volume.
    // Failure to query retains conservative case-insensitive protection.
    fn probe(path: &Path, device: u64) -> bool {
        for entry in path.ancestors() {
            let Ok(metadata) = std::fs::symlink_metadata(entry) else {
                continue;
            };
            if metadata.dev() != device {
                break;
            }
            if !metadata.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some((index, ch)) = name.char_indices().find(|(_, ch)| ch.is_ascii_alphabetic())
            else {
                continue;
            };
            let mut alternate = name.to_owned();
            let flipped = if ch.is_ascii_uppercase() {
                ch.to_ascii_lowercase()
            } else {
                ch.to_ascii_uppercase()
            };
            alternate.replace_range(index..=index, &flipped.to_string());
            match std::fs::symlink_metadata(entry.with_file_name(alternate)) {
                Ok(other) => return other.dev() == device && other.ino() == metadata.ino(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
                Err(_) => {}
            }
        }
        true
    }
}
