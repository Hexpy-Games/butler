//! Typed, runtime-bound feedback ingress, independent of embedding work.
use super::{
    FeedbackBufferService, FeedbackEntry, FeedbackPriority, FeedbackPrivacyClass, FeedbackStatus,
    operator, resolve::format_entry, store,
};
use crate::cognition::{CognitionResult, mutable_paths};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

/// Identity and scope are supplied by the host, never arbitrary model paths.
#[derive(Clone, Debug)]
pub struct FeedbackCapture {
    /// Stable runtime tool operation identity.
    pub operation_id: String,
    /// Faithful compact correction.
    pub text: String,
    /// Already bound: global, project:<id>, or session:<id>.
    pub scope: String,
    /// Correction or quality category.
    pub category: String,
    /// Relevance target, independent of ownership.
    pub target_ref: String,
    /// ephemeral, working, session_only or pinned.
    pub retention_class: String,
    /// Canonical authored conversation.
    pub session_id: String,
    /// Canonical user message.
    pub message_id: String,
    /// Runtime turn provenance.
    pub turn_id: String,
    /// Ambiguous feedback stays inactive.
    pub needs_clarification: bool,
    /// Existing identical Instructions handle, verified by the host.
    pub represented_by: Option<String>,
}

impl FeedbackBufferService {
    /// Persist before acknowledging. No consolidation lease is acquired here.
    pub async fn capture(&self, input: FeedbackCapture) -> CognitionResult<Value> {
        let root = self.paths.cognition_root(&self.data_root).join("feedback");
        let data = self.data_root.clone();
        let work_root = root.clone();
        let result = tokio::task::spawn_blocking(move || {
            mutable_paths::ensure_data_authority(&data, &[&root, &root.join("pending")])?;
            capture(&root, input)
        })
        .await
        .map_err(store::failure)??;
        store::signal(&work_root);
        Ok(result)
    }

    /// Event-driven drain, with no idle filesystem probe.
    pub(crate) async fn drain_signalled(&self) -> CognitionResult<usize> {
        let root = self.paths.cognition_root(&self.data_root).join("feedback");
        if !store::take_work(&root) {
            return Ok(0);
        }
        let result = self.drain_pending().await;
        if result.is_err() {
            store::retry(&root);
        }
        result
    }
    /// Drain only when there is work; an empty folder never takes a lease.
    pub async fn drain_pending(&self) -> CognitionResult<usize> {
        let root = self.paths.cognition_root(&self.data_root).join("feedback");
        let data = self.data_root.clone();
        let found = tokio::task::spawn_blocking(move || {
            mutable_paths::ensure_data_authority(&data, &[&root])?;
            store::pending(&root).map(|paths| !paths.is_empty())
        })
        .await
        .map_err(store::failure)??;
        if !found {
            return Ok(0);
        }
        self.mutate("feedback_drain", |path| {
            store::drain(path.parent().unwrap_or(&path))
        })
        .await
    }
}

fn capture(root: &std::path::Path, input: FeedbackCapture) -> CognitionResult<Value> {
    if input.target_ref.contains(['\n', '\r']) || input.scope.contains(['\n', '\r']) {
        return Err(store::failure(std::io::Error::other(
            "Invalid feedback field",
        )));
    }
    let id = format!("fb_{:x}", Sha256::digest(input.operation_id.as_bytes()));
    let generation = store::generation(root)?;
    let entries = store::snapshot(root)?;
    if let Some(entry) = entries.iter().find(|entry| entry.feedback_id == id) {
        return Ok(receipt(entry, true));
    }
    let mut entry = build_entry(generation, id, input)?;
    entry.extra_fields.insert(
        "text_json".into(),
        serde_json::to_string(&entry.text).map_err(store::failure)?,
    );
    link_duplicate(&mut entry, &entries);
    store::replace(
        &root
            .join("pending")
            .join(format!("{}.md", entry.feedback_id)),
        &format_entry(&entry),
    )?;
    Ok(receipt(&entry, false))
}

fn build_entry(
    generation: String,
    id: String,
    input: FeedbackCapture,
) -> CognitionResult<FeedbackEntry> {
    let now = chrono::Utc::now();
    let expires = match input.retention_class.as_str() {
        "ephemeral" => Some(now + chrono::Duration::days(7)),
        "working" => Some(now + chrono::Duration::days(90)),
        "session_only" => Some(now + chrono::Duration::hours(24)),
        "pinned" => None,
        _ => {
            return Err(store::failure(std::io::Error::other(
                "Invalid retention class",
            )));
        }
    };
    let iso = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut entry = FeedbackEntry {
        feedback_id: id,
        status: if input.needs_clarification {
            FeedbackStatus::NeedsClarification
        } else {
            FeedbackStatus::Active
        },
        created_at: iso.clone(),
        updated_at: iso.clone(),
        priority: FeedbackPriority::High,
        scope: input.scope,
        category: input.category,
        target_ref: input.target_ref,
        promotion_target: "review".into(),
        review_after: iso,
        expires_at: expires.map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        supersedes: vec![],
        conflicts_with: vec![],
        privacy_class: FeedbackPrivacyClass::Private,
        text: input.text,
        extra_fields: Default::default(),
    };
    for (key, value) in [
        ("operation_id", input.operation_id),
        ("retention_class", input.retention_class),
        ("origin_session", input.session_id),
        ("origin_message", input.message_id),
        ("origin_turn", input.turn_id),
        ("reset_generation", generation),
    ] {
        entry.extra_fields.insert(key.into(), value);
    }
    if let Some(handle) = input.represented_by {
        entry.status = FeedbackStatus::Discarded;
        entry
            .extra_fields
            .insert("resolution_reason".into(), "already_represented".into());
        entry.extra_fields.insert("destination_link".into(), handle);
    }
    Ok(entry)
}

fn link_duplicate(entry: &mut FeedbackEntry, entries: &[FeedbackEntry]) {
    if entry.status != FeedbackStatus::Active {
        return;
    }
    if let Some(existing) = entries.iter().find(|e| {
        e.status == FeedbackStatus::Active && e.scope == entry.scope && e.text == entry.text
    }) {
        entry.status = FeedbackStatus::Discarded;
        entry
            .extra_fields
            .insert("resolution_reason".into(), "duplicate".into());
        entry
            .extra_fields
            .insert("destination_link".into(), existing.feedback_id.clone());
        return;
    }
    let conflicts = entries
        .iter()
        .filter(|e| {
            e.status == FeedbackStatus::Active
                && e.scope == entry.scope
                && e.target_ref == entry.target_ref
                && e.category == entry.category
        })
        .map(|e| e.feedback_id.clone())
        .collect::<HashSet<_>>();
    entry.conflicts_with = conflicts.into_iter().collect();
    entry.conflicts_with.sort();
}

fn receipt(entry: &FeedbackEntry, replayed: bool) -> Value {
    serde_json::json!({"ok":true,"feedback":entry.feedback_id,"state":"pending","replayed":replayed,"entry":operator::entry_value(entry)})
}
