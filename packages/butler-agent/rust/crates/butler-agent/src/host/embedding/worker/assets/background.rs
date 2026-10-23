//! Download of the pinned model files. Blocking file work runs off Tokio's workers.
use super::{
    Asset, MODEL_ROOT, REVISION, acquire, cleanup_complete_staging, complete, pinned_assets,
};
use butler_gateway::gateway::MemoryModelProgress;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::watch;

#[derive(serde::Deserialize)]
struct Manifest {
    assets: Vec<Asset>,
    sources: Vec<String>,
}
fn manifest() -> Manifest {
    #[cfg(feature = "e2e-fixtures")]
    if let Some(fixture) = fixture_manifest() {
        return fixture;
    }
    Manifest {
        assets: pinned_assets(),
        sources: vec![
            format!("https://huggingface.co/Xenova/bge-m3/resolve/{REVISION}"),
            "https://github.com/Hexpy-Games/butler/releases/download/models-bge-m3-4de13258".into(),
        ],
    }
}
/// The separate fault build can substitute small local assets; shipped hashes stay frozen.
#[cfg(feature = "e2e-fixtures")]
fn fixture_manifest() -> Option<Manifest> {
    let pinned = pinned_assets();
    let names: Vec<_> = pinned.iter().map(|asset| asset.relative.as_str()).collect();
    if let Some(value) = crate::host::faults::embedding_manifest(&names) {
        return Some(Manifest {
            assets: value
                .assets
                .into_iter()
                .map(|asset| Asset {
                    relative: asset.relative,
                    bytes: asset.bytes,
                    sha256: asset.sha256,
                })
                .collect(),
            sources: value.sources,
        });
    }
    crate::host::faults::embedding_sources().map(|sources| Manifest {
        assets: pinned,
        sources,
    })
}

pub(super) async fn run(root: PathBuf, state: watch::Sender<MemoryModelProgress>) {
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
        match butler_log::http::external(butler_log::http::Purpose::new("embedding_download"))
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
