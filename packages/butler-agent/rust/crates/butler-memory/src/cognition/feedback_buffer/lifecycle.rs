//! Generation fences and raw-text-free owner deletion receipts.
use super::{FeedbackBufferService, FeedbackStatus, operator, store};
use crate::cognition::CognitionResult;

impl FeedbackBufferService {
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
                entry.status = FeedbackStatus::Discarded;
                entry.text.clear();
                entry.extra_fields.shift_remove("text_json");
                entry
                    .extra_fields
                    .insert("resolution_reason".into(), "owner_reset".into());
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
            Ok(count)
        })
        .await
    }
}
