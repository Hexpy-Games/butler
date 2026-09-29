//! The model and tokenizer files under the data root, and their identity
//! hashes.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::EmbeddingFailure;
use crate::cognition::mutable_paths::ensure_data_authority;

pub(super) const MODEL_FILE: &str = "onnx/model_quantized.onnx";
const HASH_CACHE_FILE: &str = "asset-hashes.json";

/// The model and tokenizer files under the data root.
pub(super) struct Assets {
    data_root: PathBuf,
    pub(super) root: PathBuf,
    pub(super) tokenizer_file: PathBuf,
    pub(super) tokenizer_config: PathBuf,
    pub(super) model_config: PathBuf,
    pub(super) model_file: PathBuf,
}

impl Assets {
    /// The asset paths, checked to stay inside the data root and to exist.
    pub(super) fn new(data_root: &Path) -> Result<Self, EmbeddingFailure> {
        let root = data_root.join("cache/models/Xenova/bge-m3");
        let assets = Self {
            data_root: data_root.to_owned(),
            tokenizer_file: root.join("tokenizer.json"),
            tokenizer_config: root.join("tokenizer_config.json"),
            model_config: root.join("config.json"),
            model_file: root.join(MODEL_FILE),
            root,
        };
        ensure_data_authority(
            data_root,
            &[
                &assets.root,
                &assets.tokenizer_file,
                &assets.tokenizer_config,
                &assets.model_config,
                &assets.model_file,
            ],
        )
        .map_err(EmbeddingFailure::caused("embed_asset_path_unsafe"))?;
        for path in [
            &assets.tokenizer_file,
            &assets.tokenizer_config,
            &assets.model_config,
            &assets.model_file,
        ] {
            if !path.is_file() {
                return Err(EmbeddingFailure::new("embed_asset_unavailable"));
            }
        }
        Ok(assets)
    }

    /// The identity hash of `files` under the model root.
    pub(super) fn aggregate_hash(&self, files: &[&str]) -> Result<String, EmbeddingFailure> {
        let mut cache = HashCache::read(&self.root);
        let mut aggregate = Sha256::new();
        for relative in files {
            let digest = cache.digest(&self.root, relative)?;
            let pair = serde_json::to_vec(&(relative, digest))
                .map_err(EmbeddingFailure::caused("embed_asset_identity_unavailable"))?;
            aggregate.update(pair);
        }
        cache.write(&self.data_root, &self.root);
        Ok(format!("{:x}", aggregate.finalize()))
    }
}

/// A file digest with the size and modification time it was computed for.
#[derive(Clone, Deserialize, Serialize)]
struct Stamped {
    bytes: u64,
    modified_ns: u128,
    sha256: String,
}

/// SHA-256 digests of the asset files, remembered by size and modification
/// time so that loading the 570 MB model does not read it all again. A file
/// whose size or time changed is hashed afresh.
#[derive(Default, Deserialize, Serialize)]
struct HashCache {
    files: std::collections::BTreeMap<String, Stamped>,
    #[serde(skip)]
    dirty: bool,
}

impl HashCache {
    fn read(root: &Path) -> Self {
        fs::read(root.join(HASH_CACHE_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn digest(&mut self, root: &Path, relative: &str) -> Result<String, EmbeddingFailure> {
        let path = root.join(relative);
        let stamp = file_stamp(&path)?;
        if let Some(known) = self.files.get(relative)
            && (known.bytes, known.modified_ns) == stamp
        {
            return Ok(known.sha256.clone());
        }
        let sha256 = hash_file(&path)?;
        self.files.insert(
            relative.to_owned(),
            Stamped {
                bytes: stamp.0,
                modified_ns: stamp.1,
                sha256: sha256.clone(),
            },
        );
        self.dirty = true;
        Ok(sha256)
    }

    /// Stores the digests. The cache only saves work, so failing to write it
    /// is not an error.
    fn write(&self, data_root: &Path, root: &Path) {
        if !self.dirty {
            return;
        }
        let path = root.join(HASH_CACHE_FILE);
        let temporary = root.join(format!("{HASH_CACHE_FILE}.{}.tmp", std::process::id()));
        if ensure_data_authority(data_root, &[&path, &temporary]).is_err() {
            return;
        }
        let stored = serde_json::to_vec(self).ok().and_then(|bytes| {
            File::create(&temporary)
                .and_then(|mut file| file.write_all(&bytes))
                .and_then(|()| fs::rename(&temporary, &path))
                .ok()
        });
        if stored.is_none() {
            let _ = fs::remove_file(&temporary);
        }
    }
}

fn file_stamp(path: &Path) -> Result<(u64, u128), EmbeddingFailure> {
    let metadata =
        fs::metadata(path).map_err(EmbeddingFailure::caused("embed_asset_identity_unavailable"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos());
    Ok((metadata.len(), modified))
}

fn hash_file(path: &Path) -> Result<String, EmbeddingFailure> {
    let mut file =
        File::open(path).map_err(EmbeddingFailure::caused("embed_asset_identity_unavailable"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(EmbeddingFailure::caused("embed_asset_identity_unavailable"))?;
        if count == 0 {
            break;
        }
        digest.update(buffer.get(..count).unwrap_or_default());
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn positive_json_integer(path: &Path, key: &str) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    value
        .get(key)?
        .as_u64()
        .and_then(|number| usize::try_from(number).ok())
        .filter(|number| *number > 0)
}
