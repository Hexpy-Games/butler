//! Authenticated owner controls, independent of chat and durable Instructions.
use super::{FeedbackBufferService, FeedbackEntry, FeedbackStatus, operator, store};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult, mutable_paths};
use serde_json::{Value, json};

impl FeedbackBufferService {
    /// List complete canonical and pending entries, including inactive audit receipts.
    pub async fn list_feedback(&self) -> CognitionResult<Value> {
        let data = self.data_root.clone();
        let root = self.paths.cognition_root(&data).join("feedback");
        tokio::task::spawn_blocking(move || {
            mutable_paths::ensure_data_authority(&data, &[&root, &root.join("pending")])?;
            let entries = store::snapshot(&root)?;
            let canonical = operator::read_entries(&root.join("feedback.md"))?
                .into_iter().map(|entry| entry.feedback_id).collect::<std::collections::HashSet<_>>();
            let now = chrono::Utc::now().timestamp_millis();
            let entries = entries.iter().filter(|entry| entry.category != "session_end")
                .map(|entry| card(entry, !canonical.contains(&entry.feedback_id), now)).collect::<Vec<_>>();
            Ok(json!({"kind":"recent_feedback", "enabled": store::enabled(&root)?, "entries":entries}))
        }).await.map_err(store::failure)?
    }

    /// Replace an active revision; keep a supersession receipt for the previous handle.
    pub async fn edit_feedback(&self, id: String, text: String) -> CognitionResult<Value> {
        if text.trim().is_empty() {
            return Err(invalid());
        }
        self.mutate("feedback_edit", move |path| {
            let root = path.parent().unwrap_or(&path);
            let mut entries = store::snapshot(root)?;
            let old = entries
                .iter_mut()
                .find(|entry| entry.feedback_id == id)
                .ok_or_else(missing)?;
            if !matches!(
                old.status,
                FeedbackStatus::Active | FeedbackStatus::NeedsClarification
            ) {
                return Err(invalid());
            }
            let mut new = old.clone();
            new.feedback_id = format!("fb_{}", uuid::Uuid::new_v4().simple());
            new.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            new.created_at.clone_from(&new.updated_at);
            new.text = text;
            new.supersedes = vec![id];
            new.extra_fields.insert(
                "text_json".into(),
                serde_json::to_string(&new.text).map_err(store::failure)?,
            );
            new.extra_fields.insert(
                "operation_id".into(),
                format!("owner_edit:{}", new.feedback_id),
            );
            old.status = FeedbackStatus::Superseded;
            old.expires_at = None;
            old.extra_fields
                .insert("retention_class".into(), "audit".into());
            old.updated_at.clone_from(&new.updated_at);
            old.extra_fields
                .insert("resolution_reason".into(), "owner_edit".into());
            old.extra_fields
                .insert("destination_link".into(), new.feedback_id.clone());
            let result = card(&new, false, chrono::Utc::now().timestamp_millis());
            entries.push(new);
            operator::write_entries(&path, &entries)?;
            Ok(result)
        })
        .await
    }

    /// Delete the selected feedback text, preserving a metadata-only audit receipt.
    pub async fn delete_feedback(&self, id: String) -> CognitionResult<Value> {
        self.mutate("feedback_delete", move |path| {
            let root = path.parent().unwrap_or(&path);
            let mut entries = store::snapshot(root)?;
            let selected = entries
                .iter()
                .find(|entry| entry.feedback_id == id)
                .ok_or_else(missing)?;
            let mut ids = std::collections::HashSet::from([selected.feedback_id.clone()]);
            loop {
                let size = ids.len();
                let previous = entries
                    .iter()
                    .filter(|entry| ids.contains(&entry.feedback_id))
                    .flat_map(|entry| entry.supersedes.iter().cloned())
                    .collect::<Vec<_>>();
                ids.extend(previous);
                let duplicates = entries
                    .iter()
                    .filter(|entry| {
                        entry
                            .extra_fields
                            .get("resolution_reason")
                            .is_some_and(|reason| reason == "duplicate")
                            && entry
                                .extra_fields
                                .get("destination_link")
                                .is_some_and(|link| ids.contains(link))
                    })
                    .map(|entry| entry.feedback_id.clone())
                    .collect::<Vec<_>>();
                ids.extend(duplicates);
                if size == ids.len() {
                    break;
                }
            }
            for entry in entries
                .iter_mut()
                .filter(|entry| ids.contains(&entry.feedback_id))
            {
                erase(entry, "owner_delete");
            }
            let entry = entries
                .iter()
                .find(|entry| entry.feedback_id == id)
                .ok_or_else(missing)?;
            let result = card(entry, false, chrono::Utc::now().timestamp_millis());
            operator::write_entries(&path, &entries)?;
            remove_pending(root, &ids)?;
            Ok(result)
        })
        .await
    }

    /// Pause application and promotion without changing scopes or extending expiry.
    pub async fn set_feedback_enabled(&self, enabled: bool) -> CognitionResult<Value> {
        self.mutate("feedback_enabled", move |path| {
            store::replace(
                &path.parent().unwrap_or(&path).join("enabled"),
                if enabled { "true" } else { "false" },
            )?;
            Ok(json!({"enabled":enabled}))
        })
        .await
    }
}

pub(super) fn erase(entry: &mut FeedbackEntry, reason: &str) {
    entry.status = FeedbackStatus::Discarded;
    entry.text.clear();
    entry.target_ref = "unknown".into();
    entry.expires_at = None;
    entry.extra_fields.retain(|key, _| {
        matches!(
            key.as_str(),
            "operation_id"
                | "reset_generation"
                | "origin_session"
                | "origin_message"
                | "origin_turn"
                | "destination_link"
        )
    });
    entry
        .extra_fields
        .insert("retention_class".into(), "audit".into());
    entry
        .extra_fields
        .insert("resolution_reason".into(), reason.into());
    entry.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
}

fn card(entry: &FeedbackEntry, pending: bool, now: i64) -> Value {
    let mut value = operator::entry_value(entry);
    if let Some(fields) = value.as_object_mut() {
        let expired = entry.status == FeedbackStatus::Active && !entry.is_active_at(now);
        let state = if expired {
            json!("expired")
        } else if pending && entry.status == FeedbackStatus::Active {
            json!("pending")
        } else {
            fields.get("status").cloned().unwrap_or(Value::Null)
        };
        fields.insert("state".into(), state);
        fields.insert("pending".into(), json!(pending));
        fields.insert(
            "destination_link".into(),
            json!(entry.extra_fields.get("destination_link")),
        );
        fields.insert(
            "resolution_reason".into(),
            json!(entry.extra_fields.get("resolution_reason")),
        );
    }
    value
}

fn missing() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryFeedbackEntryNotFound,
        "Recent feedback unavailable",
    )
}
fn invalid() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryFeedbackStatusInvalid,
        "Recent feedback edit unavailable",
    )
}

fn remove_pending(
    root: &std::path::Path,
    ids: &std::collections::HashSet<String>,
) -> CognitionResult<()> {
    for path in store::pending(root)? {
        if operator::read_entries(&path)?
            .iter()
            .any(|entry| ids.contains(&entry.feedback_id))
        {
            std::fs::remove_file(path).map_err(store::failure)?;
        }
    }
    store::sync_pending(root)
}
