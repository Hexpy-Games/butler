use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

use crate::cognition::CognitionResult;

use super::invalid;

#[derive(Clone, Debug)]
pub(in crate::cognition::generation) struct CapturedEvidenceRef {
    pub(in crate::cognition::generation) relative_ref: String,
    pub(in crate::cognition::generation) sha256: String,
    pub(in crate::cognition::generation) file_identity: String,
}

pub(super) struct CaptureStore {
    acceptance_path: PathBuf,
    evidence_root: PathBuf,
    files: BTreeMap<String, CapturedEvidenceRef>,
}

impl CaptureStore {
    pub(super) fn new(acceptance_path: &Path, evidence_root: &Path) -> CognitionResult<Self> {
        let acceptance_path = acceptance_path
            .canonicalize()
            .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
        let evidence_root = evidence_root
            .canonicalize()
            .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
        Ok(Self {
            acceptance_path,
            evidence_root,
            files: BTreeMap::new(),
        })
    }

    pub(super) fn read_acceptance<T: DeserializeOwned>(&mut self) -> CognitionResult<(T, String)> {
        let path = self.acceptance_path.clone();
        self.read_json_at::<T>(&path, "acceptance", None)
    }

    pub(super) fn read_json<T: DeserializeOwned>(
        &mut self,
        relative_ref: &str,
        expected_sha256: &str,
    ) -> CognitionResult<T> {
        if !valid_sha(expected_sha256) || !safe_ref(relative_ref) {
            return Err(invalid("memory_acceptance_evidence_invalid"));
        }
        if relative_ref == "acceptance" {
            let path = self.acceptance_path.clone();
            return self
                .read_json_at::<T>(&path, relative_ref, Some(expected_sha256))
                .map(|(value, _)| value);
        }
        let path = self.evidence_root.join(relative_ref);
        let canonical = path
            .canonicalize()
            .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
        if !canonical.starts_with(&self.evidence_root) {
            return Err(invalid("memory_acceptance_evidence_invalid"));
        }
        self.read_json_at::<T>(&canonical, relative_ref, Some(expected_sha256))
            .map(|(value, _)| value)
    }

    pub(super) fn capture_ref(
        &mut self,
        relative_ref: &str,
        expected_sha256: &str,
    ) -> CognitionResult<()> {
        if !valid_sha(expected_sha256) || !safe_ref(relative_ref) {
            return Err(invalid("memory_acceptance_evidence_invalid"));
        }
        if relative_ref == "acceptance" {
            let path = self.acceptance_path.clone();
            self.capture_file(&path, relative_ref, Some(expected_sha256))?;
            return Ok(());
        }
        let path = self.evidence_root.join(relative_ref);
        let canonical = path
            .canonicalize()
            .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
        if !canonical.starts_with(&self.evidence_root) {
            return Err(invalid("memory_acceptance_evidence_invalid"));
        }
        self.capture_file(&canonical, relative_ref, Some(expected_sha256))?;
        Ok(())
    }

    pub(super) fn into_files(self) -> Vec<CapturedEvidenceRef> {
        self.files.into_values().collect()
    }

    fn read_json_at<T: DeserializeOwned>(
        &mut self,
        path: &Path,
        relative_ref: &str,
        expected_sha256: Option<&str>,
    ) -> CognitionResult<(T, String)> {
        let (mut file, before) = open_stable_file(path)?;
        let mut reader = HashingReader::new(&mut file);
        let mut deserializer = serde_json::Deserializer::from_reader(&mut reader);
        let value = T::deserialize(&mut deserializer)
            .map_err(|_| invalid("memory_acceptance_evidence_invalid"))?;
        deserializer
            .end()
            .map_err(|_| invalid("memory_acceptance_evidence_invalid"))?;
        drop(deserializer);
        let actual_sha256 = reader.finish();
        let after = stable_identity(&file, path)?;
        if before != after || expected_sha256.is_some_and(|expected| expected != actual_sha256) {
            return Err(invalid("memory_acceptance_evidence_changed"));
        }
        self.remember(relative_ref, actual_sha256.clone(), after)?;
        Ok((value, actual_sha256))
    }

