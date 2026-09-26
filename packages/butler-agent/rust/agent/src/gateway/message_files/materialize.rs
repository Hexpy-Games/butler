//! Read every candidate before installing responder files, as the source does.

use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::{names, path::AllowedPaths};
use crate::gateway::{
    AppIdentityClock, ArtifactMaterializationRequest, GatewayApplicationError,
    MaterializedResponderFile,
};

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_FILES: usize = 12;

struct PendingFile {
    staged: Option<PathBuf>,
    name: names::SafeName,
    mime: String,
    kind: &'static str,
    size: u64,
    digest: String,
}

struct Staging(Option<PathBuf>);
impl Drop for Staging {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub(super) fn run(
    root: &Path,
    clock: &dyn AppIdentityClock,
    request: ArtifactMaterializationRequest,
) -> Result<Vec<MaterializedResponderFile>, GatewayApplicationError> {
    let paths = AllowedPaths::new(&request.allowed_roots).map_err(internal)?;
    let mut seen = HashSet::new();
    let mut keys: HashSet<Vec<u16>> = request
        .existing_content_keys
        .iter()
        .map(|key| key.encode_utf16().collect())
        .collect();
    let mut pending = Vec::new();
    let mut staging = Staging(None);
    for candidate in &request.candidates {
        let Some(path) = paths.first_readable(candidate, &seen) else {
            continue;
        };
        seen.insert(path.clone());
        let fallback = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("attachment");
        let source_name = if candidate.name.is_empty() {
            fallback
        } else {
            &candidate.name
        };
        let name = names::safe_name(source_name);
        let path_string = path.to_string_lossy();
        let mime = names::normalized_mime(
            candidate
                .mime_type
                .as_deref()
                .unwrap_or_else(|| names::mime_for_path(&path_string)),
            &name.stored,
        );
        let kind = names::kind(&mime, &name.stored);
        let (size, digest, bytes) = read_and_hash(&path, pending.len() < MAX_FILES)?;
        if size == 0 {
            continue;
        }
        let key = content_key(&name.units, &mime, size, &digest);
        if !keys.insert(key) {
            continue;
        }
        if pending.len() >= MAX_FILES {
            continue;
        }
        let staged = if let Some(bytes) = bytes {
            let directory = match &staging.0 {
                Some(directory) => directory,
                None => {
                    fs::create_dir_all(root).map_err(internal)?;
                    let directory =
                        root.join(format!(".artifact-staging-{}", uuid::Uuid::new_v4()));
                    fs::create_dir(&directory).map_err(internal)?;
                    staging.0.insert(directory)
                }
            };
            let path = directory.join(pending.len().to_string());
            let mut file = File::create(&path).map_err(internal)?;
            file.write_all(&bytes).map_err(internal)?;
            Some(path)
        } else {
            None // Oversize: source checks the 10 MiB limit when files are created.
        };
        pending.push(PendingFile {
            staged,
            name,
            mime,
            kind,
            size,
            digest,
        });
    }

    let mut files = Vec::with_capacity(pending.len());
    for item in pending {
        if item.size > MAX_BYTES as u64 {
            return Err(public(
                413,
                "message_file_too_large",
                "Attachment file is too large.",
            ));
        }
        let id = format!("file-{}", clock.new_uuid());
        if !valid_file_id(&id) {
            return Err(GatewayApplicationError::Internal);
        }
        let created_at = clock.now_iso();
        let staged = item.staged.ok_or(GatewayApplicationError::Internal)?;
        fs::rename(staged, root.join(&id)).map_err(internal)?;
        files.push(MaterializedResponderFile {
            id: id.clone(),
            kind: item.kind.into(),
            mime_type: item.mime,
            safe_name: item.name.stored,
            size_bytes: item.size,
            sha256: item.digest,
            storage_name: id,
            created_at,
        });
    }
    Ok(files)
}

fn content_key(name: &[u16], mime: &str, size: u64, digest: &str) -> Vec<u16> {
    let mut key = Vec::with_capacity(name.len() + mime.len() + digest.len() + 24);
    key.extend_from_slice(name);
    key.push(0);
    key.extend(mime.encode_utf16());
    key.push(0);
    key.extend(size.to_string().encode_utf16());
    key.push(0);
    key.extend(digest.encode_utf16());
    key
}

fn read_and_hash(
    path: &Path,
    buffer: bool,
) -> Result<(u64, String, Option<Vec<u8>>), GatewayApplicationError> {
    let mut file = File::open(path).map_err(internal)?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut bytes = buffer.then(Vec::new);
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let n = file.read(&mut chunk).map_err(internal)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        digest.update(&chunk[..n]);
        if size > MAX_BYTES as u64 {
            bytes = None;
        } else if let Some(buffer) = &mut bytes {
            buffer.extend_from_slice(&chunk[..n]);
        }
    }
    Ok((size, format!("{:x}", digest.finalize()), bytes))
}

fn valid_file_id(id: &str) -> bool {
    id.len() == 41
        && id.starts_with("file-")
        && id[5..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn internal(_: std::io::Error) -> GatewayApplicationError {
    GatewayApplicationError::Internal
}
fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
    }
}
