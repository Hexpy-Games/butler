//! Source-phase guard and observation for reviewed workspace file effects.
//! The registered mutation owner still performs its own guarded commit.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::path_guard::{MutationGuardInput, resolve_workspace_mutation_guard};

#[derive(Clone)]
pub(crate) struct EffectFileScope {
    pub workspace: PathBuf,
    pub butler_data: PathBuf,
    pub protected_roots: Vec<PathBuf>,
    pub installation_root: Option<PathBuf>,
}

/// Failures to resolve or observe the target of a write/edit file effect.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum EffectFileError {
    /// The target's containment in the workspace could not be resolved.
    #[error("write_file target containment could not be observed.")]
    ContainmentUnavailable {
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The mutation guard rejected the target; `reason` is the guard's wire code.
    #[error("write_file target is outside the admitted workspace boundary.")]
    OutsideBoundary { reason: &'static str },
    /// The existing file to edit could not be observed.
    #[error("The existing workspace file could not be observed for editing.")]
    EditTargetUnobservable {
        #[source]
        source: Arc<dyn std::error::Error + Send + Sync>,
    },
    /// The edit target exists but is not a regular file.
    #[error("edit_file only changes an existing regular workspace file.")]
    EditTargetNotRegularFile,
    /// The edit target contains NUL bytes in its first 4 KiB.
    #[error("edit_file supports valid UTF-8 text files only.")]
    EditTargetBinary,
    /// The edit target is not valid UTF-8.
    #[error("edit_file supports valid UTF-8 text files only.")]
    EditTargetInvalidUtf8 {
        #[source]
        source: std::string::FromUtf8Error,
    },
    /// The write target exists but is not a regular file.
    #[error("write_file target is not a regular file.")]
    WriteTargetNotFile,
    /// The write target's bytes could not be read.
    #[error("write_file target bytes could not be observed.")]
    WriteTargetUnobservable {
        #[source]
        source: Arc<dyn std::error::Error + Send + Sync>,
    },
}

impl EffectFileError {
    /// The wire code reported with the effect's failure.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::ContainmentUnavailable { .. } => "workspace_target_unavailable",
            Self::OutsideBoundary { reason } => reason,
            Self::EditTargetUnobservable { .. } | Self::WriteTargetUnobservable { .. } => {
                "workspace_target_observation_failed"
            }
            Self::EditTargetNotRegularFile => "target_not_regular_file",
            Self::EditTargetBinary => "binary_file_not_supported",
            Self::EditTargetInvalidUtf8 { .. } => "invalid_utf8",
            Self::WriteTargetNotFile => "workspace_target_not_file",
        }
    }

    /// The user-facing message; identical to `Display`.
    pub(crate) fn message(&self) -> String {
        self.to_string()
    }

    fn containment(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::ContainmentUnavailable {
            source: Some(Arc::new(source)),
        }
    }

    fn edit_target(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::EditTargetUnobservable {
            source: Arc::new(source),
        }
    }

    fn write_target(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::WriteTargetUnobservable {
            source: Arc::new(source),
        }
    }
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
        .map_err(EffectFileError::containment)?;
        if let Some(reason) = guarded.reason {
            return Err(EffectFileError::OutsideBoundary { reason });
        }
        let identity = guarded.real.clone().or_else(|| guarded.absolute.clone());
        match (guarded.absolute, identity) {
            (Some(absolute), Some(identity)) => Ok(GuardedEffectFile { absolute, identity }),
            _ => Err(EffectFileError::ContainmentUnavailable { source: None }),
        }
    })
    .await
    .map_err(EffectFileError::containment)?
}

/// Source edit preparation reads current UTF-8 only after the same guarded target resolution.
pub(crate) async fn read_effect_edit_target(
    scope: &EffectFileScope,
    path: &str,
) -> Result<(String, String, PathBuf), EffectFileError> {
    let guarded = guard_effect_file(scope, path).await?;
    tokio::task::spawn_blocking(move || {
        let metadata =
            std::fs::symlink_metadata(&guarded.absolute).map_err(EffectFileError::edit_target)?;
        if !metadata.file_type().is_file() {
            return Err(EffectFileError::EditTargetNotRegularFile);
        }
        let bytes = std::fs::read(&guarded.absolute).map_err(EffectFileError::edit_target)?;
        if bytes.iter().take(4096).any(|byte| *byte == 0) {
            return Err(EffectFileError::EditTargetBinary);
        }
        let text = String::from_utf8(bytes)
            .map_err(|source| EffectFileError::EditTargetInvalidUtf8 { source })?;
        let sha = format!("{:x}", Sha256::digest(text.as_bytes()));
        Ok((text, sha, guarded.identity))
    })
    .await
    .map_err(EffectFileError::edit_target)?
}

pub(crate) async fn observe_effect_file(target: &GuardedEffectFile) -> EffectFileObservation {
    let path = target.absolute.clone();
    tokio::task::spawn_blocking(move || {
        let observed = (|| -> std::io::Result<EffectFileObservation> {
            let metadata = std::fs::metadata(&path)?;
            if !metadata.is_file() {
                return Ok(EffectFileObservation::Unavailable(
                    EffectFileError::WriteTargetNotFile,
                ));
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
            Err(error) => EffectFileObservation::Unavailable(EffectFileError::write_target(error)),
        }
    })
    .await
    .unwrap_or_else(|error| {
        EffectFileObservation::Unavailable(EffectFileError::write_target(error))
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
