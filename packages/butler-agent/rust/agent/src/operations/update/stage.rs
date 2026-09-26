use std::{
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
};
use tokio_util::sync::CancellationToken;

use super::manifest::AppArtifact;

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
) -> Result<String, String> {
    let url = artifact
        .url
        .as_deref()
        .ok_or("update_artifact_url_missing")?;
    let sha256 = artifact
        .sha256
        .as_deref()
        .ok_or("update_artifact_sha256_missing")?;
    let name = artifact_name(url)?;
    let label = format!("updates/artifacts/{name}");
    download_to_label(client, shutdown, data, installation, url, sha256, &label).await
}

pub(super) async fn download_to_label(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    data: &Path,
    installation: &Path,
    url: &str,
    sha256: &str,
    label: &str,
) -> Result<String, String> {
    let target = target(data, installation, label).await?;
    let temp = TempFile(unique_temp(&target));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .await
        .map_err(|_| "update_stage_unavailable")?;
    let mut hash = Sha256::new();
    if url.starts_with("http://") || url.starts_with("https://") {
        let response = tokio::select! {
            _ = shutdown.cancelled() => return Err("update_cancelled".into()),
            result = client.get(url).send() => result.map_err(|_| "update_artifact_unavailable")?,
        };
        if !response.status().is_success() {
            return Err("update_artifact_unavailable".into());
        }
        let mut stream = response.bytes_stream();
        while let Some(chunk) = tokio::select! {
            _ = shutdown.cancelled() => return Err("update_cancelled".into()),
            item = stream.next() => item,
        } {
            let chunk = chunk.map_err(|_| "update_artifact_unavailable")?;
            hash.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|_| "update_stage_unavailable")?;
        }
    } else {
        let source = if url.starts_with("file://") {
            url::Url::parse(url)
                .ok()
                .and_then(|url| url.to_file_path().ok())
                .ok_or("update_artifact_source_invalid")?
        } else {
            PathBuf::from(url)
        };
        if !source.is_absolute() {
            return Err("update_artifact_source_invalid".into());
        }
        let mut input = fs::File::open(source)
            .await
            .map_err(|_| "update_artifact_unavailable")?;
        let mut buf = [0u8; 65536];
        loop {
            let count = tokio::select! {
                _ = shutdown.cancelled() => return Err("update_cancelled".into()),
                result = tokio::io::AsyncReadExt::read(&mut input, &mut buf) => result.map_err(|_| "update_artifact_unavailable")?,
            };
            if count == 0 {
                break;
            }
            hash.update(&buf[..count]);
            output
                .write_all(&buf[..count])
                .await
                .map_err(|_| "update_stage_unavailable")?;
        }
    }
    output
        .sync_all()
        .await
        .map_err(|_| "update_stage_unavailable")?;
    drop(output);
    if format!("{:x}", hash.finalize()) != sha256 {
        return Err("update_artifact_sha256_mismatch".into());
    }
    if shutdown.is_cancelled() {
        return Err("update_cancelled".into());
    }
    guard(data, installation, &target).await?;
    if shutdown.is_cancelled() {
        return Err("update_cancelled".into());
    }
    fs::rename(&temp.0, &target)
        .await
        .map_err(|_| "update_stage_unavailable")?;
    Ok(label.to_owned())
}

pub(super) async fn write_json(
    data: &Path,
    installation: &Path,
    label: &str,
    value: &Value,
) -> Result<(), String> {
    let target = target(data, installation, label).await?;
    let temp = TempFile(unique_temp(&target));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .await
        .map_err(|_| "update_stage_unavailable")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "update_status_invalid")?;
    output
        .write_all(&bytes)
        .await
        .map_err(|_| "update_stage_unavailable")?;
    output
        .sync_all()
        .await
        .map_err(|_| "update_stage_unavailable")?;
    drop(output);
    guard(data, installation, &target).await?;
    fs::rename(&temp.0, &target)
        .await
        .map_err(|_| "update_stage_unavailable".into())
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

async fn target(data: &Path, installation: &Path, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(label);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("update_stage_path_invalid".into());
    }
    let target = data.join(path);
    guard(data, installation, &target).await?;
    fs::create_dir_all(target.parent().ok_or("update_stage_path_invalid")?)
        .await
        .map_err(|_| "update_stage_unavailable")?;
    guard(data, installation, &target).await?;
    Ok(target)
}

async fn guard(data: &Path, installation: &Path, target: &Path) -> Result<(), String> {
    if data.starts_with(installation) || installation.starts_with(data) || !target.starts_with(data)
    {
        return Err("update_stage_path_invalid".into());
    }
    let mut at = data.to_path_buf();
    for component in target
        .strip_prefix(data)
        .map_err(|_| "update_stage_path_invalid")?
        .components()
    {
        if !matches!(component, Component::Normal(_)) {
            return Err("update_stage_path_invalid".into());
        }
        at.push(component.as_os_str());
        match fs::symlink_metadata(&at).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("update_stage_path_invalid".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("update_stage_unavailable".into()),
        }
    }
    Ok(())
}

fn artifact_name(source: &str) -> Result<String, String> {
    let path = if source.starts_with("http://")
        || source.starts_with("https://")
        || source.starts_with("file://")
    {
        url::Url::parse(source)
            .map_err(|_| "update_artifact_source_invalid")?
            .path()
            .to_owned()
    } else {
        source.into()
    };
    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or("update_artifact_name_invalid")?;
    Ok(name.into())
}

fn unique_temp(target: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    target.with_extension(format!("tmp-{}-{stamp}", std::process::id()))
}
