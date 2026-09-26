use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
        match &*self.0.lock().expect("workspace reference poisoned") {
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
        *self.0.lock().expect("workspace reference poisoned") =
            ReferenceState::Path(resolve(Path::new(trimmed)));
        Ok(())
    }
}

fn resolve(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize(path)
    } else {
        normalize(
            &std::env::current_dir()
                .expect("current directory available")
                .join(path),
        )
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
