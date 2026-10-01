//! Service-owned acquisition. Blocking file work runs off Tokio's workers.
use super::{
    Asset, MODEL_ROOT, REVISION, acquire, cleanup_complete_staging, complete, pinned_assets,
};
use butler_gateway::gateway::MemoryModelProgress;
use parking_lot::Mutex;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

pub(crate) struct Acquisition {
    root: PathBuf,
    state: watch::Sender<MemoryModelProgress>,
    task: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
}
impl Acquisition {
    pub(crate) fn start(root: PathBuf) -> Self {
        let state = watch::channel(MemoryModelProgress {
            state: "queued".into(),
            bytes_done: 0,
            bytes_total: 0,
            reason: None,
        })
        .0;
        let this = Self {
            root,
            state,
            task: Mutex::new(None),
        };
        this.retry();
        this
    }
    pub(crate) fn subscribe(&self) -> watch::Receiver<MemoryModelProgress> {
        self.state.subscribe()
    }

    pub(crate) fn retry(&self) {
        let mut slot = self.task.lock();
        if self.state.borrow().state == "ready" {
            return;
        }
        if slot.as_ref().is_some_and(|(_, task)| !task.is_finished()) {
            return;
        }
        self.state.send_modify(|view| {
            view.state = "queued".into();
            view.reason = None;
        });
        let root = self.root.clone();
        let state = self.state.clone();
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        let runtime = tokio::runtime::Handle::current();
        let task = tokio::task::spawn_blocking(move || {
            runtime.block_on(async {
                tokio::select! {
                    () = cancelled.cancelled() => {},
                    () = run(root, state) => {},
                }
            });
        });
        *slot = Some((stop, task));
    }
    pub(crate) async fn close(&self) {
        let task = self.task.lock().take();
        if let Some((stop, task)) = task {
            stop.cancel();
            let _ = task.await;
        }
    }
}
impl Drop for Acquisition {
    fn drop(&mut self) {
        if let Some((stop, _)) = self.task.get_mut().take() {
            stop.cancel();
        }
    }
}

#[derive(serde::Deserialize)]
struct Manifest {
    assets: Vec<Asset>,
    sources: Vec<String>,
}
fn manifest() -> Manifest {
    // Explicit stub-tier hook: fixed filenames, local HTTP only; production hashes stay frozen.
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && let Ok(raw) = std::env::var("BUTLER_E2E_EMBED_MANIFEST")
        && let Ok(value) = serde_json::from_str::<Manifest>(&raw)
        && value.assets.len() == 4
        && value.assets.iter().zip(pinned_assets()).all(|(a, pinned)| {
            a.relative == pinned.relative && a.bytes > 0 && a.bytes < 1024 * 1024
        })
        && !value.sources.is_empty()
        && value.sources.iter().all(|url| {
            reqwest::Url::parse(url)
                .is_ok_and(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
        })
    {
        return value;
    }
    let stub_sources = std::env::var("BUTLER_E2E_EMBED_SOURCES")
        .ok()
        .filter(|url| {
            std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
                && reqwest::Url::parse(url)
                    .is_ok_and(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1"))
        });
    if let Some(source) = stub_sources {
        return Manifest {
            assets: pinned_assets(),
            sources: vec![source],
        };
    }
    Manifest {
        assets: pinned_assets(),
        sources: vec![
            format!("https://huggingface.co/Xenova/bge-m3/resolve/{REVISION}"),
            "https://github.com/Hexpy-Games/butler/releases/download/models-bge-m3-4de13258".into(),
        ],
    }
}
async fn run(root: PathBuf, state: watch::Sender<MemoryModelProgress>) {
    let manifest = manifest();
    let total = manifest.assets.iter().map(|a| a.bytes).sum();
    let mut last = Instant::now();
    let mut done = 0;
    let mut previous_phase = String::new();
    let mut report = |phase: &str, bytes: u64| {
        done = bytes;
        // State transitions publish immediately; byte-only updates never exceed 2/s.
        if phase == previous_phase && last.elapsed() < Duration::from_millis(500) {
            return;
        }
        previous_phase = phase.to_owned();
        last = Instant::now();
        publish(&state, phase, bytes, total, None);
    };
    report("queued", 0);
    let result = if complete(&root.join(MODEL_ROOT), &manifest.assets) {
        cleanup_complete_staging(&root, &root.join(MODEL_ROOT))
    } else {
        match reqwest::Client::builder()
            // Fixture servers must never redirect a stub run onto a real model host.
            .redirect(
                if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub") {
                    reqwest::redirect::Policy::none()
                } else {
                    reqwest::redirect::Policy::default()
                },
            )
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .build()
        {
            Ok(client) => {
                acquire(
                    &root,
                    &root.join(MODEL_ROOT),
                    &manifest.assets,
                    &client,
                    &manifest.sources,
                    &mut report,
                )
                .await
            }
            Err(_) => Err("embed_asset_download_failed"),
        }
    };
    match result {
        Ok(()) => publish(&state, "ready", total, total, None),
        Err(reason) => publish(&state, "failed", done, total, Some(reason.into())),
    }
}
fn publish(
    state: &watch::Sender<MemoryModelProgress>,
    phase: &str,
    done: u64,
    total: u64,
    reason: Option<String>,
) {
    state.send_replace(MemoryModelProgress {
        state: phase.into(),
        bytes_done: done,
        bytes_total: total,
        reason,
    });
}
