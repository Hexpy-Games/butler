use std::{
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::operations::update::{UpdateCode, UpdateError};
use futures_util::StreamExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
};
use tokio_util::sync::CancellationToken;

use super::manifest::AppArtifact;

/// The largest archive a download may be, in bytes; `BUTLER_INSTALL_MAX_BYTES`
/// lowers it (tests).
const MAX_ARCHIVE_BYTES: u64 = 2 << 30;

fn archive_cap() -> u64 {
    std::env::var("BUTLER_INSTALL_MAX_BYTES")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(MAX_ARCHIVE_BYTES, |cap| cap.min(MAX_ARCHIVE_BYTES))
}

struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) async fn download(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    data: &Path,
    installation: &Path,
    artifact: &AppArtifact,
) -> Result<String, UpdateError> {
    let url = artifact
        .url
        .as_deref()
        .ok_or(UpdateCode::UpdateArtifactUrlMissing)?;
    let sha256 = artifact
        .sha256
        .as_deref()
        .ok_or(UpdateCode::UpdateArtifactSha256Missing)?;
    let name = artifact_name(url)?;
    let label = format!("updates/artifacts/{name}");
    Box::pin(download_to_label(
        client,
        shutdown,
        data,
        installation,
        url,
        sha256,
        &label,
    ))
    .await
}

pub(super) async fn download_to_label(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    data: &Path,
    installation: &Path,
    url: &str,
    sha256: &str,
    label: &str,
) -> Result<String, UpdateError> {
    if !super::source::secure_source(url) {
        return Err(UpdateCode::UpdateArtifactSourceInvalid.into());
    }
    let target = target(data, installation, label).await?;
    let temp = TempFile(unique_temp(&target));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))?;
    let mut hash = Sha256::new();
    let mut sink = Sink {
        output: &mut output,
        hash: &mut hash,
        received: 0,
        cap: archive_cap(),
    };
    if url.starts_with("http://") || url.starts_with("https://") {
        fetch_http(client, shutdown, url, &mut sink).await?;
    } else {
        copy_local(shutdown, url, &mut sink).await?;
    }
    output
        .sync_all()
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))?;
    drop(output);
    if format!("{:x}", hash.finalize()) != sha256 {
        return Err(UpdateCode::UpdateArtifactSha256Mismatch.into());
    }
    if shutdown.is_cancelled() {
        return Err(UpdateCode::UpdateCancelled.into());
    }
    guard(data, installation, &target).await?;
    if shutdown.is_cancelled() {
        return Err(UpdateCode::UpdateCancelled.into());
    }
    fs::rename(&temp.0, &target)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))?;
    Ok(label.to_owned())
}

/// Where a download goes: the file, its digest, and the size so far, which
/// may not pass the cap.
struct Sink<'a> {
    output: &'a mut fs::File,
    hash: &'a mut Sha256,
    received: u64,
    cap: u64,
}

impl Sink<'_> {
    async fn write(&mut self, chunk: &[u8]) -> Result<(), UpdateError> {
        self.received += chunk.len() as u64;
        if self.received > self.cap {
            return Err(UpdateCode::InstallArchiveTooLarge.into());
        }
        self.hash.update(chunk);
        self.output
            .write_all(chunk)
            .await
            .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))
    }
}

async fn fetch_http(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    url: &str,
    sink: &mut Sink<'_>,
) -> Result<(), UpdateError> {
    let response = tokio::select! {
        () = shutdown.cancelled() => return Err(UpdateCode::UpdateCancelled.into()),
        result = client.get(url).send() => result.map_err(|source| UpdateError::caused(UpdateCode::UpdateArtifactUnavailable, source))?,
    };
    if !response.status().is_success() {
        return Err(UpdateCode::UpdateArtifactUnavailable.into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > sink.cap)
    {
        return Err(UpdateCode::InstallArchiveTooLarge.into());
    }
    let mut stream = response.bytes_stream();
    while let Some(chunk) = tokio::select! {
        () = shutdown.cancelled() => return Err(UpdateCode::UpdateCancelled.into()),
        item = stream.next() => item,
    } {
        let chunk = chunk
            .map_err(|source| UpdateError::caused(UpdateCode::UpdateArtifactUnavailable, source))?;
        sink.write(&chunk).await?;
    }
    Ok(())
}

async fn copy_local(
    shutdown: &CancellationToken,
    url: &str,
    sink: &mut Sink<'_>,
) -> Result<(), UpdateError> {
    let source = if url.starts_with("file://") {
        url::Url::parse(url)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .ok_or(UpdateCode::UpdateArtifactSourceInvalid)?
    } else {
        PathBuf::from(url)
    };
    if !source.is_absolute() {
        return Err(UpdateCode::UpdateArtifactSourceInvalid.into());
    }
    let mut input = fs::File::open(source)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateArtifactUnavailable, source))?;
    let mut buf = vec![0u8; 65536];
    loop {
        let count = tokio::select! {
            () = shutdown.cancelled() => return Err(UpdateCode::UpdateCancelled.into()),
            result = tokio::io::AsyncReadExt::read(&mut input, &mut buf) => result.map_err(|source| UpdateError::caused(UpdateCode::UpdateArtifactUnavailable, source))?,
        };
        if count == 0 {
            return Ok(());
        }
        sink.write(&buf[..count]).await?;
    }
}

