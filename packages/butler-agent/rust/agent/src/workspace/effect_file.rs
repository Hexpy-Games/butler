//! Source-phase guard and observation for reviewed workspace file effects.
//! The registered mutation owner still performs its own guarded commit.

use std::io::Read;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use super::path_guard::{MutationGuardInput, resolve_workspace_mutation_guard};

#[derive(Clone)]
pub(crate) struct EffectFileScope {
    pub workspace: PathBuf,
    pub butler_data: PathBuf,
    pub protected_roots: Vec<PathBuf>,
    pub installation_root: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub(crate) struct EffectFileError {
    pub code: String,
    pub message: &'static str,
}

#[derive(Clone, Debug)]
pub(crate) struct GuardedEffectFile {
    absolute: PathBuf,
    identity: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) enum EffectFileObservation {
    File { bytes: usize, sha256: String },
    Missing,
    Unavailable(EffectFileError),
}

pub(crate) async fn guard_effect_file(
    scope: &EffectFileScope,
    path: &str,
) -> Result<GuardedEffectFile, EffectFileError> {
    let scope = scope.clone();
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut protected = scope.protected_roots;
        protected.push(scope.butler_data.join("project-ledger/projects"));
        let guarded = resolve_workspace_mutation_guard(MutationGuardInput {
            root: &scope.workspace,
            requested: &path,
            relative_only: false,
            allow_missing_leaf: true,
            installation_root: scope.installation_root.as_deref(),
            protected_roots: &protected,
        })
        .map_err(|_| EffectFileError {
            code: "workspace_target_unavailable".into(),
            message: "write_file target containment could not be observed.",
        })?;
        if let Some(reason) = guarded.reason {
            return Err(EffectFileError {
                code: reason.into(),
                message: "write_file target is outside the admitted workspace boundary.",
            });
        }
        let identity = guarded.real.clone().or_else(|| guarded.absolute.clone());
        match (guarded.absolute, identity) {
            (Some(absolute), Some(identity)) => Ok(GuardedEffectFile { absolute, identity }),
            _ => Err(EffectFileError {
                code: "workspace_target_unavailable".into(),
                message: "write_file target containment could not be observed.",
            }),
        }
    })
    .await
    .map_err(|_| EffectFileError {
        code: "workspace_target_unavailable".into(),
        message: "write_file target containment could not be observed.",
    })?
}

/// Source edit preparation reads current UTF-8 only after the same guarded target resolution.
pub(crate) async fn read_effect_edit_target(
    scope: &EffectFileScope,
    path: &str,
) -> Result<(String, String, PathBuf), EffectFileError> {
    let guarded = guard_effect_file(scope, path).await?;
    tokio::task::spawn_blocking(move || {
        let metadata =
            std::fs::symlink_metadata(&guarded.absolute).map_err(|_| EffectFileError {
                code: "workspace_target_observation_failed".into(),
                message: "The existing workspace file could not be observed for editing.",
            })?;
        if !metadata.file_type().is_file() {
            return Err(EffectFileError {
                code: "target_not_regular_file".into(),
                message: "edit_file only changes an existing regular workspace file.",
            });
        }
        let bytes = std::fs::read(&guarded.absolute).map_err(|_| EffectFileError {
            code: "workspace_target_observation_failed".into(),
            message: "The existing workspace file could not be observed for editing.",
        })?;
        if bytes.iter().take(4096).any(|byte| *byte == 0) {
            return Err(EffectFileError {
                code: "binary_file_not_supported".into(),
                message: "edit_file supports valid UTF-8 text files only.",
            });
        }
        let text = String::from_utf8(bytes).map_err(|_| EffectFileError {
            code: "invalid_utf8".into(),
            message: "edit_file supports valid UTF-8 text files only.",
        })?;
        let sha = format!("{:x}", Sha256::digest(text.as_bytes()));
        Ok((text, sha, guarded.identity))
    })
    .await
    .map_err(|_| EffectFileError {
        code: "workspace_target_observation_failed".into(),
        message: "The existing workspace file could not be observed for editing.",
    })?
}

pub(crate) async fn observe_effect_file(target: &GuardedEffectFile) -> EffectFileObservation {
    let path = target.absolute.clone();
    tokio::task::spawn_blocking(move || {
        let observed = (|| -> std::io::Result<EffectFileObservation> {
            let metadata = std::fs::metadata(&path)?;
            if !metadata.is_file() {
                return Ok(EffectFileObservation::Unavailable(EffectFileError {
                    code: "workspace_target_not_file".into(),
                    message: "write_file target is not a regular file.",
                }));
            }
            let mut file = std::fs::File::open(&path)?;
            let mut chunk = vec![0_u8; 64 * 1024];
            let mut bytes = 0_usize;
            let mut sha256 = Sha256::new();
            loop {
                let length = match file.read(&mut chunk) {
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    result => result?,
                };
                if length == 0 {
                    break;
                }
                bytes = bytes
                    .checked_add(length)
                    .ok_or_else(|| std::io::Error::other("workspace target byte count overflow"))?;
                sha256.update(&chunk[..length]);
            }
            Ok(EffectFileObservation::File {
                bytes,
                sha256: format!("{:x}", sha256.finalize()),
            })
        })();
        match observed {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                EffectFileObservation::Missing
            }
            Err(_) => EffectFileObservation::Unavailable(EffectFileError {
                code: "workspace_target_observation_failed".into(),
                message: "write_file target bytes could not be observed.",
            }),
        }
    })
    .await
    .unwrap_or_else(|_| {
        EffectFileObservation::Unavailable(EffectFileError {
            code: "workspace_target_observation_failed".into(),
            message: "write_file target bytes could not be observed.",
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn observation_hashes_large_file_across_chunks_with_exact_byte_count() {
        let root =
            std::env::temp_dir().join(format!("butler-effect-observe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let bytes = vec![0xA5_u8; 2 * 64 * 1024 + 17];
        let path = root.join("large.bin");
        std::fs::write(&path, &bytes).unwrap();
        let observed = observe_effect_file(&GuardedEffectFile {
            identity: path.clone(),
            absolute: path,
        })
        .await;
        let EffectFileObservation::File {
            bytes: length,
            sha256,
        } = observed
        else {
            panic!("expected file observation")
        };
        assert_eq!(length, bytes.len());
        assert_eq!(sha256, format!("{:x}", Sha256::digest(&bytes)));
        std::fs::remove_dir_all(root).unwrap();
    }
}
