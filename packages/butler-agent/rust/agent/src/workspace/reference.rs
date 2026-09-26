use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceReference(Arc<Mutex<ReferenceState>>);

#[derive(Debug)]
enum ReferenceState {
    Path(PathBuf),
    Unavailable(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceReferenceError {
    pub code: String,
}

impl WorkspaceReference {
    pub(crate) fn new(path: &Path) -> Self {
        Self(Arc::new(Mutex::new(ReferenceState::Path(resolve(path)))))
    }

    pub(crate) fn unavailable(code: impl Into<String>) -> Self {
        Self(Arc::new(Mutex::new(ReferenceState::Unavailable(
            code.into(),
        ))))
    }

    pub(crate) fn get(&self) -> Result<PathBuf, WorkspaceReferenceError> {
        match &*self.0.lock() {
            ReferenceState::Path(path) => Ok(path.clone()),
            ReferenceState::Unavailable(code) => {
                Err(WorkspaceReferenceError { code: code.clone() })
            }
        }
    }

    pub(crate) fn set(&self, path: &str) -> Result<(), WorkspaceReferenceError> {
        let trimmed = crate::public_text::trim_js_whitespace(path);
        if trimmed.is_empty() {
            return Err(WorkspaceReferenceError {
                code: "workspace_reference_path_required".into(),
            });
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
