//! Discovery runs only on filesystem change, including data/state directory creation.
use butler_shell_client::{AttachState, ShellClient};
use futures::channel::mpsc;
use notify::{RecursiveMode, Watcher as _};
use std::path::{Path, PathBuf};

const INSTANCE: &str = "butler-agent-native-service.json";

pub(super) async fn monitor(
    data: Option<PathBuf>,
    output: mpsc::UnboundedSender<Option<ShellClient>>,
) {
    let data = data
        .or_else(|| {
            std::env::var_os("BUTLER_DATA")
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| butler_platform::user_dirs::non_empty_home_dir().map(|p| p.join(".butler")));
    let Some(data) = data else {
        return;
    };
    let (events, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let init = tokio::task::spawn_blocking(move || {
        notify::recommended_watcher(move |event| {
            let _ = events.send(event);
        })
    })
    .await;
    let Ok(Ok(mut watcher)) = init else {
        return;
    };
    let state = data.join("state");
    let mut watched = None;
    loop {
        // Watch installation is ordered before discovery, closing the first-attach race.
        let target = state.clone();
        let setup = tokio::task::spawn_blocking(move || {
            let mut target = target;
            while !target.is_dir() {
                if !target.pop() {
                    break;
                }
            }
            if watched.as_ref() != Some(&target) {
                if let Some(old) = watched.take() {
                    let _ = watcher.unwatch(&old);
                }
                watcher.watch(&target, RecursiveMode::NonRecursive)?;
                watched = Some(target);
            }
            Ok::<_, notify::Error>((watcher, watched))
        })
        .await;
        let Ok(Ok((next, path))) = setup else {
            return;
        };
        watcher = next;
        watched = path;
        let client = match ShellClient::attach(Some(data.clone())).await {
            Ok(AttachState::Connected(client)) => Some(client),
            _ => None,
        };
        if output.unbounded_send(client).is_err() {
            return;
        }
        loop {
            let Some(event) = receive.recv().await else {
                return;
            };
            match event {
                Ok(event) if event.paths.iter().any(|p| relevant(p, &state)) => break,
                Err(_) => break,
                _ => {}
            }
        }
    }
}
fn relevant(path: &Path, state: &Path) -> bool {
    path == state.join(INSTANCE) || state.starts_with(path)
}
