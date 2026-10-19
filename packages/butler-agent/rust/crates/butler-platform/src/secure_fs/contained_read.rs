//! Anchor every path component to an open directory, refusing symlinks.
use std::{
    fs::File,
    io,
    path::{Component, Path},
};

pub(super) fn open(root: &Path, relative: &Path, write: bool) -> io::Result<File> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(io::Error::other("unsafe_output_path"));
    }
    open_components(root, relative, write)
}
#[cfg(unix)]
fn open_components(root: &Path, relative: &Path, write: bool) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags, open, openat};
    let mut directory = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let mut flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
        if components.peek().is_some() {
            flags |= OFlags::DIRECTORY;
        }
        if write && components.peek().is_none() {
            flags.remove(OFlags::RDONLY);
            flags |= OFlags::WRONLY;
        }
        directory = openat(
            &directory,
            Path::new(component.as_os_str()),
            flags,
            Mode::empty(),
        )?;
    }
    let file = File::from(directory);
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("output_regular_files_only"));
    }
    Ok(file)
}
#[cfg(windows)]
fn open_components(root: &Path, relative: &Path, write: bool) -> io::Result<File> {
    // Hold every ancestor without write/delete sharing until the final file
    // is open. Windows file IDs are unavailable; metadata comparisons cannot
    // fence a parent swap. OPEN_REPARSE_POINT inspects the entry itself.
    let mut guards = Vec::new();
    for parent in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
        guards.push(windows_guard(parent, true, false)?);
    }
    let mut path = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        path.push(component);
        let directory = components.peek().is_some();
        let file = windows_guard(&path, directory, write && !directory)?;
        if !directory {
            return Ok(file);
        }
        guards.push(file);
    }
    Err(io::Error::other("unsafe_output_path"))
}
#[cfg(windows)]
pub(super) fn windows_guard(path: &Path, directory: bool, write: bool) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let mut options = std::fs::OpenOptions::new();
    options
        .read(!write)
        .write(write)
        .share_mode(if write { 7 } else { 1 })
        .custom_flags(0x0220_0000);
    if directory {
        options.access_mode(0);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if metadata.file_attributes() & 0x400 != 0
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(io::Error::other("output_regular_files_only"));
    }
    Ok(file)
}

/// Open a contained regular file using the shared credential policy. Unix
/// follows only links that remain under the pinned root. Windows retains the
/// existing no-reparse-point component checks.
pub fn open_contained(
    root: &Path,
    relative: &Path,
    inventory: &crate::secure_fs::SecretInventory,
) -> io::Result<File> {
    #[cfg(unix)]
    {
        super::contained::Cache::default().open(root, relative, inventory, &[])
    }
    #[cfg(windows)]
    {
        if relative
            .components()
            .any(|part| crate::secure_fs::secret_name(&part.as_os_str().to_string_lossy()))
            || inventory.protects_path(&root.join(relative))
        {
            return Err(crate::secure_fs::inventory::denied());
        }
        open(root, relative, false)
    }
}

/// Open a directory itself without following a final link. For pinning roots.
pub fn open_directory_no_follow(root: &Path) -> io::Result<File> {
    #[cfg(unix)]
    {
        super::contained::directory(root)
    }
    #[cfg(windows)]
    {
        windows_guard(root, true, false)
    }
}

/// Descriptor cache owned by a single multi-file request. Dropping it releases
/// all validated directories. Never retain it across commands or turns.
#[derive(Default)]
pub struct ContainedReadCache {
    policies: std::sync::Mutex<
        std::collections::HashMap<
            std::path::PathBuf,
            std::sync::Arc<crate::secure_fs::SecretInventory>,
        >,
    >,
    #[cfg(unix)]
    inner: std::sync::Mutex<super::contained::Cache>,
}
impl ContainedReadCache {
    /// Start another request with the same host policy and no directory fds.
    pub fn fresh(&self) -> Self {
        Self {
            policies: std::sync::Mutex::new(
                self.policies.lock().map(|p| p.clone()).unwrap_or_default(),
            ),
            ..Self::default()
        }
    }
    /// Use an explicitly supplied host policy for this request.
    pub fn with_inventory(
        data: &Path,
        inventory: std::sync::Arc<crate::secure_fs::SecretInventory>,
    ) -> Self {
        Self {
            policies: std::sync::Mutex::new(std::collections::HashMap::from([(
                data.to_path_buf(),
                inventory,
            )])),
            ..Self::default()
        }
    }
    /// Capture host policy once, off the per-file environment lookup path.
    pub fn open_for_data(
        &self,
        root: &Path,
        relative: &Path,
        data: &Path,
        protected: &[std::path::PathBuf],
    ) -> io::Result<File> {
        let inventory = self
            .policies
            .lock()
            .map_err(|_| crate::secure_fs::inventory::denied())?
            .entry(data.to_path_buf())
            .or_insert_with(|| crate::secure_fs::SecretInventory::cached(data))
            .clone();
        self.open_protected(root, relative, &inventory, protected)
    }

    /// Read a fresh leaf through this request's validated parent descriptors.
    pub fn open(
        &self,
        root: &Path,
        relative: &Path,
        inventory: &crate::secure_fs::SecretInventory,
    ) -> io::Result<File> {
        self.open_protected(root, relative, inventory, &[])
    }
    /// Apply additional host-owned protected roots in the same descriptor walk.
    pub fn open_protected(
        &self,
        root: &Path,
        relative: &Path,
        inventory: &crate::secure_fs::SecretInventory,
        protected: &[std::path::PathBuf],
    ) -> io::Result<File> {
        #[cfg(unix)]
        {
            self.inner
                .lock()
                .map_err(|_| crate::secure_fs::inventory::denied())?
                .open(root, relative, inventory, protected)
        }
        #[cfg(windows)]
        {
            let _ = protected;
            open_contained(root, relative, inventory)
        }
    }
}