    fn capture_file(
        &mut self,
        path: &Path,
        relative_ref: &str,
        expected_sha256: Option<&str>,
    ) -> CognitionResult<()> {
        let (mut file, before) = open_stable_file(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let actual_sha256 = format!("{:x}", hasher.finalize());
        let after = stable_identity(&file, path)?;
        if before != after || expected_sha256.is_some_and(|expected| expected != actual_sha256) {
            return Err(invalid("memory_acceptance_evidence_changed"));
        }
        self.remember(relative_ref, actual_sha256, after)
    }

    fn remember(
        &mut self,
        relative_ref: &str,
        sha256: String,
        file_identity: String,
    ) -> CognitionResult<()> {
        if let Some(prior) = self.files.get(relative_ref) {
            if prior.sha256 != sha256 || prior.file_identity != file_identity {
                return Err(invalid("memory_acceptance_evidence_changed"));
            }
            return Ok(());
        }
        self.files.insert(
            relative_ref.to_owned(),
            CapturedEvidenceRef {
                relative_ref: relative_ref.to_owned(),
                sha256,
                file_identity,
            },
        );
        Ok(())
    }
}

pub(in crate::cognition::generation) fn assert_evidence_current(
    input: &super::ValidatedEvidence,
    acceptance_path: &Path,
    evidence_root: &Path,
) -> CognitionResult<()> {
    let evidence_root = evidence_root
        .canonicalize()
        .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
    let acceptance_path = acceptance_path
        .canonicalize()
        .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;

    for expected in &input.files {
        let path = if expected.relative_ref == "acceptance" {
            acceptance_path.clone()
        } else {
            if !safe_ref(&expected.relative_ref) {
                return Err(invalid("memory_acceptance_evidence_changed"));
            }
            let path = evidence_root.join(&expected.relative_ref);
            let canonical = path
                .canonicalize()
                .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
            if !canonical.starts_with(&evidence_root) {
                return Err(invalid("memory_acceptance_evidence_changed"));
            }
            canonical
        };
        let (mut file, before) = open_stable_file(&path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let actual_sha256 = format!("{:x}", hasher.finalize());
        let after = stable_identity(&file, &path)?;
        if before != after || before != expected.file_identity || actual_sha256 != expected.sha256 {
            return Err(invalid("memory_acceptance_evidence_changed"));
        }
    }
    Ok(())
}

pub(in crate::cognition::generation) fn assert_evidence_file_facts_current(
    input: &super::ValidatedEvidence,
    acceptance_path: &Path,
    evidence_root: &Path,
) -> CognitionResult<()> {
    let evidence_root = evidence_root
        .canonicalize()
        .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
    let acceptance_path = acceptance_path
        .canonicalize()
        .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;

    for expected in &input.files {
        let path = if expected.relative_ref == "acceptance" {
            acceptance_path.clone()
        } else {
            if !safe_ref(&expected.relative_ref) {
                return Err(invalid("memory_acceptance_evidence_changed"));
            }
            let path = evidence_root.join(&expected.relative_ref);
            let canonical = path
                .canonicalize()
                .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
            if !canonical.starts_with(&evidence_root) {
                return Err(invalid("memory_acceptance_evidence_changed"));
            }
            canonical
        };
        let file = File::open(&path).map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
        if stable_identity(&file, &path)? != expected.file_identity {
            return Err(invalid("memory_acceptance_evidence_changed"));
        }
    }
    Ok(())
}

fn open_stable_file(path: &Path) -> CognitionResult<(File, String)> {
    let file = File::open(path).map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
    let before = stable_identity(&file, path)?;
    Ok((file, before))
}

fn stable_identity(file: &File, path: &Path) -> CognitionResult<String> {
    let handle = file
        .metadata()
        .map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
    let current_path =
        fs::metadata(path).map_err(|_| invalid("memory_acceptance_evidence_changed"))?;
    let handle_identity = metadata_identity(&handle);
    let path_identity = metadata_identity(&current_path);
    if handle_identity != path_identity {
        return Err(invalid("memory_acceptance_evidence_changed"));
    }
    Ok(handle_identity)
}

#[cfg(unix)]
fn metadata_identity(metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    )
}

#[cfg(not(unix))]
fn metadata_identity(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| format!("{}:{}", time.as_secs(), time.subsec_nanos()))
        .unwrap_or_default();
    format!("{}:{modified}", metadata.len())
}

pub(super) fn safe_ref(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.starts_with('\\')
        && !value.contains('\0')
        && !value.split(['/', '\\']).any(|component| component == "..")
}

pub(super) fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn valid_git_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
}

impl<R> HashingReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
        }
    }

    fn finish(self) -> String {
        format!("{:x}", self.hasher.finalize())
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..count]);
        Ok(count)
    }
}
