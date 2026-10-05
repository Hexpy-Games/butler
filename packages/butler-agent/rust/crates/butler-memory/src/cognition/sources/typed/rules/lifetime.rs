//! Expiry and explicit chat closure, driven by requests and the existing daily cycle.
use super::*;
use inventory::{read_json, write_json};
use std::path::Path;
pub(super) fn ended(root: &Path, session: Option<&str>) -> CognitionResult<bool> {
    session
        .map(|id| {
            read_json::<String>(&root.join("session-ends").join(sha256(id.as_bytes())))
                .map(|v| v.is_some())
        })
        .unwrap_or(Ok(false))
}
impl RememberedRuleOwner {
    /// Closure persists immediately; canonical retirement runs in the daily cycle.
    pub async fn end_session(&self, session: String) -> CognitionResult<()> {
        let owner = self.clone();
        tokio::task::spawn_blocking(move || {
            if !crate::cognition::active_memory_descriptor_exists(
                &owner.data_root,
                &owner.environment,
            )? {
                return Ok(());
            }
            owner.authority()?;
            let directory = owner.root().join("session-ends");
            ensure_data_authority(&owner.data_root, &[&directory])?;
            butler_platform::secure_fs::create_private_dir_all(&directory)
                .map_err(failure_source)?;
            write_json(
                &directory.join(sha256(session.as_bytes())),
                &owner.publisher.now_iso(),
            )
        })
        .await
        .map_err(failure_source)??;
        self.coordinator.invalidate_inventory();
        Ok(())
    }
    /// Retire expired instructions through the same correct/forget transaction.
    pub async fn expire(&self, cancellation: CancellationToken) -> CognitionResult<usize> {
        self.drain_captures().await?;
        let owner = self.clone();
        let targets = tokio::task::spawn_blocking(move || {
            owner.authority()?;
            let root = owner.root();
            let now = chrono::Utc::now().timestamp_millis();
            let mut result = vec![];
            for row in Inventory::read(&root)?
                .scopes
                .values()
                .flat_map(|rows| rows.values())
            {
                let closed = ended(&root, row.scope_session_id.as_deref())?;
                let expired = row.expires_at.as_deref().is_some_and(|iso| {
                    chrono::DateTime::parse_from_rfc3339(iso)
                        .is_ok_and(|t| t.timestamp_millis() <= now)
                });
                if expired || closed {
                    result.push((
                        RememberedRuleTarget {
                            handle: row.handle.clone(),
                            expected_revision: row.revision.clone(),
                            project_id: row.project_id.clone(),
                        },
                        if closed { "session_end" } else { "expired" },
                    ));
                }
            }
            Ok::<_, CognitionError>(result)
        })
        .await
        .map_err(failure_source)??;
        let count = targets.len();
        for (target, reason) in targets {
            let operation = format!("{reason}:{}:{}", target.handle, target.expected_revision);
            self.forget(target, operation, None, None, cancellation.clone())
                .await?;
        }
        Ok(count)
    }
}
