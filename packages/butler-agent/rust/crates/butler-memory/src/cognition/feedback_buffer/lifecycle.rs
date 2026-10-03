//! Generation fences and raw-text-free owner deletion receipts.
use super::{FeedbackBufferService, FeedbackStatus, operator, store};
use crate::cognition::CognitionResult;

impl FeedbackBufferService {
    /// Explicit chat closure records a durable receipt without waiting for the lease.
    pub async fn end_feedback_session(&self, session_id: String) -> CognitionResult<()> {
        self.capture(super::FeedbackCapture {
            operation_id: format!("feedback_session_end:{session_id}:{}", uuid::Uuid::new_v4()),
            text: String::new(),
            scope: format!("session:{session_id}"),
            category: "session_end".into(),
            target_ref: "session".into(),
            retention_class: "pinned".into(),
            session_id,
            message_id: String::new(),
            turn_id: String::new(),
            needs_clarification: false,
            represented_by: None,
            instruction_target: None,
        })
        .await
        .map(|_| ())
    }

    /// Clear this kind only. Old pending receipts are fenced even across crashes.
    pub async fn reset_feedback(&self) -> CognitionResult<usize> {
        self.mutate("feedback_reset", |path| {
            let root = path.parent().unwrap_or(&path);
            let mut entries = store::snapshot(root)?;
            let generation = uuid::Uuid::new_v4().to_string();
            store::replace(&root.join("generation"), &generation)?;
            let count = entries
                .iter()
                .filter(|entry| {
                    matches!(
                        entry.status,
                        FeedbackStatus::Active | FeedbackStatus::NeedsClarification
                    )
                })
                .count();
            for entry in &mut entries {
                super::owner::erase(entry, "owner_reset");
            }
            operator::write_entries(&path, &entries)?;
            for file in store::pending(root)? {
                if operator::read_entries(&file)?
                    .iter()
                    .all(|entry| entry.extra_fields.get("reset_generation") != Some(&generation))
                {
                    std::fs::remove_file(file).map_err(store::failure)?;
                }
            }
            store::sync_pending(root)?;
            Ok(count)
        })
        .await
    }
}
