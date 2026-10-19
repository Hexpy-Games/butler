//! One cached credential policy for sandboxing and unsandboxed file readers.
mod credentials;
#[cfg(unix)]
mod hard_links;
use super::{self as secure_fs, FileId};
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use credentials::roots as credential_roots;
pub use credentials::secret_name;
#[cfg(target_os = "macos")]
pub(crate) use credentials::secret_pattern;
use std::{
    collections::{HashMap, HashSet},
    fs::Metadata,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

/// Credential paths and inode identities shared for a data directory.
#[derive(Debug)]
pub struct SecretInventory {
    paths: Vec<PathBuf>,
    identities: HashSet<FileId>,
    roots: Mutex<HashMap<PathBuf, (FileId, std::fs::File)>>,
    #[cfg(unix)]
    hard_links: Mutex<hard_links::Cache>,
}

impl SecretInventory {
    /// Capture the credential policy from the host environment. No tree walk is
    /// performed. Call on a blocking worker, before admitting untrusted readers.
    pub fn new(data: &Path, environment: &HashMap<String, String>) -> Self {
        let mut environment = environment.clone();
        environment.insert("BUTLER_DATA".into(), data.to_string_lossy().into_owned());
        let paths = credentials::roots(&environment);
        let identities = paths
            .iter()
            .filter_map(|path| {
                std::fs::metadata(path)
                    .ok()
                    .and_then(|metadata| secure_fs::identity(&metadata).id)
            })
            .collect();
        Self {
            paths,
            identities,
            roots: Mutex::new(HashMap::new()),
            #[cfg(unix)]
            hard_links: Mutex::default(),
        }
    }

    /// Reuse one inventory for the same credential policy and data directory.
    /// Call on a blocking worker. Environment values are never logged.
    pub fn cached(data: &Path) -> Arc<Self> {
        let mut cache = cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache
            .entry(data.to_path_buf())
            .or_insert_with(|| Arc::new(Self::new(data, &std::env::vars().collect())))
            .clone()
    }

    /// Bind a data directory to the session's host credential policy. An
    /// existing binding is reused; a command cannot replace session policy.
    pub fn for_environment(data: &Path, environment: &HashMap<String, String>) -> Arc<Self> {
        let mut cache = cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache
            .entry(data.to_path_buf())
            .or_insert_with(|| Arc::new(Self::new(data, environment)))
            .clone()
    }

    /// The shared credential roots, including absent stores.
    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }

    /// Whether a lexical or resolved path is in a credential store.
    pub fn protects_path(&self, path: &Path) -> bool {
        self.paths
            .iter()
            .any(|root| secure_fs::path_is_within(path, root))
    }

    /// Whether an opened object is a recorded credential root.
    pub fn protects_metadata(&self, metadata: &Metadata) -> bool {
        secure_fs::identity(metadata)
            .id
            .is_some_and(|id| self.identities.contains(&id))
    }

    /// Pin a session root before a command can replace it. Repeated calls verify
    /// the original identity; a replacement never silently becomes a new root.
    pub fn pin_root(&self, root: &Path) -> io::Result<()> {
        let file = secure_fs::open_directory_no_follow(root)?;
        self.verify_root(root, &file, &file.metadata()?)
    }

    #[cfg(unix)]
    pub(super) fn permits_hard_link(&self, metadata: &Metadata) -> bool {
        let Some(id) = secure_fs::identity(metadata).id else {
            return false;
        };
        self.hard_links
            .lock()
            .is_ok_and(|mut cache| cache.permits(&self.paths, id))
    }

    pub(crate) fn verify_root(
        &self,
        root: &Path,
        file: &std::fs::File,
        metadata: &Metadata,
    ) -> io::Result<()> {
        if self.protects_path(root) || self.protects_metadata(metadata) {
            return Err(denied());
        }
        if let Some(id) = secure_fs::identity(metadata).id {
            let mut roots = self.roots.lock().map_err(|_| denied())?;
            if let Some((recorded, _)) = roots.get(root) {
                if *recorded != id {
                    return Err(denied());
                }
            } else {
                roots.insert(root.to_path_buf(), (id, file.try_clone()?));
            }
        }
        Ok(())
    }
}

pub(crate) fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "contained_read_refused")
}

/// Data root selected by the host environment, for APIs without a session binding.
pub fn environment_data() -> PathBuf {
    std::env::var_os("BUTLER_DATA")
        .map(PathBuf::from)
        .or_else(|| crate::user_dirs::home_dir().map(|home| home.join(".butler")))
        .unwrap_or_default()
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Arc<SecretInventory>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<SecretInventory>>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}
