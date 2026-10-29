//! Discovery is driven by filesystem changes and explicit connection-loss requests.
use butler_shell_client::{AttachState, ShellClient};
use futures::channel::mpsc;
use notify::{RecursiveMode, Watcher as _};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::mpsc::UnboundedReceiver;

const INSTANCE: &str = "butler-agent-native-service.json";

pub(super) async fn monitor(
    data: Option<PathBuf>,
    output: mpsc::UnboundedSender<Option<ShellClient>>,
    mut retries: UnboundedReceiver<()>,
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
    let mut identity = None;
    let mut force = false;
    let mut backoff = Duration::from_millis(100);
    loop {
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
        if force {
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
        let client = discover(&data).await;
        let next = client.as_ref().map(|c| c.instance_identity().clone());
        if (force || next != identity) && output.unbounded_send(client).is_err() {
            return;
        }
        identity = next;
        force = tokio::select! {
            retry = retries.recv() => { if retry.is_none() { return; } true }
            event = changed(&mut receive, &state) => { if !event { return; } backoff = Duration::from_millis(100); false }
        };
        while retries.try_recv().is_ok() {}
        while receive.try_recv().is_ok() {}
    }
}

async fn discover(data: &Path) -> Option<ShellClient> {
    let mut backoff = Duration::from_millis(100);
    loop {
        match ShellClient::attach(Some(data.to_path_buf())).await {
            Ok(AttachState::Connected(client)) => return Some(client),
            Ok(AttachState::NotRunning) => return None,
            Err(_) => {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(5));
            }
        }
    }
}

async fn changed(
    events: &mut UnboundedReceiver<notify::Result<notify::Event>>,
    state: &Path,
) -> bool {
    while let Some(event) = events.recv().await {
        match event {
            Ok(event) if event.paths.iter().any(|p| relevant(p, state)) => return true,
            Err(_) => return true,
            _ => {}
        }
    }
    false
}
fn relevant(path: &Path, state: &Path) -> bool {
    path == state.join(INSTANCE) || state.starts_with(path)
}
