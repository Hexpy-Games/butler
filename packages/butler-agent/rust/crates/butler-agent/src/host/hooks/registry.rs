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
pub(super) async fn save(
    hooks: &Arc<Hooks>,
    revision: u64,
    config: HookConfig,
) -> Result<HookSettings, String> {
    reload(hooks).await?;
    let _guard = hooks.mutation.lock().await;
    if hooks.state.read().settings.revision != revision {
        return Err("revision_conflict".into());
    }
    config.validate()?;
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > CAP {
        return Err("Hook file exceeds 256 KiB".into());
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
