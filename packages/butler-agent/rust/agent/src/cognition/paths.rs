use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CognitionPathEnvironment {
    pub cognition_home: Option<String>,
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
    pub(crate) fn cognition_root(&self, data_root: &Path) -> PathBuf {
        trimmed(&self.cognition_home)
            .map(PathBuf::from)
            .unwrap_or_else(|| data_root.join("cognition"))
    }

    pub(crate) fn memory_root(&self, data_root: &Path) -> PathBuf {
        trimmed(&self.memory_home)
            .map(PathBuf::from)
            .unwrap_or_else(|| self.cognition_root(data_root).join("memory"))
    }

    pub(crate) fn consolidation_lock(&self, data_root: &Path) -> PathBuf {
        self.cognition_root(data_root)
            .join("consolidation/locks/consolidation.lock")
    }
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_preserve_relative_paths_and_ignore_js_whitespace_only_values() {
        let root = Path::new("data");
        let none = CognitionPathEnvironment::default();
        assert_eq!(none.memory_root(root), Path::new("data/cognition/memory"));
        let environment = CognitionPathEnvironment {
            cognition_home: Some(" relative-cognition ".into()),
            memory_home: Some("\u{feff}\t".into()),
        };
        assert_eq!(
            environment.cognition_root(root),
            Path::new("relative-cognition")
        );
        assert_eq!(
            environment.memory_root(root),
            Path::new("relative-cognition/memory")
        );
        let memory = CognitionPathEnvironment {
            cognition_home: None,
            memory_home: Some(" relative-memory ".into()),
        };
        assert_eq!(memory.memory_root(root), Path::new("relative-memory"));
        assert_eq!(
            node_join(Path::new("/root/gen"), "/snapshot/../db"),
            Path::new("/root/gen/db")
        );
    }
}
