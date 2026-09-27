//! First-use acquisition for the four files consumed by the native BGE-M3 engine.
//! Complete existing caches stay untouched; only missing files use this frozen revision.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use futures_util::StreamExt;
use reqwest::{Client, StatusCode, header};
use sha2::{Digest, Sha256};

use crate::cognition::ensure_data_authority;

const REVISION: &str = "4de13258303883538bd53b696b452bf8099f0858";
const MODEL_ROOT: &str = "cache/models/Xenova/bge-m3";
const STAGING: &str = ".native-embedding-acquire";

// Xenova/bge-m3 at REVISION, https://huggingface.co/Xenova/bge-m3/tree/REVISION.
// SHA-256 values are of file bytes, including the small Git blobs whose Hub ETags are SHA-1.
struct Asset {
    relative: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const ASSETS: [Asset; 4] = [
    Asset {
        relative: "tokenizer.json",
        bytes: 17_082_821,
        sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790",
    },
    Asset {
        relative: "tokenizer_config.json",
        bytes: 1_173,
        sha256: "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4",
    },
    Asset {
        relative: "config.json",
        bytes: 770,
        sha256: "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95",
    },
    Asset {
        relative: "onnx/model_quantized.onnx",
        bytes: 569_694_530,
        sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d",
    },
];

pub(super) async fn ensure(data_root: &Path) -> Result<(), &'static str> {
    let root = data_root.join(MODEL_ROOT);
    if ASSETS
        .iter()
        .all(|asset| root.join(asset.relative).is_file())
    {
        // The engine validates usability and derives identity from these actual bytes.
        cleanup_complete_staging(data_root, &root)?;
        return Ok(());
    }
    let client = Client::builder()
        .build()
        .map_err(|_| "embed_asset_download_failed")?;
    acquire(data_root, &root, &ASSETS, &client, |asset| {
        format!(
            "https://huggingface.co/Xenova/bge-m3/resolve/{REVISION}/{}",
            asset.relative
        )
    })
    .await
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
    lock.lock().map_err(|_| "embed_asset_unavailable")?;
    for asset in &ASSETS {
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
    url: impl Fn(&Asset) -> String,
) -> Result<(), &'static str> {
    let staging = root.join(STAGING);
    let lock_path = root.join(".native-embedding-acquire.lock");
    let mut guarded: Vec<PathBuf> = vec![root.to_owned(), staging.clone(), lock_path.clone()];
    for asset in assets {
        guarded.push(root.join(asset.relative));
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
    lock.lock().map_err(|_| "embed_asset_unavailable")?;
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
        let final_path = root.join(asset.relative);
        reject_symlink(&final_path)?;
        if final_path.exists() && !matches_asset(&final_path, asset)? {
            return Err("embed_asset_version_conflict");
        }
    }
    for asset in assets {
        let final_path = root.join(asset.relative);
        if final_path.is_file() {
            continue;
        }
        let part = part_path(&staging, asset);
        reject_symlink(&part)?;
        download(client, &url(asset), asset, &part).await?;
    }
    // Do not expose any new final path until every missing staged file is verified.
    for asset in assets {
        let final_path = root.join(asset.relative);
        if final_path.is_file() {
            continue;
        }
        let part = part_path(&staging, asset);
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

async fn download(
    client: &Client,
    url: &str,
    asset: &Asset,
    part: &Path,
) -> Result<(), &'static str> {
    let existing = match fs::metadata(part) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= asset.bytes => metadata.len(),
        Ok(_) => {
            fs::remove_file(part).map_err(|_| "embed_asset_unavailable")?;
            0
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => return Err("embed_asset_unavailable"),
    };
    if existing == asset.bytes {
        if matches_asset(part, asset)? {
            return Ok(());
        }
        fs::remove_file(part).map_err(|_| "embed_asset_unavailable")?;
    }
    let start = if existing == asset.bytes { 0 } else { existing };
    let mut request = client.get(url).header(header::ACCEPT_ENCODING, "identity");
    if start > 0 {
        request = request.header(header::RANGE, format!("bytes={start}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|_| "embed_asset_download_failed")?;
    if start > 0 {
        if response.status() != StatusCode::PARTIAL_CONTENT
            || !valid_range(response.headers(), start, asset.bytes)
        {
            return Err("embed_asset_range_invalid");
        }
    } else if response.status() != StatusCode::OK {
        return Err("embed_asset_download_failed");
    }
    let mut file = File::options()
        .create(true)
        .write(true)
        .append(start > 0)
        .truncate(start == 0)
        .open(part)
        .map_err(|_| "embed_asset_unavailable")?;
    let mut received = start;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "embed_asset_download_failed")?;
        received = received
            .checked_add(chunk.len() as u64)
            .filter(|count| *count <= asset.bytes)
            .ok_or("embed_asset_download_failed")?;
        file.write_all(&chunk)
            .map_err(|_| "embed_asset_unavailable")?;
    }
    if received != asset.bytes {
        return Err("embed_asset_download_failed");
    }
    file.sync_all().map_err(|_| "embed_asset_unavailable")?;
    drop(file);
    if !matches_asset(part, asset)? {
        fs::remove_file(part).map_err(|_| "embed_asset_unavailable")?;
        return Err("embed_asset_hash_mismatch");
    }
    Ok(())
}

fn valid_range(headers: &header::HeaderMap, start: u64, total: u64) -> bool {
    let Some(raw) = headers
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
    else {
        return false;
    };
    let Some((range, length)) = raw.split_once('/') else {
        return false;
    };
    let Some((first, last)) = range.split_once('-') else {
        return false;
    };
    matches!(
        (first.parse::<u64>(), last.parse::<u64>(), length.parse::<u64>()),
        (Ok(first), Ok(last), Ok(length))
            if first == start && last >= first && last < total && length == total
    )
}

#[cfg(test)]
mod tests;
