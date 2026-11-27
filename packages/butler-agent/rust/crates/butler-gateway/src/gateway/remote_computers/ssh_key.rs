use super::{AppSetupPort, HostInput, HttpError, remote_error, ssh, ssh_password};
use butler_models::models::DeviceSshKey;
use butler_platform::{instance, secrets::SecretText, secure_fs};
use parking_lot::Mutex;
use serde::Deserialize;
use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::task::spawn_blocking;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

static SOURCE: OnceLock<Arc<dyn AppSetupPort>> = OnceLock::new();
static FOLDER: OnceLock<PathBuf> = OnceLock::new();
static CACHE: Mutex<Option<(String, Zeroizing<String>)>> = Mutex::new(None);

pub(in crate::gateway) async fn register(setup: Arc<dyn AppSetupPort>, root: &Path) {
    if SOURCE.set(setup).is_err() {
        return;
    }
    let folder = root.join("tmp/ssh-keys");
    let path = folder.clone();
    let prepared = spawn_blocking(move || -> io::Result<()> {
        secure_fs::create_private_dir_all(&path)?;
        if !fs::symlink_metadata(&path)?.is_dir() {
            return Err(io::Error::other("Expected an SSH key directory"));
        }
        secure_fs::protect_folder(&path)
            .or_else(|| secure_fs::restrict_directory(&path))
            .unwrap_or(Ok(()))?;
        for entry in fs::read_dir(&path)? {
            secure_fs::remove_tree(&entry?.path())?;
        }
        Ok(())
    })
    .await;
    if matches!(prepared, Ok(Ok(()))) {
        let _ = FOLDER.set(folder);
    }
}

#[derive(Deserialize)]
struct Record {
    public_key: String,
}

pub(super) async fn public_key() -> Result<Option<String>, HttpError> {
    let folder = FOLDER.get().ok_or(HttpError::Internal)?;
    let root = folder
        .parent()
        .and_then(Path::parent)
        .ok_or(HttpError::Internal)?;
    let path = root.join("auth/device-ssh-key.json");
    let public = spawn_blocking(move || match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Record>(&bytes)
            .map(|record| Some(record.public_key))
            .map_err(|_| HttpError::Internal),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(HttpError::Internal),
    })
    .await
    .map_err(|_| HttpError::Internal)??;
    if public.is_none() {
        *CACHE.lock() = None;
    }
    Ok(public)
}

async fn private_key() -> Result<SecretText, HttpError> {
    let public = public_key().await?.ok_or_else(auth_failed)?;
    if let Some((_, private)) = CACHE.lock().as_ref().filter(|(line, _)| *line == public) {
        return Ok(SecretText::new(private.to_string()));
    }
    let key = SOURCE
        .get()
        .ok_or(HttpError::Internal)?
        .device_ssh_key(None)
        .await
        .map_err(|_| auth_failed())?
        .ok_or_else(auth_failed)?;
    let private = SecretText::new(key.private.expose().to_owned());
    cache(key);
    Ok(private)
}

fn cache(key: DeviceSshKey) -> String {
    *CACHE.lock() = Some((key.public.clone(), key.private.into_zeroizing()));
    key.public
}

fn auth_failed() -> HttpError {
    remote_error("ssh_auth_failed", "SSH key login failed.")
}

pub(super) struct KeyFile(PathBuf);

impl KeyFile {
    async fn write(secret: &SecretText) -> Result<Self, HttpError> {
        let folder = FOLDER.get().ok_or(HttpError::Internal)?;
        let path = folder.join(uuid::Uuid::new_v4().to_string());
        let text = Zeroizing::new(secret.expose().to_owned());
        spawn_blocking(move || -> io::Result<Self> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            secure_fs::owner_only(&mut options);
            let mut file = options.open(&path)?;
            let guard = Self(path);
            file.write_all(text.as_bytes())?;
            if !text.ends_with('\n') {
                file.write_all(b"\n")?;
            }
            Ok(guard)
        })
        .await
        .map_err(|_| HttpError::Internal)?
        .map_err(|_| HttpError::Internal)
    }
}

impl Drop for KeyFile {
    fn drop(&mut self) {
        let path = self.0.clone();
        spawn_blocking(move || {
            let _ = fs::remove_file(path);
        });
    }
}

pub(super) async fn ensure(cancel: CancellationToken) -> Result<String, HttpError> {
    if let Some(public) = public_key().await? {
        return Ok(public);
    }
    let folder = FOLDER.get().ok_or(HttpError::Internal)?;
    let directory = folder.join(format!("{}.d", uuid::Uuid::new_v4()));
    let path = directory.clone();
    spawn_blocking(move || secure_fs::create_private_dir(&path))
        .await
        .map_err(|_| HttpError::Internal)?
        .map_err(|_| HttpError::Internal)?;
    let result = generate(directory.join("key"), cancel).await;
    spawn_blocking(move || secure_fs::remove_tree(&directory))
        .await
        .map_err(|_| HttpError::Internal)?
        .map_err(|_| HttpError::Internal)?;
    let key = SOURCE
        .get()
        .ok_or(HttpError::Internal)?
        .device_ssh_key(Some(result?))
        .await?
        .ok_or(HttpError::Internal)?;
    Ok(cache(key))
}

async fn generate(path: PathBuf, cancel: CancellationToken) -> Result<DeviceSshKey, HttpError> {
    let host: String = instance::host_name()
        .unwrap_or_default()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        .take(64)
        .collect();
    let host = if host.is_empty() { "device" } else { &host };
    let mut args = ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C"]
        .map(str::to_owned)
        .to_vec();
    args.extend([
        format!("butler@{host}"),
        "-f".into(),
        path.to_string_lossy().into_owned(),
    ]);
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(Vec::new()),
        Duration::from_secs(20),
        cancel,
    )
    .await?;
    if output.exit_code != Some(0) {
        return Err(ssh_password::install_failed());
    }
    spawn_blocking(move || -> io::Result<DeviceSshKey> {
        let private = SecretText::new(fs::read_to_string(&path)?);
        let public = fs::read_to_string(path.with_extension("pub"))?
            .trim_end()
            .to_owned();
        Ok(DeviceSshKey { private, public })
    })
    .await
    .map_err(|_| HttpError::Internal)?
    .map_err(|_| HttpError::Internal)
}

pub(super) async fn managed_target(input: &mut HostInput) -> Result<KeyFile, HttpError> {
    let key = KeyFile::write(&private_key().await?).await?;
    input.identity = Some(key.0.clone());
    Ok(key)
}
