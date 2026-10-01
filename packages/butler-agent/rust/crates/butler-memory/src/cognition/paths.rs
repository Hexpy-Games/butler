//! Where the cognition and memory stores live.

use std::path::{Path, PathBuf};

/// Where the cognition and memory stores live; relative to the data root unless overridden.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CognitionPathEnvironment {
    /// Override of the cognition root.
    pub cognition_home: Option<String>,
    /// Override of the memory root.
    pub memory_home: Option<String>,
}

pub(super) fn node_join(base: &Path, child: &str) -> PathBuf {
    use std::path::Component;

    let mut combined = base.to_path_buf();
    for component in Path::new(child).components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                if !combined.pop() && !base.is_absolute() {
                    combined.push("..");
                }
            }
            Component::Normal(value) => combined.push(value),
        }
    }
    combined
}

impl CognitionPathEnvironment {
    /// The cognition root.
    pub fn cognition_root(&self, data_root: &Path) -> PathBuf {
        trimmed(self.cognition_home.as_ref())
            .map(PathBuf::from)
            .unwrap_or_else(|| data_root.join("cognition"))
    }

    /// The memory root.
    pub fn memory_root(&self, data_root: &Path) -> PathBuf {
        trimmed(self.memory_home.as_ref())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.cognition_root(data_root).join("memory"))
    }

    /// Explicit rule files and their prompt index share this memory-root binding.
    pub fn explicit_rules_root(&self, data_root: &Path) -> PathBuf {
        explicit_memory_rules_root(&self.memory_root(data_root))
    }

    /// The consolidation lock file every memory writer takes.
    pub fn consolidation_lock(&self, data_root: &Path) -> PathBuf {
        self.cognition_root(data_root)
            .join("consolidation/locks/consolidation.lock")
    }
}

fn trimmed(value: Option<&String>) -> Option<&str> {
    value
        .map(|value| butler_core::public_text::trim_js_whitespace(value))
        .filter(|value| !value.is_empty())
}

/// Explicit rule files and INDEX.md beneath a resolved memory root.
pub fn explicit_memory_rules_root(memory_root: &Path) -> PathBuf {
    memory_root.join("rules")
}
