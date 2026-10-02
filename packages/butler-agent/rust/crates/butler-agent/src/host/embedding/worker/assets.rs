//! Background acquisition for the four files consumed by the native BGE-M3 engine.
//! Complete existing caches stay untouched; only missing files use this frozen revision.

use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

use reqwest::Client;

mod background;
mod download;
pub(crate) use background::Acquisition;
use sha2::{Digest, Sha256};

use butler_memory::cognition::ensure_data_authority;

const REVISION: &str = "4de13258303883538bd53b696b452bf8099f0858";
const MODEL_ROOT: &str = "cache/models/Xenova/bge-m3";
const STAGING: &str = ".native-embedding-acquire";

// Xenova/bge-m3 at REVISION, https://huggingface.co/Xenova/bge-m3/tree/REVISION.
// SHA-256 values are of file bytes, including the small Git blobs whose Hub ETags are SHA-1.
#[derive(serde::Deserialize)]
struct Asset {
    relative: String,
    bytes: u64,
    sha256: String,
}

fn pinned_assets() -> Vec<Asset> {
    vec![
        Asset {
            relative: "tokenizer.json".to_owned(),
            bytes: 17_082_821,
            sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790".to_owned(),
        },
        Asset {
            relative: "tokenizer_config.json".to_owned(),
            bytes: 1_173,
            sha256: "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4".to_owned(),
        },
        Asset {
            relative: "config.json".to_owned(),
            bytes: 770,
            sha256: "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95".to_owned(),
        },
        Asset {
            relative: "onnx/model_quantized.onnx".to_owned(),
            bytes: 569_694_530,
            sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d".to_owned(),
        },
    ]
}

pub(super) async fn ensure(data_root: &Path) -> Result<(), &'static str> {
    let root = data_root.join(MODEL_ROOT);
    let ready = tokio::task::spawn_blocking(move || complete(&root, &pinned_assets()))
        .await
        .map_err(|_| "embed_asset_unavailable")?;
    if ready {
        Ok(())
    } else {
        // Acquisition belongs to the service, never to a chat's inference worker.
        Err("embed_asset_pending")
    }
}

fn complete(root: &Path, assets: &[Asset]) -> bool {
    assets
        .iter()
        .all(|asset| root.join(&asset.relative).is_file())
}

/// Offline status uses fixed-size metadata probes, never reads or writes model bytes.
pub(crate) fn cached_status(data_root: &Path) -> serde_json::Value {
    let assets = pinned_assets();
    let root = data_root.join(MODEL_ROOT);
    let ready = complete(&root, &assets);
    let total: u64 = assets.iter().map(|asset| asset.bytes).sum();
    let done: u64 = assets
        .iter()
        .map(|asset| {
            if root.join(&asset.relative).is_file() {
                asset.bytes
            } else {
                fs::metadata(part_path(&root.join(STAGING), asset))
                    .map_or(0, |meta| meta.len().min(asset.bytes))
            }
        })
        .sum();
    serde_json::json!({"state": if ready { "ready" } else { "queued" }, "bytes_done":done, "bytes_total":total})
}

fn cleanup_complete_staging(data_root: &Path, root: &Path) -> Result<(), &'static str> {
    let staging = root.join(STAGING);
    if !staging.exists() {
        return Ok(());
    }
    let lock_path = root.join(".native-embedding-acquire.lock");
    ensure_data_authority(data_root, &[root, &staging, &lock_path])
        .map_err(|_| "embed_asset_path_unsafe")?;
    reject_symlink(&staging)?;
    reject_symlink(&lock_path)?;
    let lock = File::options()
        .create(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|_| "embed_asset_unavailable")?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Ok(()),
        Err(_) => return Err("embed_asset_unavailable"),
    }
    for asset in &pinned_assets() {
        let part = part_path(&staging, asset);
        ensure_data_authority(data_root, &[&part]).map_err(|_| "embed_asset_path_unsafe")?;
        reject_symlink(&part)?;
        match fs::remove_file(&part) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("embed_asset_unavailable"),
        }
    }
    Ok(())
}

async fn acquire(
    data_root: &Path,
    root: &Path,
    assets: &[Asset],
    client: &Client,
    sources: &[String],
    progress: &mut impl FnMut(&str, u64),
) -> Result<(), &'static str> {
    let (_lock, staging) = prepare(data_root, root, assets).await?;
    download_missing(root, &staging, assets, client, sources, progress).await?;
    publish_staged(data_root, root, &staging, assets)
}