pub(super) async fn write_json(
    data: &Path,
    installation: &Path,
    label: &str,
    value: &Value,
) -> Result<(), UpdateError> {
    let target = target(data, installation, label).await?;
    let temp = TempFile(unique_temp(&target));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))?;
    let bytes = serde_json::to_vec(value)
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStatusInvalid, source))?;
    output
        .write_all(&bytes)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))?;
    output
        .sync_all()
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))?;
    drop(output);
    guard(data, installation, &target).await?;
    fs::rename(&temp.0, &target)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))
}

pub(super) async fn read_json(data: &Path, installation: &Path, label: &str) -> Option<Value> {
    let path = data.join(label);
    guard(data, installation, &path).await.ok()?;
    if let Ok(metadata) = fs::symlink_metadata(&path).await
        && !metadata.file_type().is_file()
    {
        return None;
    }
    serde_json::from_slice(&fs::read(path).await.ok()?).ok()
}

/// Removes a staged archive once it is installed, so downloads do not
/// accumulate under DATA. A file that cannot be reached safely stays.
pub(super) async fn remove_staged(data: &Path, installation: &Path, label: &str) {
    let relative = Path::new(label);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return;
    }
    let path = data.join(relative);
    if guard(data, installation, &path).await.is_ok() {
        let _ = fs::remove_file(path).await;
    }
}

pub(super) async fn staged_file_exists(data: &Path, installation: &Path, label: &str) -> bool {
    let relative = Path::new(label);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return false;
    }
    let path = data.join(relative);
    if guard(data, installation, &path).await.is_err() {
        return false;
    }
    fs::symlink_metadata(path)
        .await
        .is_ok_and(|metadata| metadata.file_type().is_file())
}

async fn target(data: &Path, installation: &Path, label: &str) -> Result<PathBuf, UpdateError> {
    let path = Path::new(label);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(UpdateCode::UpdateStagePathInvalid.into());
    }
    let target = data.join(path);
    guard(data, installation, &target).await?;
    fs::create_dir_all(target.parent().ok_or(UpdateCode::UpdateStagePathInvalid)?)
        .await
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStageUnavailable, source))?;
    guard(data, installation, &target).await?;
    Ok(target)
}

async fn guard(data: &Path, installation: &Path, target: &Path) -> Result<(), UpdateError> {
    if data.starts_with(installation) || installation.starts_with(data) || !target.starts_with(data)
    {
        return Err(UpdateCode::UpdateStagePathInvalid.into());
    }
    let mut at = data.to_path_buf();
    for component in target
        .strip_prefix(data)
        .map_err(|source| UpdateError::caused(UpdateCode::UpdateStagePathInvalid, source))?
        .components()
    {
        if !matches!(component, Component::Normal(_)) {
            return Err(UpdateCode::UpdateStagePathInvalid.into());
        }
        at.push(component.as_os_str());
        match fs::symlink_metadata(&at).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(UpdateCode::UpdateStagePathInvalid.into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(UpdateCode::UpdateStageUnavailable.into()),
        }
    }
    Ok(())
}

fn artifact_name(source: &str) -> Result<String, UpdateError> {
    let path = if source.starts_with("http://")
        || source.starts_with("https://")
        || source.starts_with("file://")
    {
        url::Url::parse(source)
            .map_err(|source| UpdateError::caused(UpdateCode::UpdateArtifactSourceInvalid, source))?
            .path()
            .to_owned()
    } else {
        source.into()
    };
    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or(UpdateCode::UpdateArtifactNameInvalid)?;
    Ok(name.into())
}

fn unique_temp(target: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    target.with_extension(format!("tmp-{}-{stamp}", std::process::id()))
}
