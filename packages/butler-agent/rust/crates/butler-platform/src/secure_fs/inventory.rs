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
    sync::{Arc, Mutex, OnceLock, Weak},
};

type ResolvedRoots = HashMap<PathBuf, (Option<FileId>, PathBuf)>;

/// Credential paths and inode identities shared for a data directory.
#[derive(Debug)]
pub struct SecretInventory {
    paths: Arc<Vec<PathBuf>>,
    identities: Arc<Mutex<HashSet<FileId>>>,
    canonical: Arc<Mutex<ResolvedRoots>>,
    roots: Mutex<HashMap<PathBuf, Weak<RootPin>>>,
    leases: Option<Mutex<Vec<Arc<RootPin>>>>,
    #[cfg(unix)]
    hard_links: Arc<hard_links::Cache>,
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
            paths: Arc::new(paths),
            identities: Arc::new(Mutex::new(identities)),
            canonical: Arc::default(),
            roots: Mutex::new(HashMap::new()),
            leases: None,
            #[cfg(unix)]
            hard_links: Arc::default(),
        }
    }

    /// Share credential refreshes, but give each turn its own root identity fence.
    /// Overlapping turns may select different incarnations of the same path.
    pub fn for_turn(self: &Arc<Self>) -> Arc<Self> {
        Arc::new(Self {
            paths: self.paths.clone(),
            identities: self.identities.clone(),
            canonical: self.canonical.clone(),
            roots: Mutex::default(),
            leases: Some(Mutex::default()),
            #[cfg(unix)]
            hard_links: self.hard_links.clone(),
        })
    }

    /// Reuse one inventory for the same credential policy and data directory.
    /// Call on a blocking worker. Environment values are never logged.
    pub fn cached(data: &Path) -> Arc<Self> {
        Self::for_environment(
            data,
            &[
                "HOME",
                "CODEX_HOME",
                "CODEX_AUTH_JSON",
                "BUTLER_CODEX_AUTH_PROFILE",
                "BUTLER_OPENAI_AUTH_PROFILE",
            ]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
            .collect(),
        )
    }

    /// Reuse only an identical credential policy; one caller cannot select the
    /// policy used by another environment sharing the same data directory.
    pub fn for_environment(data: &Path, environment: &HashMap<String, String>) -> Arc<Self> {
        let mut environment = environment.clone();
        environment.insert("BUTLER_DATA".into(), data.to_string_lossy().into_owned());
        let key = credentials::roots(&environment);
        let mut cache = cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache
            .entry(key)
            .or_insert_with(|| Arc::new(Self::new(data, &environment)))
            .clone()
    }

    /// Refresh at request/turn admission, never for every path component.
    /// Retain old identities too: renaming a credential store does not unprotect it.
    pub fn refresh(&self) {
        if let (Ok(mut identities), Ok(mut canonical)) =
            (self.identities.lock(), self.canonical.lock())
        {
            for path in self.paths.iter() {
                let id = std::fs::metadata(path)
                    .ok()
                    .and_then(|metadata| secure_fs::identity(&metadata).id);
                if let Some(id) = id {
                    identities.insert(id);
                }
                if canonical
                    .get(path)
                    .is_none_or(|(previous, _)| *previous != id)
                {
                    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.clone());
                    canonical.insert(path.clone(), (id, resolved));
                }
            }
        }
    }

    /// Cached canonical spellings, recomputed only when a root identity changes.
    pub fn resolved_paths(&self) -> Vec<PathBuf> {
        self.refresh();
        self.canonical
            .lock()
            .map(|paths| paths.values().map(|(_, path)| path.clone()).collect())
            .unwrap_or_default()
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
            || self.canonical.lock().is_ok_and(|roots| {
                roots
                    .values()
                    .any(|(_, root)| secure_fs::path_is_within(path, root))
            })
    }

    /// Whether an opened object is a recorded credential root.
    pub fn protects_metadata(&self, metadata: &Metadata) -> bool {
        secure_fs::identity(metadata)
            .id
            .is_some_and(|id| self.identities.lock().is_ok_and(|ids| ids.contains(&id)))
    }

    /// Pin until the returned turn lease is dropped. A later turn may choose a
    /// recreated root; concurrent turns retain their existing identity fence.
    pub fn pin_root(&self, root: &Path) -> io::Result<Arc<RootPin>> {
        self.refresh();
        let file = secure_fs::open_directory_no_follow(root)?;
        let metadata = file.metadata()?;
        self.verify_root(root, &file, &metadata)?;
        let mut roots = self.roots.lock().map_err(|_| denied())?;
        if let Some(pin) = roots.get(root).and_then(Weak::upgrade) {
            return Ok(pin);
        }
        roots.retain(|_, pin| pin.strong_count() > 0);
        let pin = Arc::new(RootPin {
            id: secure_fs::identity(&metadata).id,
            _file: file,
        });
        roots.insert(root.to_path_buf(), Arc::downgrade(&pin));
        // Only a turn scope retains descriptors. An admitted blocking reader
        // keeps its turn policy alive until it finishes, including cancellation.
        if let Some(leases) = &self.leases {
            leases.lock().map_err(|_| denied())?.push(pin.clone());
        }
        Ok(pin)
    }

    #[cfg(unix)]
    pub(super) fn permits_hard_link(&self, metadata: &Metadata) -> bool {
        self.hard_links.permits(&self.paths, metadata)
    }

    /// Resolve a user-selected root, retaining the spelling of an active pin.
    pub fn canonical_root(&self, root: &Path) -> io::Result<PathBuf> {
        let roots = self.roots.lock().map_err(|_| denied())?;
        if roots.get(root).and_then(Weak::upgrade).is_some() {
            return Ok(root.to_path_buf());
        }
        drop(roots);
        std::fs::canonicalize(root)
    }

    pub(crate) fn verify_root(
        &self,
        root: &Path,
        _file: &std::fs::File,
        metadata: &Metadata,
    ) -> io::Result<()> {
        if self.protects_path(root) || self.protects_metadata(metadata) {
            return Err(denied());
        }
        if let Some(id) = secure_fs::identity(metadata).id {
            let roots = self.roots.lock().map_err(|_| denied())?;
            if let Some(pin) = roots.get(root).and_then(Weak::upgrade)
                && pin.id != Some(id)
            {
                return Err(denied());
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

fn cache() -> &'static Mutex<HashMap<Vec<PathBuf>, Arc<SecretInventory>>> {
    static CACHE: OnceLock<Mutex<HashMap<Vec<PathBuf>, Arc<SecretInventory>>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// A turn's root identity and open descriptor. Dropping the final lease releases
/// the descriptor; the process cache holds only a weak reference.
#[derive(Debug)]
pub struct RootPin {
    id: Option<FileId>,
    _file: std::fs::File,
}