async fn prepare(
    data_root: &Path,
    root: &Path,
    assets: &[Asset],
) -> Result<(File, PathBuf), &'static str> {
    let staging = root.join(STAGING);
    let lock_path = root.join(".native-embedding-acquire.lock");
    let mut guarded: Vec<PathBuf> = vec![root.to_owned(), staging.clone(), lock_path.clone()];
    for asset in assets {
        guarded.push(root.join(&asset.relative));
        guarded.push(part_path(&staging, asset));
    }
    ensure_data_authority(
        data_root,
        &guarded.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
    )
    .map_err(|_| "embed_asset_path_unsafe")?;
    fs::create_dir_all(root).map_err(|_| "embed_asset_unavailable")?;
    reject_symlink(&lock_path)?;
    let lock = File::options()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|_| "embed_asset_unavailable")?;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Err(_) => return Err("embed_asset_unavailable"),
        }
    }
    // The OS releases the lock if the worker is killed. Only our four named
    // partials are ever inspected or removed; no directory-wide cleanup runs.
    ensure_data_authority(
        data_root,
        &guarded.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
    )
    .map_err(|_| "embed_asset_path_unsafe")?;
    reject_symlink(&staging)?;
    fs::create_dir_all(&staging).map_err(|_| "embed_asset_unavailable")?;
    for asset in assets {
        let final_path = root.join(&asset.relative);
        reject_symlink(&final_path)?;
        if final_path.exists() && !matches_asset(&final_path, asset)? {
            return Err("embed_asset_version_conflict");
        }
    }
    Ok((lock, staging))
}

async fn download_missing(
    root: &Path,
    staging: &Path,
    assets: &[Asset],
    client: &Client,
    sources: &[String],
    progress: &mut impl FnMut(&str, u64),
) -> Result<(), &'static str> {
    for asset in assets {
        let final_path = root.join(&asset.relative);
        if final_path.is_file() {
            continue;
        }
        let part = part_path(staging, asset);
        reject_symlink(&part)?;
        let baseline = assets
            .iter()
            .filter(|other| other.relative != asset.relative)
            .map(|other| {
                if root.join(&other.relative).is_file() {
                    other.bytes
                } else {
                    fs::metadata(part_path(staging, other))
                        .map_or(0, |meta| meta.len().min(other.bytes))
                }
            })
            .sum::<u64>();
        download::with_retries(client, sources, asset, &part, baseline, progress).await?;
    }
    Ok(())
}

fn publish_staged(
    data_root: &Path,
    root: &Path,
    staging: &Path,
    assets: &[Asset],
) -> Result<(), &'static str> {
    // Do not expose any new final path until every missing staged file is verified.
    for asset in assets {
        let final_path = root.join(&asset.relative);
        if final_path.is_file() {
            continue;
        }
        let part = part_path(staging, asset);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent).map_err(|_| "embed_asset_unavailable")?;
        }
        ensure_data_authority(data_root, &[&final_path, &part])
            .map_err(|_| "embed_asset_path_unsafe")?;
        reject_symlink(&final_path)?;
        match fs::hard_link(&part, &final_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure_data_authority(data_root, &[&final_path])
                    .map_err(|_| "embed_asset_path_unsafe")?;
                reject_symlink(&final_path)?;
                if !matches_asset(&final_path, asset)? {
                    return Err("embed_asset_version_conflict");
                }
            }
            Err(_) => return Err("embed_asset_unavailable"),
        }
        fs::remove_file(&part).map_err(|_| "embed_asset_unavailable")?;
    }
    Ok(())
}

fn part_path(staging: &Path, asset: &Asset) -> PathBuf {
    let name = asset.relative.replace('/', "_");
    staging.join(format!("{name}.part"))
}

fn reject_symlink(path: &Path) -> Result<(), &'static str> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err("embed_asset_path_unsafe"),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("embed_asset_unavailable"),
    }
}

fn matches_asset(path: &Path, asset: &Asset) -> Result<bool, &'static str> {
    let metadata = fs::metadata(path).map_err(|_| "embed_asset_unavailable")?;
    if !metadata.is_file() || metadata.len() != asset.bytes {
        return Ok(false);
    }
    Ok(hash_file(path)? == asset.sha256)
}

fn hash_file(path: &Path) -> Result<String, &'static str> {
    let mut file = File::open(path).map_err(|_| "embed_asset_unavailable")?;
    let mut digest = Sha256::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut chunk)
            .map_err(|_| "embed_asset_unavailable")?;
        if count == 0 {
            return Ok(format!("{:x}", digest.finalize()));
        }
        digest.update(&chunk[..count]);
    }
}
