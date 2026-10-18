//! The launcher names its app log; only direct regular children of logs are accepted.
use std::path::{Component, Path, PathBuf};

pub(crate) fn valid(path: &Path) -> bool {
    let mut parts = path.components();
    matches!(parts.next(), Some(Component::Normal(name))
        if name == butler_platform::data_paths::LOGS)
        && matches!(parts.next(), Some(Component::Normal(name))
            if name.to_str().is_some_and(|name| !name.contains(['\\', ':'])))
        && parts.next().is_none()
}

pub(crate) fn paths() -> Vec<PathBuf> {
    let mut paths = butler_platform::service_registration::LAUNCHER_LOGS
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("BUTLER_APP_AGENT_LOG")
        .map(PathBuf::from)
        .filter(|p| valid(p))
        && !paths.contains(&path)
    {
        paths.push(path);
    }
    paths
}
