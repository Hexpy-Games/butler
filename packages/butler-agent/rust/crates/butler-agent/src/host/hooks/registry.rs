use super::*;
use std::io::{Read, Write};
const CAP: u64 = 256 * 1024;
fn stamp(path: &std::path::Path) -> Result<Option<(SystemTime, u64)>, String> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(Some((
            meta.modified().map_err(|e| e.to_string())?,
            meta.len(),
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn read(path: &std::path::Path) -> Result<HookConfig, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > CAP {
        return Err("Hook file exceeds 256 KiB".into());
    }
    let config: HookConfig = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    config.validate()?;
    Ok(config)
}
pub(super) async fn reload(hooks: &Arc<Hooks>) -> Result<(), String> {
    let _guard = hooks.mutation.lock().await;
    reload_held(hooks).await
}
/// Reloads a changed file; the caller holds `mutation`.
async fn reload_held(hooks: &Arc<Hooks>) -> Result<(), String> {
    let previous = hooks.state.read().stamp;
    let path = hooks.path.clone();
    let result = tokio::task::spawn_blocking(move || {
        let current = stamp(&path)?;
        let config = if current == previous {
            None
        } else {
            Some(match current {
                Some(_) => read(&path),
                None => Ok(HookConfig {
                    version: 1,
                    hooks: Vec::new(),
                }),
            })
        };
        Ok::<_, String>((current, config))
    })
    .await
    .map_err(|e| e.to_string())?;
    match result {
        Ok((current, config)) => {
            hooks.state.write().stamp = current;
            if let Some(config) = config {
                match config {
                    Ok(config) => hooks.publish(config),
                    Err(error) => hooks.state.write().settings.error = Some(error),
                }
            }
        }
        Err(error) => hooks.state.write().settings.error = Some(error),
    }
    Ok(())
}
/// Saves a configuration; the caller holds `saving`. New keys sign only if the
/// client is still there to receive them: otherwise they stay undelivered.
pub(super) async fn save(
    hooks: &Arc<Hooks>,
    revision: u64,
    config: HookConfig,
    secrets: BTreeMap<String, SecretText>,
    client_left: impl Fn() -> bool,
) -> Result<HookSaved, String> {
    reload(hooks).await?;
    let published = {
        let state = hooks.state.read();
        if state.settings.revision != revision {
            return Err("revision_conflict".into());
        }
        state.settings.config.clone()
    };
    config.validate()?;
    for (id, secret) in &secrets {
        check_hook_secret(secret.expose())?;
        if !config.hooks.iter().any(|h| h.kind == "http" && &h.id == id) {
            return Err("Hook secrets apply to HTTP hooks in this configuration".into());
        }
    }
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > CAP {
        return Err("Hook file exceeds 256 KiB".into());
    }
    // A store may wait on the user, so `mutation` is not held here: session
    // creation and send keep reloading while it does.
    let staged = hooks.secrets.stage(&config, &published, secrets).await?;
    let settings = commit(hooks, revision, config, bytes).await?;
    if !client_left() {
        hooks.secrets.promote(&staged, &settings.config).await?;
    }
    Ok(HookSaved {
        settings,
        generated_secrets: staged.generated,
    })
}
/// Writes and publishes the configuration unless it changed since `revision`.
async fn commit(
    hooks: &Arc<Hooks>,
    revision: u64,
    config: HookConfig,
    bytes: Vec<u8>,
) -> Result<HookSettings, String> {
    let _guard = hooks.mutation.lock().await;
    reload_held(hooks).await?;
    if hooks.state.read().settings.revision != revision {
        return Err("revision_conflict".into());
    }
    let path = hooks.path.clone();
    let saved = tokio::task::spawn_blocking(move || {
        butler_platform::secure_fs::replace_private(
            &path,
            |file| file.write_all(&bytes).map_err(|e| e.to_string()),
            |e| e.to_string(),
        )?;
        stamp(&path)
    })
    .await
    .map_err(|e| e.to_string())??;
    hooks.state.write().stamp = saved;
    hooks.publish(config);
    Ok(hooks.state.read().settings.clone())
}
