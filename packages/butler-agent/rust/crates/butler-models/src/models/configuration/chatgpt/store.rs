//! Protected host identity and account registration; reads never create files.
use super::{ChatGptAccountState, ChatGptAccountStatus as Status, Error};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Paths {
    pub host: PathBuf,
    pub registration: PathBuf,
    pub legacy: PathBuf,
}

pub fn paths(data: &Path, override_dir: Option<&Path>) -> Paths {
    let dir = data.join(override_dir.unwrap_or_else(|| Path::new("auth")));
    Paths {
        host: dir.join("chatgpt-host.json"),
        registration: dir.join("chatgpt.json"),
        legacy: data.join("auth/openai-codex.json"),
    }
}

pub async fn read(path: &Path) -> Result<Value, Error> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || read_sync(&path))
        .await
        .map_err(|_| "oauth_profile_write_failed")?
}

pub fn read_sync(path: &Path) -> Result<Value, Error> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(Value::is_object)
            .ok_or("chatgpt_store_unreadable"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(_) => Err("chatgpt_store_unreadable"),
    }
}

pub async fn update<F>(paths: &Paths, path: PathBuf, change: F) -> Result<Value, Error>
where
    F: FnOnce(&mut Value) -> Result<(), Error> + Send + 'static,
{
    let registration = paths.registration.clone();
    // A cancelled caller cannot release the lock before an atomic write finishes.
    tokio::spawn(async move {
        let _lock = tokio::task::spawn_blocking(move || {
            butler_core::configuration::lock_file(&registration)
        })
        .await
        .map_err(|_| "oauth_profile_write_failed")?
        .map_err(|_| "oauth_profile_write_failed")?;
        let mut raw = read(&path).await?;
        change(&mut raw)?;
        let bytes = serde_json::to_vec_pretty(&raw).map_err(|_| "oauth_profile_write_failed")?;
        super::super::auth::io::write_mode_600(&path, &bytes)
            .await
            .map_err(|_| "oauth_profile_write_failed")?;
        Ok(raw)
    })
    .await
    .map_err(|_| "oauth_profile_write_failed")?
}

pub async fn ensure_host(paths: &Paths) -> Result<Value, Error> {
    let paths = paths.clone();
    tokio::spawn(async move {
        let lock_path = paths.registration.clone();
        let _lock = tokio::task::spawn_blocking(move || butler_core::configuration::lock_file(&lock_path))
            .await.map_err(|_| "chatgpt_host_unreadable")?.map_err(|_| "chatgpt_host_unreadable")?;
        match tokio::fs::read(&paths.host).await {
            Ok(bytes) => {
                let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "chatgpt_host_unreadable")?;
                validate_host(&raw)?;
                Ok(raw)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let raw = json!({"schema_version":1, "ext_agent_host_id":format!("urn:uuid:{}", uuid::Uuid::new_v4()),
                    "created_at":chrono::Utc::now().to_rfc3339(), "legacy_prompt_acknowledged_at":null});
                let bytes = serde_json::to_vec_pretty(&raw).map_err(|_| "chatgpt_host_unreadable")?;
                super::super::auth::io::write_mode_600(&paths.host, &bytes).await.map_err(|_| "chatgpt_host_unreadable")?;
                Ok(raw)
            }
            Err(_) => Err("chatgpt_host_unreadable"),
        }
    }).await.map_err(|_| "chatgpt_host_unreadable")?
}

fn validate_host(raw: &Value) -> Result<(), Error> {
    let id = raw["ext_agent_host_id"]
        .as_str()
        .and_then(|s| s.strip_prefix("urn:uuid:"))
        .and_then(|s| uuid::Uuid::parse_str(s).ok());
    if raw["schema_version"] != 1 || id.is_none_or(|id| id.get_version_num() != 4) {
        return Err("chatgpt_host_unreadable");
    }
    Ok(())
}

pub async fn account(paths: &Paths) -> Result<ChatGptAccountState, Error> {
    let registration = read(&paths.registration).await?;
    let host = match tokio::fs::read(&paths.host).await {
        Ok(bytes) => {
            let host = serde_json::from_slice(&bytes).map_err(|_| "chatgpt_host_unreadable")?;
            validate_host(&host)?;
            host
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(_) => return Err("chatgpt_host_unreadable"),
    };
    let legacy_path = paths.legacy.clone();
    let legacy = tokio::task::spawn_blocking(move || {
        std::fs::metadata(legacy_path).is_ok_and(|m| m.len() > 0)
    })
    .await
    .map_err(|_| "chatgpt_store_unreadable")?;
    Ok(account_view(&registration, &host, legacy))
}

pub fn account_view(registration: &Value, host: &Value, legacy: bool) -> ChatGptAccountState {
    let registered = registration["client_id"]
        .as_str()
        .is_some_and(|s| !s.is_empty());
    let signed = super::signed_in(registration);
    let plan = super::plan_enabled(registration);
    let status = if signed {
        if plan {
            Status::SignedIn
        } else {
            Status::PlanOff
        }
    } else if registered {
        Status::SignInRequired
    } else if legacy {
        Status::LegacySignInRequired
    } else {
        Status::SignedOut
    };
    ChatGptAccountState {
        status,
        label: registered.then(|| super::label(registration)),
        plan_notice_pending: signed
            && plan
            && registration["plan_notice_acknowledged_at"].is_null(),
        legacy_prompt_pending: status == Status::LegacySignInRequired
            && host["legacy_prompt_acknowledged_at"].is_null(),
    }
}

pub async fn remove_legacy(paths: &Paths) -> Result<(), Error> {
    match tokio::fs::remove_file(&paths.legacy).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("legacy_auth_delete_failed"),
    }
}

pub async fn delete_legacy(paths: &Paths) {
    match tokio::fs::remove_file(&paths.legacy).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => butler_core::diagnostic!("[chatgpt] code=legacy_auth_delete_failed"),
    }
}
