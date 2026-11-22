//! Instructions pulled from registered computers for an explicit decision on the main.
use super::{Computer, HttpError, live_pump::Pump, live_records::Record, relay};
use butler_core::configuration::{lock_file_async, read_json_object, write_json_atomic};
use butler_turn::remote_instructions::PendingInstruction;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    path::Path,
    sync::{Arc, LazyLock},
};
use tokio_util::sync::CancellationToken;

pub(super) static PULLS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Mutex::default);

pub(super) async fn pull(
    computer: &Computer,
    root: &Path,
    cancel: CancellationToken,
) -> Result<(), HttpError> {
    let lock = PULLS.lock().entry(computer.id.clone()).or_default().clone();
    let _pull = lock.lock().await;
    loop {
        let reply = relay::request(
            computer,
            "POST",
            "/remote/memory/pending",
            b"{}".to_vec(),
            cancel.clone(),
        )
        .await?;
        if reply.status != 200 {
            return Err(relay::unavailable());
        }
        let mut body = reply.body;
        let items = body["items"].as_array_mut().ok_or(HttpError::Internal)?;
        let count = items.len();
        if count == 0 {
            return Ok(());
        }
        let ids = merge(root, computer.id.clone(), std::mem::take(items)).await?;
        if !ids.is_empty() {
            let reply = relay::request(
                computer,
                "POST",
                "/remote/memory/pending/ack",
                json!({"ids":ids}).to_string().into_bytes(),
                cancel.clone(),
            )
            .await?;
            if reply.status != 204 {
                return Err(relay::unavailable());
            }
        }
        if count != 200 || ids.len() < count {
            return Ok(());
        }
    }
}

async fn merge(
    root: &Path,
    computer_id: String,
    batch: Vec<Value>,
) -> Result<Vec<String>, HttpError> {
    let path = root.join("config/computers/pending-instructions.json");
    let guard = lock_file_async(&path)
        .await
        .map_err(|_| HttpError::Internal)?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut file = read_json_object(&path).map_err(|_| HttpError::Internal)?;
        if file.as_object().is_some_and(serde_json::Map::is_empty) {
            file = json!({"version":1,"items":[],"decided":[]});
        }
        let decided = file["decided"].as_array().ok_or(HttpError::Internal)?;
        let mut known: std::collections::HashSet<String> = decided
            .iter()
            .filter_map(|row| row["id"].as_str().map(str::to_owned))
            .collect();
        let items = file["items"].as_array_mut().ok_or(HttpError::Internal)?;
        known.extend(
            items
                .iter()
                .filter_map(|row| row["id"].as_str().map(str::to_owned)),
        );
        let mut count = items
            .iter()
            .filter(|row| row["computer_id"] == computer_id)
            .count();
        let before = items.len();
        let received_at = chrono::Utc::now().to_rfc3339();
        let mut ids = Vec::new();
        let mut invalid = 0;
        for raw in batch {
            let item = serde_json::from_value::<PendingInstruction>(raw.clone())
                .ok()
                .filter(valid);
            let Some(item) = item else {
                invalid += 1;
                if let Some(id) = raw["id"].as_str() {
                    ids.push(id.to_owned());
                }
                continue;
            };
            if !known.contains(&item.id) {
                if count >= 200 {
                    continue;
                }
                known.insert(item.id.clone());
                items.push(json!({
                    "id":item.id,"action":item.action,"text":item.text,"duration":item.duration,
                    "expires_at":item.expires_at,"target":item.target,"session_id":item.session_id,
                    "saved_at":item.saved_at,"computer_id":computer_id,"received_at":received_at
                }));
                count += 1;
            }
            ids.push(item.id);
        }
        if invalid > 0 {
            butler_core::diagnostic!(
                "[remote-instructions] invalid items={invalid} computer={computer_id}"
            );
        }
        if items.len() != before {
            write_json_atomic(&path, &file).map_err(|_| HttpError::Internal)?;
        }
        Ok(ids)
    })
    .await
    .map_err(|_| HttpError::Internal)?
}

