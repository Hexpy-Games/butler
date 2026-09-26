//! Bounded source reads, staged derivatives, and content-addressed validation.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::{AppMessageFileSnapshot, GatewayApplicationError, public};
use crate::context::VisualAttachmentManifest;

const MAX_BYTES: u64 = 10 * 1024 * 1024;

pub(super) fn source(
    root: &Path,
    row: &AppMessageFileSnapshot,
) -> Result<Vec<u8>, GatewayApplicationError> {
    let bytes = read_bounded(&root.join(&row.storage_name), MAX_BYTES).map_err(|_| {
        public(
            422,
            "image_payload_invalid",
            "이미지 첨부를 처리할 수 없습니다.",
        )
    })?;
    if bytes.len() as u64 != row.size_bytes || digest(&bytes) != row.sha256 {
        return Err(public(
            409,
            "image_source_tampered",
            "Image attachment could not be verified.",
        ));
    }
    Ok(bytes)
}

pub(super) fn verified_derivative(
    root: &Path,
    manifest: &VisualAttachmentManifest,
) -> Result<Vec<u8>, GatewayApplicationError> {
    let bytes = read_bounded(&root.join(derivative_name(manifest)), MAX_BYTES).map_err(|_| {
        public(
            422,
            "image_payload_invalid",
            "이미지 첨부를 처리할 수 없습니다.",
        )
    })?;
    if bytes.len() != manifest.derivative_size_bytes || digest(&bytes) != manifest.derivative_digest
    {
        return Err(public(
            413,
            "image_payload_invalid",
            "이미지 첨부를 확인할 수 없습니다.",
        ));
    }
    Ok(bytes)
}

pub(super) fn provider_derivative(
    root: &Path,
    manifest: &VisualAttachmentManifest,
) -> Result<Vec<u8>, GatewayApplicationError> {
    let path = root.join(derivative_name(manifest));
    let file =
        File::open(path).map_err(|_| public(413, "image_payload_invalid", "derivative_missing"))?;
    if file
        .metadata()
        .map_err(|_| GatewayApplicationError::Internal)?
        .len()
        > MAX_BYTES
    {
        return Err(public(
            413,
            "image_payload_invalid",
            "payload_size_mismatch",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| public(413, "image_payload_invalid", "derivative_missing"))?;
    if bytes.len() != manifest.derivative_size_bytes {
        return Err(public(
            413,
            "image_payload_invalid",
            "payload_size_mismatch",
        ));
    }
    if digest(&bytes) != manifest.derivative_digest {
        return Err(public(
            413,
            "image_payload_invalid",
            "payload_digest_mismatch",
        ));
    }
    Ok(bytes)
}

pub(super) fn derivative_name(manifest: &VisualAttachmentManifest) -> String {
    format!("{}.visual.{}", manifest.file_id, manifest.derivative_digest)
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "image too large",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "image too large",
        ));
    }
    Ok(bytes)
}

pub(super) struct Stage {
    pub manifest: VisualAttachmentManifest,
    path: PathBuf,
}

impl Stage {
    pub(super) fn write(
        root: &Path,
        manifest: VisualAttachmentManifest,
        bytes: &[u8],
    ) -> Result<Self, GatewayApplicationError> {
        fs::create_dir_all(root).map_err(|_| GatewayApplicationError::Internal)?;
        let path = root.join(format!(".visual-stage-{}", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| GatewayApplicationError::Internal)?;
        if file
            .write_all(bytes)
            .and_then(|()| file.sync_all())
            .is_err()
        {
            let _ = fs::remove_file(&path);
            return Err(GatewayApplicationError::Internal);
        }
        Ok(Self { manifest, path })
    }

    pub(super) fn publish(&mut self, root: &Path) -> Result<(), GatewayApplicationError> {
        let destination = root.join(derivative_name(&self.manifest));
        match fs::hard_link(&self.path, &destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = read_bounded(&destination, MAX_BYTES).map_err(|_| conflict())?;
                if existing.len() != self.manifest.derivative_size_bytes
                    || digest(&existing) != self.manifest.derivative_digest
                {
                    return Err(conflict());
                }
                Ok(())
            }
            Err(_) => Err(GatewayApplicationError::Internal),
        }
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn conflict() -> GatewayApplicationError {
    public(
        409,
        "image_derivative_conflict",
        "Image derivative identity conflict.",
    )
}
