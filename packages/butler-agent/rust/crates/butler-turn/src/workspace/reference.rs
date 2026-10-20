use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The shared, updatable workspace path of a session (or why it is unavailable),
/// and whether the user consented to it as the project folder when the
/// session moved its folder (`None`: the session's own project rule applies).
#[derive(Clone, Debug)]
pub struct WorkspaceReference(
    Arc<Mutex<ReferenceState>>,
    Arc<Mutex<Option<bool>>>,
    Arc<Mutex<Option<Arc<butler_platform::secure_fs::SecretInventory>>>>,
);

#[derive(Debug)]
enum ReferenceState {
    Path(PathBuf),
    Unavailable(&'static str),
}

/// Failures to read or set the session's workspace reference.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceReferenceError {
    /// Session workspace recovery failed; `code` is its reason code.
    #[error("{code}")]
    Unavailable { code: &'static str },
    /// A blank path was given for the workspace.
    #[error("workspace_reference_path_required")]
    PathRequired,
}

impl WorkspaceReferenceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable { code } => code,
            Self::PathRequired => "workspace_reference_path_required",
        }
    }
}

impl WorkspaceReference {
    /// A reference to `path`.
    pub fn new(path: &Path) -> Self {
        Self(
            Arc::new(Mutex::new(ReferenceState::Path(resolve(path)))),
            Arc::default(),
            Arc::default(),
        )
    }

    /// A reference that reports `code` until set.
    pub fn unavailable(code: &'static str) -> Self {
        Self(
            Arc::new(Mutex::new(ReferenceState::Unavailable(code))),
            Arc::default(),
            Arc::default(),
        )
    }

    /// Bind the credential policy and root pins selected for this turn.
    pub fn set_read_inventory(&self, inventory: Arc<butler_platform::secure_fs::SecretInventory>) {
        *self.2.lock() = Some(inventory);
    }

    /// The selected turn's contained-reader policy.
    pub fn read_inventory(&self) -> Option<Arc<butler_platform::secure_fs::SecretInventory>> {
        self.2.lock().clone()
    }

    /// The current path.
    pub fn get(&self) -> Result<PathBuf, WorkspaceReferenceError> {
        match &*self.0.lock() {
            ReferenceState::Path(path) => Ok(path.clone()),
            ReferenceState::Unavailable(code) => Err(WorkspaceReferenceError::Unavailable { code }),
        }
    }

    /// Whether the folder counts as the project folder, when decided.
    pub fn consent(&self) -> Option<bool> {
        *self.1.lock()
    }

    /// Records whether the folder counts as the project folder.
    pub fn set_consent(&self, consented: bool) {
        *self.1.lock() = Some(consented);
    }

    /// Points the reference at `path`.
    pub fn set(&self, path: &str) -> Result<(), WorkspaceReferenceError> {
        let trimmed = butler_core::public_text::trim_js_whitespace(path);
        if trimmed.is_empty() {
            return Err(WorkspaceReferenceError::PathRequired);
        }
        *self.0.lock() = ReferenceState::Path(resolve(Path::new(trimmed)));
        Ok(())
    }
}

fn resolve(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize(path)
    } else {
        // Without a current directory the relative path is kept as given.
        match std::env::current_dir() {
            Ok(current) => normalize(&current.join(path)),
            Err(_) => normalize(path),
        }
    }
}

fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}