fn valid(item: &PendingInstruction) -> bool {
    let text_ok = item
        .text
        .as_ref()
        .is_some_and(|s| !s.trim().is_empty() && s.len() <= 8192);
    !item.local
        && uuid::Uuid::parse_str(&item.id).is_ok()
        && matches!(item.duration.as_str(), "always" | "7 days" | "this chat")
        && item.saved_at.len() <= 64
        && item.session_id.len() <= 200
        && item.target.as_ref().is_none_or(|t| {
            !t.handle.is_empty()
                && t.handle.len() <= 80
                && t.handle.bytes().all(|b| b.is_ascii_alphanumeric())
                && !t.revision.is_empty()
                && t.revision.len() <= 200
                && t.text.len() <= 8192
        })
        && match item.action.as_str() {
            "remember" => text_ok,
            "replace" => text_ok && item.target.is_some(),
            "forget" => item.target.is_some(),
            _ => false,
        }
}

pub(super) fn pull_from_pump(pump: &Pump) {
    let link = pump.link.clone();
    let id = pump.computer.clone();
    tokio::spawn(async move {
        let result = async {
            let computer = super::list(&link.root)
                .await?
                .into_iter()
                .find(|c| c.id == id)
                .ok_or(HttpError::Internal)?;
            pull(&computer, &link.root, link.cancel).await
        }
        .await;
        if result.is_err() {
            butler_core::diagnostic!("[remote-instructions] pull failed computer={id}");
        }
    });
}

pub(super) fn woken(record: &Record) -> bool {
    record.id.is_none()
        && serde_json::from_str::<Value>(&record.data)
            .is_ok_and(|value| value["type"] == "memory.instruction_pending")
}

pub(in crate::gateway) async fn list(root: &Path) -> Vec<Value> {
    let path = root.join("config/computers/pending-instructions.json");
    let read = tokio::task::spawn_blocking(move || {
        let mut file = read_json_object(&path).map_err(|_| HttpError::Internal)?;
        if file.as_object().is_some_and(serde_json::Map::is_empty) {
            return Ok(Vec::new());
        }
        file["items"]
            .as_array_mut()
            .map(std::mem::take)
            .ok_or(HttpError::Internal)
    })
    .await;
    if let Ok(Ok(items)) = read {
        return items;
    }
    butler_core::diagnostic!("[remote-instructions] could not read pending instructions");
    Vec::new()
}

pub(in crate::gateway) async fn get(root: &Path, id: &str) -> Option<Value> {
    list(root).await.into_iter().find(|item| item["id"] == id)
}

pub(super) async fn ids_for(root: &Path, computer_id: &str) -> Vec<String> {
    list(root)
        .await
        .into_iter()
        .filter(|item| item["computer_id"] == computer_id)
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect()
}

pub(in crate::gateway) async fn decide<T, F: Future<Output = Result<T, HttpError>>>(
    root: &Path,
    id: &str,
    decision: impl FnOnce(Value) -> F,
) -> Result<T, HttpError> {
    let path = root.join("config/computers/pending-instructions.json");
    let guard = lock_file_async(&path)
        .await
        .map_err(|_| HttpError::Internal)?;
    let read = path.clone();
    let mut file = tokio::task::spawn_blocking(move || read_json_object(&read))
        .await
        .map_err(|_| HttpError::Internal)?
        .map_err(|_| HttpError::Internal)?;
    let items = file["items"].as_array_mut().ok_or(HttpError::Internal)?;
    let index = items
        .iter()
        .position(|item| item["id"] == id)
        .ok_or_else(|| {
            HttpError::public(
                404,
                "pending_instruction_not_found",
                "Pending instruction not found.",
            )
        })?;
    let item = items.remove(index);
    let decided = file["decided"].as_array_mut().ok_or(HttpError::Internal)?;
    let computer = item["computer_id"].clone();
    let result = decision(item).await?;
    decided.push(json!({"computer_id":computer,"id":id,"at":chrono::Utc::now().to_rfc3339()}));
    let excess = decided.len().saturating_sub(1000);
    decided.drain(..excess);
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        write_json_atomic(&path, &file)
    })
    .await
    .map_err(|_| HttpError::Internal)?
    .map_err(|_| HttpError::Internal)?;
    Ok(result)
}
