//! Instructions saved on this computer, including changes awaiting a main's decision.
use super::remote_memory::{self, CopiedRule};
use butler_core::configuration::{lock_file_async, read_json_object, write_json_atomic};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{path::Path, sync::LazyLock};

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingInstruction {
    pub id: String,
    pub action: String,
    pub text: Option<String>,
    pub duration: String,
    pub expires_at: Option<String>,
    pub target: Option<PendingTarget>,
    pub session_id: String,
    pub saved_at: String,
    #[serde(default)]
    pub delivered: bool,
    #[serde(default)]
    pub local: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingTarget {
    pub handle: String,
    pub revision: String,
    pub text: String,
}

static ITEMS: LazyLock<Mutex<Option<Vec<PendingInstruction>>>> = LazyLock::new(Mutex::default);

pub async fn load(data: &Path) -> Result<(), String> {
    if ITEMS.lock().is_some() {
        return Ok(());
    }
    let path = data.join("remote/pending-instructions.json");
    tokio::task::spawn_blocking(move || {
        let mut items = ITEMS.lock();
        if items.is_none() {
            let mut file = read_json_object(&path).map_err(|e| e.to_string())?;
            *items = Some(if file.as_object().is_some_and(serde_json::Map::is_empty) {
                Vec::new()
            } else {
                let rows = file
                    .get_mut("items")
                    .ok_or("Missing pending instructions")?
                    .take();
                serde_json::from_value(rows).map_err(|e| e.to_string())?
            });
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn queue(data: &Path, item: PendingInstruction) -> Result<(), String> {
    load(data).await?;
    let path = data.join("remote/pending-instructions.json");
    let guard = lock_file_async(&path).await.map_err(|e| e.to_string())?;
    let local = item.local;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut next = ITEMS.lock().clone().unwrap_or_default();
        next.push(item);
        write_json_atomic(&path, &json!({"version":1,"items":next})).map_err(|e| e.to_string())?;
        *ITEMS.lock() = Some(next);
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    if !local {
        remote_memory::wake_mains("memory.instruction_pending");
    }
    Ok(())
}

pub async fn take(data: &Path) -> Vec<PendingInstruction> {
    if load(data).await.is_err() {
        return Vec::new();
    }
    ITEMS
        .lock()
        .iter()
        .flatten()
        .filter(|item| !item.delivered && !item.local)
        .take(200)
        .cloned()
        .collect()
}

pub async fn ack(data: &Path, ids: &[String]) -> Result<(), String> {
    load(data).await?;
    let path = data.join("remote/pending-instructions.json");
    let guard = lock_file_async(&path).await.map_err(|e| e.to_string())?;
    let ids = ids.to_owned();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut next = ITEMS.lock().clone().unwrap_or_default();
        let mut changed = false;
        for item in &mut next {
            if !item.delivered && ids.contains(&item.id) {
                item.delivered = true;
                changed = true;
            }
        }
        if changed {
            write_json_atomic(&path, &json!({"version":1,"items":next}))
                .map_err(|e| e.to_string())?;
            *ITEMS.lock() = Some(next);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn settle(data: &Path, unresolved: &[String]) -> Result<(), String> {
    load(data).await?;
    let path = data.join("remote/pending-instructions.json");
    let guard = lock_file_async(&path).await.map_err(|e| e.to_string())?;
    let unresolved = unresolved.to_owned();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut next = ITEMS.lock().clone().unwrap_or_default();
        let count = next.len();
        let now = chrono::Utc::now().to_rfc3339();
        next.retain(|item| {
            (!item.delivered || unresolved.contains(&item.id))
                && !(item.local && item.expires_at.as_ref().is_some_and(|at| at <= &now))
        });
        if count != next.len() {
            write_json_atomic(&path, &json!({"version":1,"items":next}))
                .map_err(|e| e.to_string())?;
            *ITEMS.lock() = Some(next);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn overlay(
    rules: Vec<CopiedRule>,
    session_id: &str,
    now: &str,
) -> Vec<(CopiedRule, Option<String>)> {
    let mut rules: Vec<_> = rules.into_iter().map(|rule| (rule, None)).collect();
    let items = ITEMS.lock();
    for item in items.iter().flatten() {
        if (item.local && item.session_id != session_id)
            || item.expires_at.as_deref().is_some_and(|at| at <= now)
        {
            continue;
        }
        let scope = item.local.then(|| item.session_id.clone());
        match (item.action.as_str(), &item.target, &item.text) {
            ("remember", _, Some(text)) => {
                let digest = format!("{:x}", Sha256::digest(item.id.as_bytes()));
                rules.push((
                    CopiedRule {
                        handle: format!("P{digest:.20}"),
                        text: text.clone(),
                        revision: item.id.clone(),
                        expires_at: item.expires_at.clone(),
                    },
                    scope,
                ));
            }
            ("replace", Some(target), Some(text)) => {
                if let Some((rule, session)) = rules
                    .iter_mut()
                    .find(|(rule, _)| rule.handle == target.handle)
                {
                    rule.text.clone_from(text);
                    rule.revision.clone_from(&item.id);
                    *session = scope;
                }
            }
            ("forget", Some(target), _) => rules.retain(|(rule, _)| rule.handle != target.handle),
            _ => {}
        }
    }
    rules
}

pub fn is_overlaid(handle: &str) -> bool {
    ITEMS
        .lock()
        .iter()
        .flatten()
        .any(|item| match item.action.as_str() {
            "remember" => {
                let digest = format!("{:x}", Sha256::digest(item.id.as_bytes()));
                handle == format!("P{digest:.20}")
            }
            "replace" => item
                .target
                .as_ref()
                .is_some_and(|target| target.handle == handle),
            _ => false,
        })
}
