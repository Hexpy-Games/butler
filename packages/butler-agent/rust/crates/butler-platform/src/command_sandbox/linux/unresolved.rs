//! Preserve target denials when the final object cannot yet be opened.
use std::{
    collections::VecDeque,
    path::{Component, Path, PathBuf},
};

/// Expand existing aliases, including a dangling final link, and normalize
/// the remaining absolute path. Unreadable components retain their lexical
/// name; a loop remains inaccessible and is bounded like kernel resolution.
pub(in crate::command_sandbox) fn target(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut pending: VecDeque<_> = absolute
        .components()
        .map(|part| part.as_os_str().to_os_string())
        .collect();
    let mut result = PathBuf::new();
    let mut followed = 0;
    while let Some(part) = pending.pop_front() {
        match Path::new(&part).components().next() {
            Some(Component::RootDir) => result.push("/"),
            Some(Component::ParentDir) => {
                result.pop();
            }
            Some(Component::Normal(_)) => {
                result.push(&part);
                if followed < 40
                    && let Ok(link) = std::fs::read_link(&result)
                {
                    followed += 1;
                    result.pop();
                    for part in link.components().rev() {
                        pending.push_front(part.as_os_str().to_os_string());
                    }
                }
            }
            _ => {}
        }
    }
    Ok(result)
}
