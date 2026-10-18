//! The launcher names its app log; only direct regular children of logs are accepted.
use std::path::{Component, Path, PathBuf};

pub(crate) fn valid(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    let mut parts = text.split('/');
    parts.next() == Some("logs")
        && parts.next().is_some_and(|name| {
            !name.is_empty()
                && !name.contains(['\\', ':'])
                && Path::new(name)
                    .components()
                    .all(|p| matches!(p, Component::Normal(_)))
        })
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
pub(crate) fn kept(path: &Path) -> bool {
    paths().iter().any(|p| p == path)
}
