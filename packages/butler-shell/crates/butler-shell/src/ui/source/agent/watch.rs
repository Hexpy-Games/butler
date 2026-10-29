//! Discovery is driven by filesystem changes and explicit connection-loss requests.
use butler_shell_client::{AttachState, ShellClient};
use futures::channel::mpsc;
use notify::{RecursiveMode, Watcher as _};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::mpsc::UnboundedReceiver;

use super::MonitorSignal;

const INSTANCE: &str = "butler-agent-native-service.json";

pub(super) async fn monitor(
    data: Option<PathBuf>,
    output: mpsc::UnboundedSender<Option<ShellClient>>,
    mut retries: UnboundedReceiver<MonitorSignal>,
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
    let auth = data.join(butler_platform::data_paths::LOCAL_AUTH);
    let mut watched = Vec::new();
    let mut identity = None;
    let mut force = false;
    let mut backoff = Duration::from_millis(100);
    loop {
        let targets = [state.clone(), auth.parent().unwrap_or(&data).to_path_buf()];
        let setup = tokio::task::spawn_blocking(move || configure(watcher, watched, targets)).await;
        let Ok(Ok((next, path))) = setup else {
            return;
        };
        watcher = next;
        watched = path;
        if force {
            tokio::select! {
                () = tokio::time::sleep(backoff) => {},
                event = changed(&mut receive, &state, &auth) => {
                    if !event { return; }
                    backoff = Duration::from_millis(100);
                }
            }
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
        let client = match ShellClient::attach(Some(data.clone())).await {
            // Metadata discovery does not prove the HTTP endpoint is serving.
            Ok(AttachState::Connected(client)) => Some(client),
            _ => None,
        };
        let next = client.as_ref().map(|c| c.instance_identity().clone());
        if (force || next != identity) && output.unbounded_send(client).is_err() {
            return;
        }
        identity = next;
        force = loop {
            tokio::select! {
                signal = retries.recv() => match signal {
                    Some(MonitorSignal::SnapshotLoaded) => backoff = Duration::from_millis(100),
                    Some(MonitorSignal::Retry) => break true,
                    None => return,
                },
                event = changed(&mut receive, &state, &auth) => {
                    if !event { return; }
                    backoff = Duration::from_millis(100);
                    break false;
                }
            }
        };
        while receive.try_recv().is_ok() {}
    }
}

async fn changed(
    events: &mut UnboundedReceiver<notify::Result<notify::Event>>,
    state: &Path,
    auth: &Path,
) -> bool {
    while let Some(event) = events.recv().await {
        match event {
            Ok(event) if event.paths.iter().any(|p| relevant(p, state, auth)) => return true,
            Err(_) => return true,
            _ => {}
        }
    }
    false
}
fn relevant(path: &Path, state: &Path, auth: &Path) -> bool {
    path == state.join(INSTANCE)
        || state.starts_with(path)
        || path == auth
        || auth.starts_with(path)
}

fn configure(
    mut watcher: notify::RecommendedWatcher,
    mut watched: Vec<PathBuf>,
    targets: [PathBuf; 2],
) -> notify::Result<(notify::RecommendedWatcher, Vec<PathBuf>)> {
    let targets = targets.map(|mut target| {
        while !target.is_dir() && target.pop() {}
        target
    });
    if watched != targets {
        for old in &watched {
            let _ = watcher.unwatch(old);
        }
        for target in &targets {
            watcher.watch(target, RecursiveMode::NonRecursive)?;
        }
        watched = targets.to_vec();
    }
    Ok::<_, notify::Error>((watcher, watched))
}
