//! Request-driven reset jobs share the existing consolidation owner.
use super::*;
use crate::cognition;

impl MemoryManagement {
    /// Accepts one conversation reset with an idempotent durable receipt.
    pub async fn begin_conversation_reset(
        &self,
        operation_id: String,
        inventory_revision: u64,
        project_id: Option<String>,
    ) -> io::Result<ResetResult> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        tokio::task::spawn_blocking(move || {
            cognition::begin_conversation_reset(
                &root,
                &paths,
                &coordinator,
                &operation_id,
                inventory_revision,
                project_id.clone(),
                if project_id.is_some() {
                    "project_memory"
                } else {
                    "chat_memory"
                },
            )
        })
        .await
        .map_err(io::Error::other)?
    }
    /// Stages the complete surviving projection and commits a new active generation.
    pub async fn reset_conversations(
        &self,
        operation_id: String,
        cancellation: CancellationToken,
    ) -> io::Result<ResetResult> {
        cognition::reset_conversations(
            self.root.clone(),
            self.paths.clone(),
            self.coordinator.clone(),
            operation_id,
            cancellation,
            self.stop.clone(),
        )
        .await
    }
    /// Reads the durable receipt once for initial/reconnect views.
    pub async fn reset_status(&self, operation_id: String) -> io::Result<Option<ResetResult>> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || {
            let mut receipt = cognition::reset_receipt(&root, &paths, &operation_id)?;
            if let Some(result) = &mut receipt
                && result.kind == "reextract" && result.phase == "preparing"
                && let Ok((total, done)) = cognition::reextract_progress(&root, &paths, &operation_id)
            {
                result.total = Some(total);
                result.done = Some(done);
            }
            Ok(receipt)
        }).await.map_err(io::Error::other)?
    }
}

impl MemoryManagement {
    /// Accepts a profile reset independently of the shared graph's lifecycle.
    pub async fn begin_profile_reset(&self, id: String, revision: u64) -> io::Result<ResetResult> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        tokio::task::spawn_blocking(move || {
            cognition::begin_conversation_reset(
                &root,
                &paths,
                &coordinator,
                &id,
                revision,
                None,
                "profile",
            )
        })
        .await
        .map_err(io::Error::other)?
    }
    /// Publishes the host's profile owner result under the shared writer lease,
    /// waiting for a current holder instead of leaving the reset in progress.
    pub async fn complete_profile_reset(
        &self,
        id: String,
        phase: String,
    ) -> io::Result<ResetResult> {
        let mut result = self
            .reset_status(id)
            .await?
            .ok_or_else(|| io::Error::other("Reset receipt is missing"))?;
        if result.kind != "profile" {
            return Err(io::Error::other("Operation ID conflicts"));
        }
        if result.phase == "complete" {
            return Ok(result);
        }
        if !["complete", "cancelled", "failed"].contains(&phase.as_str()) {
            return Err(io::Error::other("Invalid reset phase"));
        }
        result.phase = phase;
        result.sequence += 1;
        cognition::save_reset_receipt(
            self.root.clone(),
            self.paths.clone(),
            self.coordinator.clone(),
            result.clone(),
            self.stop.clone(),
        )
        .await?;
        Ok(result)
    }
}

impl MemoryManagement {
    /// Reads durable operation intents once at service start; no polling or idle work.
    pub async fn pending_resets(&self) -> io::Result<Vec<ResetResult>> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || {
            let directory = paths.memory_root(&root).join("management/resets");
            crate::coordination::ensure_data_authority(&root, &[&directory])?;
            let entries = match std::fs::read_dir(directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(error),
            };
            let mut pending = Vec::new();
            for entry in entries {
                let entry = entry?;
                let id = entry.file_name().to_string_lossy().into_owned();
                if !uuid::Uuid::parse_str(&id).is_ok_and(|value| value.to_string() == id) {
                    continue;
                }
                if let Some(receipt) = cognition::reset_receipt(&root, &paths, &id)?
                    && (receipt.phase == "preparing" || receipt.removal_pending)
                {
                    pending.push(receipt);
                }
            }
            pending.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
            Ok(pending)
        })
        .await
        .map_err(io::Error::other)?
    }
}

impl MemoryManagement {
    /// Forgets the exact captured project instructions through their owner, then swaps its projection.
    pub async fn reset_project(
        &self,
        id: String,
        instructions: Arc<crate::cognition::RememberedRuleOwner>,
        token: CancellationToken,
    ) -> io::Result<ResetResult> {
        let receipt = self
            .reset_status(id.clone())
            .await?
            .ok_or_else(|| io::Error::other("Reset receipt is missing"))?;
        if receipt.kind != "project_memory" {
            return Err(io::Error::other("Operation ID conflicts"));
        }
        if receipt.phase != "complete" {
            for target in &receipt.instructions {
                // Stable operation/handle pairs replay the instruction owner's durable journal.
                instructions
                    .forget(
                        target.clone(),
                        format!("{}:{}", id, target.handle),
                        None,
                        None,
                        token.clone(),
                    )
                    .await
                    .map_err(io::Error::other)?;
            }
        }
        self.reset_conversations(id, token).await
    }
}

impl MemoryManagement {
    /// Accepts one rules upgrade unless this active generation already failed it.
    pub async fn begin_reextract_if_due(&self) -> io::Result<Option<ResetResult>> {
        let root = self.root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        tokio::task::spawn_blocking(move || {
            if !cognition::active_memory_descriptor_exists(&root, &paths).map_err(io::Error::other)? {
                return Ok(None);
            }
            let active = cognition::resolve_active_generation(&root, &paths).map_err(io::Error::other)?;
            let manifest = cognition::GenerationManifest::read(
                &active.root.join("manifest.json"), cognition::CognitionCode::MemoryGenerationUnavailable,
            ).map_err(io::Error::other)?;
            if manifest.extraction_rules_version() >= cognition::MEMORY_EXTRACTION_RULES_VERSION {
                return Ok(None);
            }
            let directory = paths.memory_root(&root).join("management/resets");
            crate::coordination::ensure_data_authority(&root, &[&directory])?;
            match std::fs::read_dir(directory) {
                Ok(entries) => {
                    for entry in entries {
                        let id = entry?.file_name().to_string_lossy().into_owned();
                        if !uuid::Uuid::parse_str(&id).is_ok_and(|value| value.to_string() == id) {
                            continue;
                        }
                        if cognition::reset_receipt(&root, &paths, &id)?.is_some_and(|receipt| {
                            receipt.kind == "reextract" && receipt.phase == "failed" && receipt.old_generation == active.generation_id
                        }) {
                            return Ok(None);
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            cognition::begin_conversation_reset(
                &root, &paths, &coordinator, &uuid::Uuid::new_v4().to_string(),
                coordinator.inventory_revision(), None, "reextract",
            ).map(Some)
        }).await.map_err(io::Error::other)?
    }

    /// Drives or resumes the staged generation through the supplied shadow consumer.
    pub async fn reextract(
        &self,
        id: String,
        shadow: &cognition::MemorySyncConsumer,
        now: Arc<dyn Fn() -> String + Send + Sync>,
        token: CancellationToken,
    ) -> io::Result<cognition::ReextractOutcome> {
        cognition::reextract_conversations(
            (self.root.clone(), self.paths.clone()), self.coordinator.clone(), id,
            shadow, now, token, self.stop.clone(),
        ).await
    }
}
